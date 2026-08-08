import { describe, expect, it } from "vitest";

import { describeEngineContract, makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import { LocalWhisperEngine, type WorkerLike } from "../src/LocalWhisperEngine.js";
import { createWorkerController, type WhisperRuntime } from "../src/worker/localWhisper.worker.js";
import type { MainToWorker, WorkerEvent } from "../src/worker/protocol.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class RuntimeWorker implements WorkerLike {
  public onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public terminated = false;
  private readonly controller;

  public constructor(runtime: WhisperRuntime) {
    this.controller = createWorkerController(runtime, (event) => this.onmessage?.({ data: event } as MessageEvent<WorkerEvent>));
  }

  public postMessage(message: MainToWorker): void {
    void this.controller.handle(message);
  }

  public terminate(): void {
    this.terminated = true;
    void this.controller.dispose();
  }
}

function runtime(): WhisperRuntime {
  return {
    load: async ({ onProgress }) => onProgress(1),
    transcribe: async (_samples, _signal) => ({ text: "hello", startMs: 0, endMs: 20 }),
    dispose: async () => undefined,
  };
}

describeEngineContract("local whisper", () => new LocalWhisperEngine({ workerFactory: () => new RuntimeWorker(runtime()) }), {
  request: makeSessionRequest(["en-US"]),
  frame: makePcmFrame(0),
});

describe("worker controller", () => {
  it("uses load options, revises a stable segment, and warns after three slower-than-realtime windows", async () => {
    const events: WorkerEvent[] = [];
    const loadOptions: unknown[] = [];
    let clock = 0;
    const controller = createWorkerController({
      load: async (options) => { loadOptions.push(options); },
      transcribe: async () => {
        clock += 200;
        return { text: "hello", startMs: 0, endMs: 100 };
      },
      dispose: async () => undefined,
    }, (event) => events.push(event), { now: () => clock, windowFrames: 5 });
    const request = makeSessionRequest(["en-US"]);

    await controller.handle({ type: "prepare", requestId: 1, device: "webgpu" });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 15; index += 1) {
      await controller.handle({ type: "push", sessionId: request.sessionId, frame: makePcmFrame(index) });
    }
    await controller.handle({ type: "stop", sessionId: request.sessionId });

    expect(loadOptions).toEqual([expect.objectContaining({ device: "webgpu" })]);
    const segments = events.filter((event) => event.type === "event" && event.event.type === "segment.upsert");
    expect(segments.map((event) => (event as Extract<WorkerEvent, { type: "event" }>).event.segment.id)).toEqual([
      `${request.sessionId}:0`, `${request.sessionId}:0`, `${request.sessionId}:0`, `${request.sessionId}:0`,
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "warning", code: "DEGRADED_PERFORMANCE" }) }),
    ]));
  });

  it("serializes overlapping windows so burst frames produce ordered non-duplicate revisions", async () => {
    const events: WorkerEvent[] = [];
    const inferences: number[][] = [];
    const completions: Array<() => void> = [];
    const controller = createWorkerController({
      load: async () => undefined,
      transcribe: async (samples) => new Promise((resolve) => {
        inferences.push([samples[0]!, samples[320]!].map((value) => Math.round(value * 0x8000)));
        completions.push(() => resolve({ text: "hello", startMs: 0, endMs: 40 }));
      }),
      dispose: async () => undefined,
    }, (event) => events.push(event), { windowFrames: 2 });
    const request = makeSessionRequest(["en-US"]);
    await controller.handle({ type: "prepare", requestId: 1, device: "wasm" });
    await controller.handle({ type: "open", request });
    const pushes = [0, 1, 2, 3].map((sequence) => controller.handle({
      type: "push",
      sessionId: request.sessionId,
      frame: { ...makePcmFrame(sequence), samples: new Int16Array(320).fill(sequence + 1) },
    }));

    await flush();
    expect(inferences).toEqual([[1, 2]]);
    completions.shift()!();
    await flush();
    expect(inferences).toEqual([[1, 2], [2, 3]]);
    completions.shift()!();
    await flush();
    expect(inferences).toEqual([[1, 2], [2, 3], [3, 4]]);
    completions.shift()!();
    await Promise.all(pushes);
    expect(events.filter((event) => event.type === "event" && event.event.type === "segment.upsert").map((event) => (event as Extract<WorkerEvent, { type: "event" }>).event.segment.revision)).toEqual([1, 2, 3]);
  });

  it("surfaces a fatal error and stops the session when transcription rejects", async () => {
    const events: WorkerEvent[] = [];
    const controller = createWorkerController({
      load: async () => undefined,
      transcribe: async () => { throw new Error("inference crashed"); },
      dispose: async () => undefined,
    }, (event) => events.push(event), { windowFrames: 1 });
    const request = makeSessionRequest(["en-US"]);
    await controller.handle({ type: "prepare", requestId: 1, device: "wasm" });
    await controller.handle({ type: "open", request });
    await controller.handle({ type: "push", sessionId: request.sessionId, frame: makePcmFrame(0) });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "error", fatal: true, code: "INTERNAL", message: "inference crashed" }) }),
      expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "state", state: "stopped" }) }),
    ]));
  });

  it("surfaces a fatal timeout error and stops the session when transcription hangs", async () => {
    const events: WorkerEvent[] = [];
    const controller = createWorkerController({
      load: async () => undefined,
      transcribe: () => new Promise(() => { /* never resolves, simulating a hung inference call */ }),
      dispose: async () => undefined,
    }, (event) => events.push(event), { windowFrames: 1, transcribeTimeoutMs: 20 });
    const request = makeSessionRequest(["en-US"]);
    await controller.handle({ type: "prepare", requestId: 1, device: "wasm" });
    await controller.handle({ type: "open", request });
    await controller.handle({ type: "push", sessionId: request.sessionId, frame: makePcmFrame(0) });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "error", fatal: true, code: "TIMEOUT" }) }),
      expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "state", state: "stopped" }) }),
    ]));
  });
});
