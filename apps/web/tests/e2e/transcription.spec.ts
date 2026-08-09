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

async function selectEnglishAndStart(page: Page, timeout = 5_000) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Listening", { timeout });
}

test("fake microphone starts and stops without loading a real model", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");

  await selectEnglishAndStart(page);
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status")).toContainText("Standby");
  await expect(page.getByText("synthetic final")).toBeVisible();
});

test("rapid clear and restart drops stale transcript events", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");

  await selectEnglishAndStart(page);
  await page.getByRole("button", { name: "Clear & Restart" }).click();

  await expect(page.getByRole("status")).toContainText("Listening");
  await expect(page.getByText("synthetic final")).toHaveCount(0);
});

test("permission denial leaves the session stopped with an actionable error", async ({ page }) => {
  await installBrowserFakes(page, "permission-denied");
  await page.goto("/");

  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(page.getByRole("status")).toContainText("Standby");
});

test("a worker crash is surfaced without accepting a transcript", async ({ page }) => {
  await installBrowserFakes(page, "worker-crash");
  await page.goto("/");

  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("local Whisper worker failed");
  await expect(page.getByRole("status")).toContainText("Standby");
  await expect(page.getByText("synthetic final")).toHaveCount(0);
});

test("a reload reuses the fake cached local model path", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");
  await selectEnglishAndStart(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("fake-local-model-prepares"))).toBe("1");

  await page.reload();
  await selectEnglishAndStart(page);

  await expect.poll(() => page.evaluate(() => localStorage.getItem("fake-local-model-prepares"))).toBe("2");
  await expect.poll(() => page.evaluate(() => (window as Window & { __transcriptionE2e: { cacheHits: number } }).__transcriptionE2e.cacheHits)).toBe(1);
});

test("benchmark: reports synthetic transcription UI lifecycle timings", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");
  const startedAt = performance.now();
  await selectEnglishAndStart(page);
  await expect(page.getByText("synthetic provisional")).toBeVisible();
  const firstProvisionalUiMs = Math.round(performance.now() - startedAt);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("synthetic final")).toBeVisible();
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
