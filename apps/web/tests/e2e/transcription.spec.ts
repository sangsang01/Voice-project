import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

type E2eMode = "normal" | "permission-denied" | "worker-crash";

async function installBrowserFakes(page: Page, mode: E2eMode = "normal") {
  await page.addInitScript((selectedMode) => {
    type Listener = (event: MessageEvent<unknown>) => void;

    const state = {
      mode: selectedMode,
      prepareCount: Number(localStorage.getItem("fake-local-model-prepares") ?? "0"),
      cacheHits: 0,
    };
    Object.defineProperty(window, "__transcriptionE2e", { configurable: true, value: state });

    class FakeNode {
      public connect() { return this; }
      public disconnect() { /* Browser cleanup is intentionally harmless in the fake graph. */ }
    }

    class FakeAudioWorkletNode extends FakeNode {
      public port: { onmessage: Listener | null } = { onmessage: null };
      public constructor() { super(); }
    }

    class FakeAudioContext {
      public audioWorklet = { addModule: async () => undefined };
      public destination = new FakeNode();
      public async resume() { /* no-op */ }
      public async close() { /* no-op */ }
      public createMediaStreamSource() { return new FakeNode(); }
    }

    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: FakeAudioWorkletNode });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (selectedMode === "permission-denied") {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          return { getTracks: () => [{ stop() { /* no-op */ } }] };
        },
      },
    });

    class FakeWorker {
      public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      public onerror: ((event: ErrorEvent) => void) | null = null;
      private eventSequence = 0;

      public constructor() { /* no-op */ }

      public postMessage(message: { type: string; requestId?: number; request?: { sessionId: string }; sessionId?: string }) {
        if (message.type === "prepare") {
          if (state.prepareCount > 0) state.cacheHits += 1;
          state.prepareCount += 1;
          localStorage.setItem("fake-local-model-prepares", String(state.prepareCount));
          queueMicrotask(() => this.onmessage?.({ data: { type: "prepared", requestId: message.requestId } } as MessageEvent));
          return;
        }
        if (message.type === "open" && message.request) {
          const sessionId = message.request.sessionId;
          queueMicrotask(() => {
            this.emit({ type: "state", sessionId, state: "listening" });
            this.emit({ type: "segment.upsert", sessionId, segment: { id: "fake-provisional", ordinal: 0, revision: 0, startMs: 0, endMs: 100, text: "synthetic provisional", language: { tag: "und" }, isFinal: false } });
          });
          if (selectedMode === "worker-crash") {
            queueMicrotask(() => this.onerror?.(new Event("error") as ErrorEvent));
          }
          return;
        }
        if (message.type === "stop" && message.sessionId) {
          const sessionId = message.sessionId;
          queueMicrotask(() => {
            this.emit({ type: "segment.upsert", sessionId, segment: { id: "fake-final", ordinal: 0, revision: 1, startMs: 0, endMs: 250, text: "synthetic final", language: { tag: "und" }, isFinal: true } });
            this.emit({ type: "state", sessionId, state: "stopped" });
          });
        }
      }

      public terminate() { /* no-op */ }

      private emit(event: Record<string, unknown>) {
        this.eventSequence += 1;
        this.onmessage?.({ data: { type: "event", event: { ...event, sequence: this.eventSequence } } } as MessageEvent);
      }
    }

    Object.defineProperty(window, "Worker", { configurable: true, value: FakeWorker });
  }, mode);
}

