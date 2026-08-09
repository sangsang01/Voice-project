import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalWhisperEngine, type WorkerLike } from "../src/LocalWhisperEngine.js";
import { makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { WorkerEvent } from "../src/worker/protocol.js";

class FakeWorker implements WorkerLike {
  public onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly sent: unknown[] = [];
  public terminated = false;
  public terminateCalls = 0;
  public nextPostError: Error | undefined;
  public terminateError: Error | undefined;

  public postMessage(message: unknown): void {
    if (this.nextPostError) {
      const error = this.nextPostError;
      this.nextPostError = undefined;
      throw error;
    }
    this.sent.push(message);
  }

  public terminate(): void {
    this.terminateCalls += 1;
    if (this.terminateError) throw this.terminateError;
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles an in-flight preparation when disposed", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const preparing = engine.prepare(makeSessionRequest(["en-US"]));
    const outcome = preparing.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    const oldMessageHandler = worker.onmessage;

    await engine.dispose();
    oldMessageHandler?.({ data: { type: "prepared", requestId: 1 } } as MessageEvent<WorkerEvent>);
    await flush();

    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("engine is disposed");
    expect(worker.terminated).toBe(true);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  });

  it("shares one worker and prepare request across concurrent preparations", async () => {
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({ workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    } });
    const request = makeSessionRequest(["en-US"]);

    const first = engine.prepare(request);
    const second = engine.prepare(request);

    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent).toEqual([{ type: "prepare", requestId: 1 }]);
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("rolls back a failed open and recovers through a replacement worker", async () => {
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
    workers[0]!.nextPostError = new DOMException("could not clone open request", "DataCloneError");

    await expect(engine.open(request)).rejects.toThrow("could not clone open request");
    expect(workers[0]!.terminateCalls).toBe(1);

    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await recovering;
    await expect(engine.open(request)).resolves.toBeDefined();
  });

  it("fails a session coherently when posting a frame throws", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker, maxBufferedFrames: 1 });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    worker.nextPostError = new DOMException("could not clone audio frame", "DataCloneError");

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });

    expect(worker.terminateCalls).toBe(1);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", code: "INTERNAL", fatal: true, message: "could not clone audio frame" }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("settles stop and terminalizes exactly once when posting stop throws", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    worker.nextPostError = new Error("could not post stop");

    const stopping = session.stop();
    await expect(stopping).resolves.toBeUndefined();
    await expect(session.stop()).resolves.toBeUndefined();

    expect(worker.terminateCalls).toBe(1);
    expect(events.filter((event) => (event as { type?: string }).type === "error")).toHaveLength(1);
    expect(events.filter((event) => (event as { type?: string; state?: string }).type === "state" && (event as { state?: string }).state === "stopped")).toHaveLength(1);
  });

  it("preserves stopped cancellation semantics when posting cancel throws", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    worker.nextPostError = new Error("could not post cancel");

    await expect(session.cancel()).rejects.toThrow("could not post cancel");
    await expect(session.cancel()).resolves.toBeUndefined();

    expect(worker.terminateCalls).toBe(1);
    expect(events.filter((event) => (event as { type?: string; state?: string }).type === "state" && (event as { state?: string }).state === "stopped")).toHaveLength(1);
  });

  it("surfaces combined cancel and termination failure after stopped cleanup", async () => {
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    worker.nextPostError = new Error("could not post cancel");
    worker.terminateError = new Error("terminate was denied");

    await expect(session.cancel()).rejects.toThrow(/could not post cancel.*terminate was denied/);

    expect(events).toEqual([
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    await expect(session.cancel()).resolves.toBeUndefined();
    const recovering = engine.prepare(request);
    expect(worker.terminateCalls).toBe(1);
    worker.emit({ type: "prepared", requestId: 2 });
    await expect(recovering).resolves.toBeUndefined();
  });

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

  it("terminates a blocked inference from the engine event loop and can prepare a replacement", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({
      inferenceTimeoutMs: 50,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    workers[0]!.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    await vi.advanceTimersByTimeAsync(50);

    expect(workers[0]!.terminateCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", code: "TIMEOUT", fatal: true }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(events.filter((event) => (event as { type?: string }).type === "error")).toHaveLength(1);
    await expect(engine.open(request)).rejects.toThrow("prepared");

    const recovering = engine.prepare(request);
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await recovering;
    await expect(engine.open({ ...request, sessionId: "recovered" })).resolves.toBeDefined();
  });

  it("clears the inference watchdog when the worker reports completion", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ inferenceTimeoutMs: 50, workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    await engine.open(request);

    worker.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    expect(vi.getTimerCount()).toBe(1);
    worker.emit({ type: "inference.finished", sessionId: request.sessionId, token: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(worker.terminated).toBe(false);
  });

  it("clears the inference watchdog on disposal", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const engine = new LocalWhisperEngine({ inferenceTimeoutMs: 50, workerFactory: () => worker });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    worker.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    worker.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    expect(vi.getTimerCount()).toBe(1);

    await engine.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(events.filter((event) => (event as { code?: string }).code === "TIMEOUT")).toHaveLength(0);
  });

  it("does not let an old worker watchdog terminate a replacement worker", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({
      inferenceTimeoutMs: 50,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await preparing;
    await engine.open(request);
    const oldMessageHandler = workers[0]!.onmessage;
    workers[0]!.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    expect(vi.getTimerCount()).toBe(1);
    workers[0]!.crash();
    expect(vi.getTimerCount()).toBe(0);

    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await recovering;
    oldMessageHandler?.({
      data: { type: "inference.started", sessionId: request.sessionId, token: 2 },
    } as MessageEvent<WorkerEvent>);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(workers[1]!.terminated).toBe(false);
  });

  it("contains listener exceptions while watchdog failure completes and recovers", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({
      inferenceTimeoutMs: 50,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const attempted: string[] = [];
    const observed: string[] = [];
    session.subscribe((event) => {
      attempted.push(event.type === "state" ? `${event.type}:${event.state}` : event.type);
      throw new Error("listener exploded");
    });
    session.subscribe((event) => {
      observed.push(event.type === "state" ? `${event.type}:${event.state}` : event.type);
    });
    const stopping = session.stop();

    workers[0]!.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    await expect(vi.advanceTimersByTimeAsync(50)).resolves.toBeDefined();
    await expect(stopping).resolves.toBeUndefined();

    expect(attempted).toEqual(["error", "state:stopped"]);
    expect(observed).toEqual(["error", "state:stopped"]);
    expect(vi.getTimerCount()).toBe(0);
    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await expect(recovering).resolves.toBeUndefined();
  });

  it("contains listener exceptions while a worker crash completes and recovers", async () => {
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
    const session = await engine.open(request);
    const attempted: string[] = [];
    session.subscribe((event) => {
      attempted.push(event.type === "state" ? `${event.type}:${event.state}` : event.type);
      throw new Error("listener exploded");
    });
    const stopping = session.stop();

    expect(() => workers[0]!.crash()).not.toThrow();
    await expect(stopping).resolves.toBeUndefined();

    expect(attempted).toEqual(["error", "state:stopped"]);
    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await expect(recovering).resolves.toBeUndefined();
  });

  it("continues queued-event replay after a listener throws", async () => {
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
    const session = await engine.open(request);
    const stopping = session.stop();
    workers[0]!.crash();
    await expect(stopping).resolves.toBeUndefined();
    const attempted: string[] = [];

    expect(() => session.subscribe((event) => {
      attempted.push(event.type === "state" ? `${event.type}:${event.state}` : event.type);
      throw new Error("replay listener exploded");
    })).not.toThrow();

    expect(attempted).toEqual(["error", "state:stopped"]);
    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await expect(recovering).resolves.toBeUndefined();
  });

  it("surfaces termination failure without retaining a timed-out session", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const engine = new LocalWhisperEngine({
      inferenceTimeoutMs: 50,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const request = makeSessionRequest(["en-US"]);
    const preparing = engine.prepare(request);
    workers[0]!.emit({ type: "prepared", requestId: 1 });
    await preparing;
    const session = await engine.open(request);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    workers[0]!.terminateError = new Error("terminate was denied");

    workers[0]!.emit({ type: "inference.started", sessionId: request.sessionId, token: 1 });
    await vi.advanceTimersByTimeAsync(50);

    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", code: "TIMEOUT", message: expect.stringMatching(/terminate was denied/) }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(workers[0]!.terminateCalls).toBe(1);
    const recovering = engine.prepare(request);
    workers[1]!.emit({ type: "prepared", requestId: 2 });
    await expect(recovering).resolves.toBeUndefined();
  });

  it("rejects disposal when termination throws but still settles preparation and clears handlers", async () => {
    const worker = new FakeWorker();
    worker.terminateError = new Error("terminate was denied");
    const engine = new LocalWhisperEngine({ workerFactory: () => worker });
    const preparing = engine.prepare(makeSessionRequest(["en-US"]));
    const preparationOutcome = preparing.catch((error: unknown) => error);

    await expect(engine.dispose()).rejects.toThrow("terminate was denied");
    await expect(preparationOutcome).resolves.toEqual(expect.objectContaining({ message: "engine is disposed" }));
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    await expect(engine.inspect()).resolves.toEqual({ available: false, reason: "disposed" });
  });
});
