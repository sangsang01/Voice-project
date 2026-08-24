import { expect, test, type Page } from "@playwright/test";

type E2eMode = "normal" | "permission-denied";

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

async function startLiveSession(page: Page, timeout = 5_000) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Listening", { timeout });
}

test("fake microphone starts and stops without loading a real model", async ({ page }) => {
  await installBrowserFakes(page);
  await installLiveWebSocketFake(page);
  await page.goto("/");

  await startLiveSession(page);
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByRole("status")).toContainText("Standby");
  await expect(page.locator(".transcript").getByText("I would like to reserve a room.")).toBeVisible();
});

test("rapid clear and restart drops stale transcript events", async ({ page }) => {
  await installBrowserFakes(page);
  await installLiveWebSocketFake(page);
  await page.goto("/");

  await startLiveSession(page);
  await page.getByRole("button", { name: "Clear & Restart" }).click();

  await expect(page.getByRole("status")).toContainText("Listening");
  await expect(page.getByText("I would like to reserve a room.")).toHaveCount(0);
});

test("permission denial leaves the session stopped with an actionable error", async ({ page }) => {
  await installBrowserFakes(page, "permission-denied");
  await installLiveWebSocketFake(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(page.getByRole("status")).toContainText("Standby");
});

test("benchmark: reports synthetic transcription UI lifecycle timings", async ({ page }) => {
  await installBrowserFakes(page);
  await installLiveWebSocketFake(page);
  await page.goto("/");
  const startedAt = performance.now();
  await startLiveSession(page);
  await expect(page.locator(".transcript").getByText("I would")).toBeVisible();
  const firstProvisionalUiMs = Math.round(performance.now() - startedAt);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".transcript").getByText("I would like to reserve a room.")).toBeVisible();
  const finalUiMs = Math.round(performance.now() - startedAt);

  const timings = {
    firstProvisionalUiMs,
    finalUiMs,
    scope: "synthetic worker events; audio inference and accuracy are not measured",
  };
  console.log(`TRANSCRIPTION_LIFECYCLE_TIMING ${JSON.stringify(timings)}`);
  expect(finalUiMs).toBeGreaterThanOrEqual(firstProvisionalUiMs);
});

test("revises one live caption in place until stop finalizes it", async ({ page }) => {
  await installBrowserFakes(page);
  await installLiveWebSocketFake(page);
  await page.goto("/");

  await expect(page.getByRole("combobox", { name: "Language" })).toHaveValue("en-US");
  await startLiveSession(page);

  const protocols = await page.evaluate(() => (window as Window & { __liveWsProtocols?: string[] }).__liveWsProtocols ?? []);
  expect(protocols).toContain("voice-transcription.v1");

  const caption = page.locator(".transcript [data-final]");
  await expect(caption).toHaveCount(1);
  await expect(caption).toHaveAttribute("data-final", "false");
  await expect(caption).toContainText("I would");
  await expect(page.locator(".transcript-updating")).toHaveCount(0);

  await expect(caption).toHaveCount(1);
  await expect(caption).toContainText("I would like");
  await expect(page.locator(".transcript-updating")).toHaveCount(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(caption).toHaveCount(1);
  await expect(caption).toHaveAttribute("data-final", "true");
  await expect(caption).toContainText("I would like to reserve a room.");
  await expect(page.getByRole("status")).toContainText("Standby");
});
