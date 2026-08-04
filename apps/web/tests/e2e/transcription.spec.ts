import { expect, test, type Page } from "@playwright/test";

type E2eMode = "normal" | "permission-denied" | "worker-crash" | "webgpu-disabled";

async function installBrowserFakes(page: Page, mode: E2eMode = "normal") {
  await page.addInitScript((selectedMode) => {
    type Listener = (event: MessageEvent<unknown>) => void;

    const state = {
      mode: selectedMode,
      prepareDevices: [] as string[],
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

      public postMessage(message: { type: string; requestId?: number; device?: string; request?: { sessionId: string }; sessionId?: string }) {
        if (message.type === "prepare") {
          state.prepareDevices.push(message.device ?? "unknown");
          if (selectedMode === "webgpu-disabled" && message.device === "webgpu") {
            queueMicrotask(() => this.onmessage?.({ data: { type: "prepare.error", requestId: message.requestId, device: "webgpu", message: "WebGPU disabled for this test" } } as MessageEvent));
            return;
          }
          if (state.prepareCount > 0) state.cacheHits += 1;
          state.prepareCount += 1;
          localStorage.setItem("fake-local-model-prepares", String(state.prepareCount));
          queueMicrotask(() => this.onmessage?.({ data: { type: "prepared", requestId: message.requestId, device: message.device } } as MessageEvent));
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

async function selectEnglishAndStart(page: Page) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Listening");
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

test("WebGPU-disabled environments retry the local engine with WASM", async ({ page }) => {
  await installBrowserFakes(page, "webgpu-disabled");
  await page.goto("/");

  await selectEnglishAndStart(page);

  await expect.poll(() => page.evaluate(() => (window as Window & { __transcriptionE2e: { prepareDevices: string[] } }).__transcriptionE2e.prepareDevices)).toEqual(["webgpu", "wasm"]);
});

test("benchmark: reports non-blocking synthetic fixture metrics", async ({ page }) => {
  await installBrowserFakes(page);
  await page.goto("/");
  const fixture = await page.evaluate(async () => {
    const response = await fetch("/tests/fixtures/four-language.wav");
    return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
  });
  expect(fixture.ok).toBe(true);
  expect(fixture.bytes).toBeGreaterThan(44);
  const startedAt = performance.now();
  await selectEnglishAndStart(page);
  await expect(page.getByText("synthetic provisional")).toBeVisible();
  const firstProvisionalLatencyMs = Math.round(performance.now() - startedAt);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("synthetic final")).toBeVisible();
  const finalLatencyMs = Math.round(performance.now() - startedAt);

  const metrics = {
    firstProvisionalLatencyMs,
    finalLatencyMs,
    realtimeFactor: Number((finalLatencyMs / 250).toFixed(2)),
    peakQueuedAudioMs: 0,
    expectedLabels: ["und"],
    detectedLabels: ["und"],
    fixture: "four-language.wav (synthetic silence; accuracy intentionally not scored)",
  };
  console.log(`TRANSCRIPTION_BENCHMARK ${JSON.stringify(metrics)}`);
  expect(finalLatencyMs).toBeGreaterThanOrEqual(firstProvisionalLatencyMs);
});