async function installRealBridgeMicrophoneSeam(page: Page) {
  await page.addInitScript(() => {
    type Listener = (event: MessageEvent<unknown>) => void;

    class FakeNode {
      public connect() { return this; }
      public disconnect() { /* Browser cleanup is intentionally harmless in the fake graph. */ }
    }

    const state: {
      port?: { onmessage: Listener | null };
      sequence: number;
    } = { sequence: 0 };

    class FakeAudioWorkletNode extends FakeNode {
      public port: { onmessage: Listener | null } = { onmessage: null };
      public constructor() {
        super();
        state.port = this.port;
      }
    }

    class FakeAudioContext {
      public audioWorklet = { addModule: async () => undefined };
      public destination = new FakeNode();
      public async resume() { /* no-op */ }
      public async close() { /* no-op */ }
      public createMediaStreamSource() { return new FakeNode(); }
    }

    const fourCc = (view: DataView, offset: number) => String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

    const readFixture = (base64: string) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
      const view = new DataView(bytes);
      if (view.byteLength < 12 || fourCc(view, 0) !== "RIFF" || fourCc(view, 8) !== "WAVE") {
        throw new Error("Fixture is not a WAV file");
      }

      let channels = 0;
      let sampleRate = 0;
      let bitsPerSample = 0;
      let format = 0;
      let dataOffset = -1;
      let dataLength = 0;
      for (let offset = 12; offset + 8 <= view.byteLength;) {
        const chunk = fourCc(view, offset);
        const length = view.getUint32(offset + 4, true);
        const payload = offset + 8;
        if (payload + length > view.byteLength) throw new Error("Fixture WAV chunk exceeds file bounds");
        if (chunk === "fmt ") {
          if (length < 16) throw new Error("Fixture WAV format chunk is truncated");
          format = view.getUint16(payload, true);
          channels = view.getUint16(payload + 2, true);
          sampleRate = view.getUint32(payload + 4, true);
          bitsPerSample = view.getUint16(payload + 14, true);
        } else if (chunk === "data") {
          dataOffset = payload;
          dataLength = length;
          break;
        }
        offset = payload + length + (length % 2);
      }
      if (format !== 1 || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16 || dataOffset < 0 || dataLength % 2 !== 0) {
        throw new Error("Fixture must be 16 kHz mono PCM s16le");
      }
      const samples = new Int16Array(dataLength / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(dataOffset + index * 2, true);
      }
      return samples;
    };

    const emitFrame = (samples: Int16Array) => {
      if (!state.port?.onmessage) throw new Error("AudioWorklet microphone seam is not ready");
      const copy = samples.slice();
      const sequence = state.sequence++;
      state.port.onmessage({
        data: {
          type: "pcm-frame",
          sequence,
          startMs: sequence * 20,
          samples: copy.buffer,
        },
      } as MessageEvent);
    };

    Object.defineProperty(window, "__realBridgeE2e", {
      configurable: true,
      value: {
        async pushFixture(base64: string) {
          const deadline = performance.now() + 10_000;
          while (!state.port?.onmessage && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const samples = readFixture(base64);
          // The opening 3.5s contains "And so, my fellow Americans". Keeping
          // this recognizable excerpt bounds real WASM inference time while
          // the repository still carries the complete upstream fixture.
          const excerpt = samples.subarray(0, 16_000 * 3.5);
          for (let offset = 0; offset < excerpt.length; offset += 320) {
            const frame = new Int16Array(320);
            frame.set(excerpt.subarray(offset, offset + 320));
            emitFrame(frame);
          }
          // One second exceeds Silero's 500ms trailing-silence flush threshold.
          for (let index = 0; index < 50; index += 1) emitFrame(new Int16Array(320));
        },
      },
    });

    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: FakeAudioWorkletNode });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { /* no-op */ } }] }) },
    });
  });
}

