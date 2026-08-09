import { describe, expect, it } from "vitest";

import { LocalWhisperEngine, type WorkerLike } from "../src/LocalWhisperEngine.js";
import { makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { WorkerEvent } from "../src/worker/protocol.js";

class FakeWorker implements WorkerLike {
  public onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly sent: unknown[] = [];
  public terminated = false;

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emit(message: WorkerEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerEvent>);
  }

  public crash(message = "worker crashed"): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalWhisperEngine", () => {
  it("relays preparation progress through the single local backend", async () => {
    const worker = new FakeWorker();
    const progress: number[] = [];
    const engine = new LocalWhisperEngine({
      onProgress: (value) => progress.push(value),
      workerFactory: () => worker,
    });
    const request = makeSessionRequest(["en-US"]);

    const preparing = engine.prepare(request);
    worker.emit({ type: "progress", requestId: 1, progress: 0.25 });
    worker.emit({ type: "progress", requestId: 1, progress: 1 });
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;

    expect(progress).toEqual([0.25, 1]);
    expect(worker.sent).toEqual([{ type: "prepare", requestId: 1 }]);
  });

  it("reports why local transcription is unavailable when the host is not isolated", async () => {
    const engine = new LocalWhisperEngine({ workerFactory: () => { throw new Error("should not construct"); } });
    const original = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
    try {
      const inspection = await engine.inspect();
      expect(inspection.available).toBe(false);
      expect(inspection.reason).toMatch(/cross-origin isolation/i);
    } finally {
      if (original) Object.defineProperty(globalThis, "crossOriginIsolated", original);
      else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    }
  });

  it("rejects a preparation error without constructing a fallback worker", async () => {
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({ workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    } });

    const preparing = engine.prepare(makeSessionRequest(["en-US"]));
    const rejects = expect(preparing).rejects.toThrow("load failed");
    workers[0]!.emit({ type: "prepare.error", requestId: 1, message: "load failed" });
    await flush();
    workers[1]?.emit({ type: "prepared", requestId: 2 });

    await rejects;
    expect(workers).toHaveLength(1);
  });

  it("matches the worker's 3000-frame buffer cap by default", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);

    for (let sequence = 0; sequence < 3000; sequence += 1) {
      expect(session.push(makePcmFrame(sequence))).toEqual({ accepted: true });
    }
    expect(session.push(makePcmFrame(3000))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("orders transferred frames, applies bounded backpressure, and drains to a final stable segment", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker, maxBufferedFrames: 2 });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });
    expect(worker.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: "push", frame: expect.objectContaining({ sequence: 0 }) }),
      expect.objectContaining({ type: "push", frame: expect.objectContaining({ sequence: 1 }) }),
    ]);

    const stopping = session.stop();
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: false, reason: "backpressure" });
    worker.emit({ type: "event", event: { type: "state", sessionId: request.sessionId, sequence: 1, state: "draining" } });
    worker.emit({ type: "event", event: { type: "segment.upsert", sessionId: request.sessionId, sequence: 2, segment: { id: `${request.sessionId}:0`, ordinal: 0, revision: 2, startMs: 0, endMs: 40, text: "hello", language: { tag: "en-US" }, isFinal: true } } });
    worker.emit({ type: "event", event: { type: "state", sessionId: request.sessionId, sequence: 3, state: "stopped" } });
    await stopping;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "segment.upsert", segment: expect.objectContaining({ id: `${request.sessionId}:0`, revision: 2, isFinal: true }) }),
    ]));
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("cancels immediately and idempotently, terminates workers, and ignores late worker events", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    await session.cancel();
    await session.cancel();
    const afterCancel = events.length;
    worker.emit({ type: "event", event: { type: "segment.upsert", sessionId: request.sessionId, sequence: 99, segment: { id: "late", ordinal: 0, revision: 1, startMs: 0, endMs: 1, text: "late", language: { tag: "en-US" }, isFinal: false } } });
    await flush();

    expect(worker.sent.filter((message) => (message as { type?: string }).type === "cancel")).toHaveLength(1);
    expect(events).toHaveLength(afterCancel);
    await engine.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("releases capacity only after worker credits are consumed", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker, maxBufferedFrames: 2 });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });
    worker.emit({ type: "credit", sessionId: request.sessionId, frames: 1 } as unknown as WorkerEvent);
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: true });
    worker.emit({ type: "credit", sessionId: request.sessionId, frames: 2 } as unknown as WorkerEvent);
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: true });
  });

  it("terminalizes an active session once when a ready worker crashes", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    const stopping = session.stop();
    worker.crash();
    await stopping;

    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", fatal: true, code: "INTERNAL" }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
    worker.crash();
    expect(events.filter((event) => (event as { type?: string }).type === "error")).toHaveLength(1);
  });

  it("rejects a concurrent open instead of orphaning the first session", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const firstRequest = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(firstRequest);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const first = await engine.open(firstRequest);

    await expect(engine.open({ ...firstRequest, sessionId: "other-session" })).rejects.toThrow("active");
    const stopping = first.stop();
    worker.emit({ type: "event", event: { type: "state", sessionId: firstRequest.sessionId, sequence: 1, state: "draining" } });
    worker.emit({ type: "event", event: { type: "state", sessionId: firstRequest.sessionId, sequence: 2, state: "stopped" } });
    await stopping;
  });

  it("invalidates a ready worker that crashes before any session opens and requires preparation again", async () => {
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({ workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    } });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await preparing;
    workers[0]!.crash();

    expect(workers[0]!.terminated).toBe(true);
    await expect(engine.open(request)).rejects.toThrow("prepared");
    const reprepare = engine.prepare(request);
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await reprepare;
    await expect(engine.open(request)).resolves.toBeDefined();
  });

  it("ignores a deferred old-session credit after rapid cancel and reopen", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker, maxBufferedFrames: 2 });
    const firstRequest = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(firstRequest);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const first = await engine.open(firstRequest);
    expect(first.push(makePcmFrame(0))).toEqual({ accepted: true });
    await first.cancel();
    const secondRequest = { ...firstRequest, sessionId: "replacement-session" };
    const second = await engine.open(secondRequest);
    expect(second.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(second.push(makePcmFrame(1))).toEqual({ accepted: true });

    worker.emit({ type: "credit", sessionId: firstRequest.sessionId, frames: 1 });
    expect(second.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });
  });
});