async function installLiveWebSocketFake(page: Page) {
  await page.addInitScript(() => {
    class FakeWebSocket {
      public static readonly CONNECTING = 0;
      public static readonly OPEN = 1;
      public static readonly CLOSING = 2;
      public static readonly CLOSED = 3;
      public readyState = FakeWebSocket.CONNECTING;
      public bufferedAmount = 0;
      public binaryType: BinaryType = "blob";
      public protocol = "";
      public readonly url: string;
      public readonly protocols: string[];
      private readonly listeners = new Map<string, Set<(event: Event) => void>>();
      private eventSequence = 0;
      private sessionId = "";
      private readonly segmentId = "live-caption";

      public constructor(url: string, protocols: string | string[] = []) {
        this.url = url;
        this.protocols = typeof protocols === "string" ? [protocols] : [...protocols];
        const recorded = (window as Window & { __liveWsProtocols?: string[] }).__liveWsProtocols ?? [];
        (window as Window & { __liveWsProtocols: string[] }).__liveWsProtocols = [...recorded, ...this.protocols];
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.protocol = this.protocols.includes("voice-transcription.v1") ? "voice-transcription.v1" : "";
          this.emit("open", new Event("open"));
        });
      }

      public addEventListener(type: string, listener: (event: Event) => void) {
        const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
        set.add(listener);
        this.listeners.set(type, set);
      }

      public removeEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      public send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data !== "string") {
          const buffer = arrayBufferOf(data);
          if (!buffer || !this.sessionId) return;
          const sequence = new DataView(buffer).getUint32(4, true);
          queueMicrotask(() => {
            this.emitMessage({ type: "audio.ack", sessionId: this.sessionId, throughSequence: sequence });
          });
          return;
        }

        const message = JSON.parse(data) as {
          type?: string;
          sessionId?: string;
          request?: { sessionId?: string };
        };
        if (message.type === "session.start" && message.request?.sessionId) {
          this.sessionId = message.request.sessionId;
          queueMicrotask(() => {
            this.emitMessage({
              type: "session.accepted",
              sessionId: this.sessionId,
              model: "small",
              backend: "cpu",
            });
            this.emitEngine({ type: "state", sessionId: this.sessionId, sequence: this.nextSequence(), state: "listening" });
            this.emitCaption(0, "I would", false);
            window.setTimeout(() => {
              if (this.readyState !== FakeWebSocket.OPEN) return;
              this.emitCaption(1, "I would like", false);
            }, 40);
          });
          return;
        }

        if ((message.type === "session.stop" || message.type === "session.cancel") && message.sessionId) {
          queueMicrotask(() => {
            if (message.type === "session.stop") {
              this.emitCaption(2, "I would like to reserve a room.", true);
            }
            this.emitEngine({ type: "state", sessionId: message.sessionId, sequence: this.nextSequence(), state: "stopped" });
          });
        }
      }

      public close() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", new CloseEvent("close", { code: 1000, reason: "" }));
      }

      private nextSequence() {
        const sequence = this.eventSequence;
        this.eventSequence += 1;
        return sequence;
      }

      private emitCaption(revision: number, text: string, isFinal: boolean) {
        this.emitEngine({
          type: "segment.upsert",
          sessionId: this.sessionId,
          sequence: this.nextSequence(),
          segment: {
            id: this.segmentId,
            ordinal: 0,
            revision,
            startMs: 0,
            endMs: 400 + revision * 200,
            text,
            language: { tag: "en-US" },
            isFinal,
          },
        });
      }

      private emitEngine(event: Record<string, unknown>) {
        this.emitMessage({ type: "engine.event", event });
      }

      private emitMessage(value: unknown) {
        this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
      }

      private emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    function arrayBufferOf(data: ArrayBufferLike | Blob | ArrayBufferView): ArrayBuffer | undefined {
      if (data instanceof ArrayBuffer) return data;
      if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }
      return undefined;
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  });
}

async function chooseOfflineLocal(page: Page) {
  await page.getByRole("button", { name: "Offline local" }).click();
}

async function selectEnglishAndStart(page: Page, timeout = 5_000) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Listening", { timeout });
}

async function startOfflineSession(page: Page, timeout = 5_000) {
  await chooseOfflineLocal(page);
  await selectEnglishAndStart(page, timeout);
}

test("fake microphone starts and stops without loading a real model", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");

  await startOfflineSession(page);
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status")).toContainText("Standby");
  await expect(page.locator(".transcript").getByText("synthetic final")).toBeVisible();
});

test("rapid clear and restart drops stale transcript events", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");

  await startOfflineSession(page);
  await page.getByRole("button", { name: "Clear & Restart" }).click();

  await expect(page.getByRole("status")).toContainText("Listening");
  await expect(page.getByText("synthetic final")).toHaveCount(0);
});

test("permission denial leaves the session stopped with an actionable error", async ({ page }) => {
  await installBrowserFakes(page, "permission-denied");
  await page.goto("/");

  await chooseOfflineLocal(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(page.getByRole("status")).toContainText("Standby");
});

test("a worker crash is surfaced without accepting a transcript", async ({ page }) => {
  await installBrowserFakes(page, "worker-crash");
  await page.goto("/");

  await chooseOfflineLocal(page);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("local Whisper worker failed");
  await expect(page.getByRole("status")).toContainText("Standby");
  await expect(page.getByText("synthetic final")).toHaveCount(0);
});

test("a reload reuses the fake cached local model path", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");
  await startOfflineSession(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fake-local-model-prepares"))).toBe("1");

  await page.reload();
  await startOfflineSession(page);

  await expect.poll(() => page.evaluate(() => localStorage.getItem("fake-local-model-prepares"))).toBe("2");
  await expect.poll(() => page.evaluate(() => (window as Window & { __transcriptionE2e: { cacheHits: number } }).__transcriptionE2e.cacheHits)).toBe(1);
});

test("benchmark: reports synthetic transcription UI lifecycle timings", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");
  const startedAt = performance.now();
  await startOfflineSession(page);
  await expect(page.locator(".transcript").getByText("synthetic provisional")).toBeVisible();
  const firstProvisionalUiMs = Math.round(performance.now() - startedAt);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".transcript").getByText("synthetic final")).toBeVisible();
  const finalUiMs = Math.round(performance.now() - startedAt);

  const timings = {
    firstProvisionalUiMs,
    finalUiMs,
    scope: "synthetic worker events; audio inference and accuracy are not measured",
  };
  console.log(`TRANSCRIPTION_LIFECYCLE_TIMING ${JSON.stringify(timings)}`);
  expect(finalUiMs).toBeGreaterThanOrEqual(firstProvisionalUiMs);
});

test("transcribes the JFK fixture through the real browser worker, VAD, and whisper.cpp WASM bridge", async ({ page }) => {
  test.setTimeout(180_000);
  await installRealBridgeMicrophoneSeam(page);
  await page.goto("/");

  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  for (const model of ["/models/ggml-tiny-q5_1.bin", "/models/ggml-silero-v6.2.0.bin"]) {
    const status = await page.evaluate(async (url) => (await fetch(url)).status, model);
    expect(status).toBe(200);
  }
  await expect(page.getByRole("button", { name: "English (US)" })).toHaveAttribute("aria-pressed", "true");

  let started = false;
  try {
    await chooseOfflineLocal(page);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    started = true;
    await expect(page.getByRole("status")).toContainText("Listening", { timeout: 45_000 });
    const fixture = await readFile(new URL("../fixtures/jfk.wav", import.meta.url));
    expect(fixture.byteLength).toBe(352_078);
    await page.evaluate(async (base64) => {
      const bridge = (window as Window & {
        __realBridgeE2e: { pushFixture(base64: string): Promise<void> };
      }).__realBridgeE2e;
      await bridge.pushFixture(base64);
    }, fixture.toString("base64"));

    let fatalAlertText: string | undefined;
    await expect.poll(async () => {
      const alert = page.getByRole("alert");
      if (await alert.isVisible()) {
        fatalAlertText = await alert.innerText();
        return "terminal";
      }
      const text = await page.locator(".transcript").innerText();
      return text.toLowerCase().replace(/[^a-z]+/g, " ").includes("my fellow americans")
        ? "terminal"
        : "pending";
    }, { timeout: 100_000 }).toBe("terminal");
    if (fatalAlertText) throw new Error(`Real local transcription failed: ${fatalAlertText}`);

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("status")).toContainText("Standby", { timeout: 20_000 });
    started = false;
  } finally {
    if (started && await page.getByRole("button", { name: "Stop" }).isEnabled()) {
      await page.getByRole("button", { name: "Stop" }).click();
    }
  }
});

test.describe("live localhost captions", () => {
  test("revises one live caption in place until stop finalizes it", async ({ page }) => {
    await installBrowserFakes(page);
    await installLiveWebSocketFake(page);
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Live (this PC)" })).toHaveAttribute("aria-pressed", "true");
    await selectEnglishAndStart(page);

    const protocols = await page.evaluate(() => (window as Window & { __liveWsProtocols?: string[] }).__liveWsProtocols ?? []);
    expect(protocols).toContain("voice-transcription.v1");

    const caption = page.locator(".transcript [data-final]");
    await expect(caption).toHaveCount(1);
    await expect(caption).toHaveAttribute("data-final", "false");
    await expect(caption).toContainText("I would");
    await expect(page.locator(".transcript-updating")).toBeVisible();

    await expect(caption).toHaveCount(1);
    await expect(caption).toContainText("I would like");
    await expect(page.locator(".transcript-updating")).toBeVisible();

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(caption).toHaveCount(1);
    await expect(caption).toHaveAttribute("data-final", "true");
    await expect(caption).toContainText("I would like to reserve a room.");
    await expect(page.getByRole("status")).toContainText("Standby");
  });
});
