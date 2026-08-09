import type { EngineEvent, EngineInspection, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./sessionController";

class PendingInspectionEngine implements TranscriptionEngine {
  public readonly listeners: Array<(event: EngineEvent) => void> = [];
  public readonly unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  public readonly session: TranscriptionSession = {
    push: () => ({ accepted: true }),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    subscribe: (listener) => {
      this.listeners.push(listener);
      const unsubscribe = vi.fn(() => undefined);
      this.unsubscribes.push(unsubscribe);
      return unsubscribe;
    },
  };
  public readonly inspect = vi.fn<() => Promise<EngineInspection>>();
  public readonly prepare = vi.fn(async () => undefined);
  public readonly open = vi.fn(async (request: SessionRequest) => {
    void request;
    return this.session;
  });
  public readonly dispose = vi.fn(async () => undefined);

  public emit(event: EngineEvent): void {
    this.listeners.at(-1)?.(event);
  }
}

function createController(engine: PendingInspectionEngine, onLocalError = vi.fn()) {
  return {
    controller: new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(),
      onLocalError,
    }),
    onLocalError,
  };
}

describe("SessionController terminal event ownership", () => {
  it.each([
    ["fatal", "stop"],
    ["fatal", "clear"],
    ["fatal", "dispose"],
    ["stopped", "stop"],
    ["stopped", "clear"],
    ["stopped", "dispose"],
  ] as const)("publishes %s cleanup before a reentrant dispatch %s", async (terminalKind, operation) => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const microphoneStop = vi.fn(async () => undefined);
    let reentrant: Promise<void> | undefined;
    let triggerReentrancy = false;
    const dispatch = vi.fn((action: EngineEvent | { type: "clear"; nextSessionId: string }) => {
      if (!triggerReentrancy || action.type === "clear") return;
      triggerReentrancy = false;
      reentrant = operation === "stop"
        ? controller.stop()
        : operation === "clear"
          ? controller.clear()
          : controller.dispose();
    });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    const sessionId = await controller.start(["en-US"]);
    dispatch.mockClear();
    triggerReentrancy = true;
    const fatal: EngineEvent = {
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };
    const stopped: EngineEvent = {
      type: "state", sessionId, sequence: terminalKind === "fatal" ? 2 : 1, state: "stopped",
    };

    if (terminalKind === "fatal") engine.emit(fatal);
    engine.emit(stopped);
    await reentrant;

    const engineEvents = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action): action is EngineEvent => action.type !== "clear");
    expect(engineEvents).toEqual(terminalKind === "fatal" ? [fatal, stopped] : [stopped]);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("dispatches fatal before a synchronous stopped event caused by microphone cleanup", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    let sessionId = "";
    const stopped = (): EngineEvent => ({ type: "state", sessionId, sequence: 2, state: "stopped" });
    const microphoneStop = vi.fn(async () => { engine.emit(stopped()); });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    sessionId = await controller.start(["en-US"]);
    dispatch.mockClear();
    const fatal: EngineEvent = {
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };

    engine.emit(fatal);
    await vi.waitFor(() => expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1));

    expect(dispatch.mock.calls.map(([event]) => event)).toEqual([fatal, stopped()]);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
  });

  it("starts and settles terminal cleanup when dispatch throws", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const microphoneStop = vi.fn(async () => undefined);
    let throwTerminal = false;
    const dispatch = vi.fn((action: EngineEvent | { type: "clear" }) => {
      if (throwTerminal && action.type === "error") throw new Error("dispatch failed");
    });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    const sessionId = await controller.start(["en-US"]);
    throwTerminal = true;

    expect(() => engine.emit({
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    })).toThrow("dispatch failed");

    const outcome = await Promise.race([
      controller.stop().then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    expect(outcome).toBe("settled");
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();
  });

  it("retires capture after a fatal error while preserving the following stopped event", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const microphoneStop = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async (options) => {
        signal = options.signal;
        return { stop: microphoneStop };
      }),
    });
    const sessionId = await controller.start(["en-US"]);
    dispatch.mockClear();
    const owned = (controller as unknown as { active?: { queuedFrames: unknown[] } }).active;
    owned?.queuedFrames.push({ frame: "queued" });

    const fatal: EngineEvent = {
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };
    const stopped: EngineEvent = { type: "state", sessionId, sequence: 2, state: "stopped" };
    engine.emit(fatal);
    engine.emit(fatal);
    engine.emit(stopped);

    await vi.waitFor(() => expect(microphoneStop).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls.map(([event]) => event)).toEqual([fatal, stopped]);
    expect(signal?.aborted).toBe(true);
    expect(owned?.queuedFrames).toEqual([]);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();
  });

  it("retires capture after an engine-emitted stopped event", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const microphoneStop = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async (options) => {
        signal = options.signal;
        return { stop: microphoneStop };
      }),
    });
    const sessionId = await controller.start(["en-US"]);
    dispatch.mockClear();
    const stopped: EngineEvent = { type: "state", sessionId, sequence: 1, state: "stopped" };

    engine.emit(stopped);

    await vi.waitFor(() => expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(stopped);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();
  });

  it("shares fatal cleanup with overlapping stop, clear, and dispose calls", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveMicrophoneStop: () => void = () => undefined;
    const microphoneStop = vi.fn(
      () => new Promise<void>((resolve) => { resolveMicrophoneStop = resolve; }),
    );
    const dispatch = vi.fn();
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    const sessionId = await controller.start(["en-US"]);

    const fatal: EngineEvent = {
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };
    const stopped: EngineEvent = { type: "state", sessionId, sequence: 2, state: "stopped" };
    dispatch.mockClear();
    engine.emit(fatal);
    engine.emit(stopped);
    let stopSettled = false;
    let clearSettled = false;
    let disposeSettled = false;
    const stopping = controller.stop().then(() => { stopSettled = true; });
    const clearing = controller.clear().then(() => { clearSettled = true; });
    const disposing = controller.dispose().then(() => { disposeSettled = true; });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(clearSettled).toBe(false);
    expect(disposeSettled).toBe(false);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.slice(0, 2).map(([event]) => event)).toEqual([fatal, stopped]);

    resolveMicrophoneStop();
    await Promise.all([stopping, clearing, disposing]);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale fatal callback after a newer session starts", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const firstMicrophoneStop = vi.fn(async () => undefined);
    const secondMicrophoneStop = vi.fn(async () => undefined);
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn()
        .mockResolvedValueOnce({ stop: firstMicrophoneStop })
        .mockResolvedValueOnce({ stop: secondMicrophoneStop }),
    });
    const firstSessionId = await controller.start(["en-US"]);
    const staleListener = engine.listeners[0];
    await controller.stop();
    await controller.start(["en-US"]);
    dispatch.mockClear();

    staleListener({
      type: "error", sessionId: firstSessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "late failure",
    });
    staleListener({ type: "state", sessionId: firstSessionId, sequence: 2, state: "stopped" });
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalled();
    expect(secondMicrophoneStop).not.toHaveBeenCalled();
    await controller.stop();
    expect(secondMicrophoneStop).toHaveBeenCalledTimes(1);
  });

  it("observes a microphone-stop rejection and still completes terminal cleanup", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const onLocalError = vi.fn();
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({
        stop: vi.fn(async () => { throw new Error("microphone stop failed"); }),
      })),
      onLocalError,
    });
    const sessionId = await controller.start(["en-US"]);
    const owned = (controller as unknown as { active?: { queuedFrames: unknown[] } }).active;
    owned?.queuedFrames.push({ frame: "queued" });
    const fatal: EngineEvent = {
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };

    engine.emit(fatal);

    await vi.waitFor(() => expect(onLocalError).toHaveBeenCalledWith("microphone stop failed"));
    expect(dispatch).toHaveBeenCalledWith(fatal);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(owned?.queuedFrames).toEqual([]);
  });

  it.each(["fatal", "stopped"] as const)("retires a microphone capture that resolves after a %s event", async (terminalKind) => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const microphoneStop = vi.fn(async () => undefined);
    const nextMicrophoneStop = vi.fn(async () => undefined);
    let resolveMicrophone: () => void = () => undefined;
    let signal: AbortSignal | undefined;
    const microphoneFactory = vi.fn()
      .mockImplementationOnce((options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          resolveMicrophone = () => resolve({ stop: microphoneStop });
        });
      })
      .mockResolvedValueOnce({ stop: nextMicrophoneStop });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory,
    });
    const starting = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.listeners).toHaveLength(1));
    const sessionId = (controller as unknown as { active?: { id: string } }).active?.id;
    expect(sessionId).toEqual(expect.any(String));
    dispatch.mockClear();

    const fatal: EngineEvent = {
      type: "error", sessionId: sessionId!, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    };
    const stopped: EngineEvent = {
      type: "state", sessionId: sessionId!, sequence: terminalKind === "fatal" ? 2 : 1, state: "stopped",
    };
    if (terminalKind === "fatal") engine.emit(fatal);
    engine.emit(stopped);
    expect(signal?.aborted).toBe(true);

    await starting;
    expect(dispatch.mock.calls.map(([event]) => event)).toEqual(terminalKind === "fatal" ? [fatal, stopped] : [stopped]);
    expect(microphoneStop).not.toHaveBeenCalled();

    resolveMicrophone();
    await vi.waitFor(() => expect(microphoneStop).toHaveBeenCalledTimes(1));

    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();

    await controller.start(["en-US"]);
    expect(engine.open).toHaveBeenCalledTimes(2);
    expect(nextMicrophoneStop).not.toHaveBeenCalled();
    await controller.dispose();
    expect(nextMicrophoneStop).toHaveBeenCalledTimes(1);
  });

  it("does not acquire a microphone after subscribe synchronously replays stopped", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const unsubscribe = vi.fn();
    engine.session.subscribe = vi.fn()
      .mockImplementationOnce((listener) => {
        listener({
          type: "state",
          sessionId: engine.open.mock.calls[0][0].sessionId,
          sequence: 1,
          state: "stopped",
        });
        return unsubscribe;
      })
      .mockImplementationOnce(() => vi.fn());
    const microphoneFactory = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory,
    });

    await controller.start(["en-US"]);

    expect(microphoneFactory).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(engine.session.cancel).not.toHaveBeenCalled();

    await controller.start(["en-US"]);
    expect(microphoneFactory).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });
});

describe("SessionController inspection cancellation", () => {
  it.each(["stop", "clear", "dispose"] as const)("publishes clear cancellation before a reentrant dispatch %s", async (operation) => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }),
    );
    let resolveMicrophoneStop: () => void = () => undefined;
    const microphoneStop = vi.fn(
      () => new Promise<void>((resolve) => { resolveMicrophoneStop = resolve; }),
    );
    let reentrant: Promise<void> | undefined;
    let triggerReentrancy = false;
    const dispatch = vi.fn((action: EngineEvent | { type: "clear"; nextSessionId: string }) => {
      if (!triggerReentrancy || action.type !== "clear") return;
      triggerReentrancy = false;
      reentrant = operation === "stop"
        ? controller.stop()
        : operation === "clear"
          ? controller.clear()
          : controller.dispose();
    });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    await controller.start(["en-US"]);
    triggerReentrancy = true;

    let clearSettled = false;
    let reentrantSettled = false;
    const clearing = controller.clear().then(() => { clearSettled = true; });
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    const overlapping = reentrant?.then(() => { reentrantSettled = true; });
    await Promise.resolve();

    expect(clearSettled).toBe(false);
    expect(reentrantSettled).toBe(false);
    expect(engine.session.cancel).toHaveBeenCalledTimes(1);
    expect(engine.session.stop).not.toHaveBeenCalled();
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();

    resolveCancel();
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    expect(reentrantSettled).toBe(false);

    resolveMicrophoneStop();
    await Promise.all([clearing, overlapping]);
    expect(engine.session.cancel).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(operation === "dispose" ? 1 : 0);

    if (operation !== "dispose") await controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("settles clear cleanup and preserves its later failure over a dispatch failure", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("engine cancel failed"));
    const unsubscribe = vi.fn(() => { throw new Error("unsubscribe failed"); });
    engine.session.subscribe = vi.fn(() => unsubscribe);
    let rejectMicrophoneStop: (error: Error) => void = () => undefined;
    const microphoneStop = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectMicrophoneStop = reject; }),
    );
    let throwClear = false;
    const dispatch = vi.fn((action: EngineEvent | { type: "clear" }) => {
      if (throwClear && action.type === "clear") throw new Error("dispatch failed");
    });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    await controller.start(["en-US"]);
    throwClear = true;

    let settled = false;
    const clearing = controller.clear();
    void clearing.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    rejectMicrophoneStop(new Error("microphone stop failed"));

    await expect(clearing).rejects.toThrow("unsubscribe failed");
    expect(engine.session.cancel).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["clear", "dispose"] as const)("awaits a pending terminal release when %s dispatch throws", async (operation) => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let rejectMicrophoneStop: (error: Error) => void = () => undefined;
    const microphoneStop = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectMicrophoneStop = reject; }),
    );
    let throwClear = false;
    const dispatch = vi.fn((action: EngineEvent | { type: "clear" }) => {
      if (throwClear && action.type === "clear") throw new Error("dispatch failed");
    });
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
      onLocalError: vi.fn(),
    });
    const sessionId = await controller.start(["en-US"]);
    engine.emit({
      type: "error", sessionId, sequence: 1, code: "INTERNAL", fatal: true, message: "worker failed",
    });
    await vi.waitFor(() => expect(microphoneStop).toHaveBeenCalledTimes(1));
    throwClear = true;

    let settled = false;
    const overlapping = operation === "clear" ? controller.clear() : controller.dispose();
    void overlapping.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(engine.dispose).not.toHaveBeenCalled();
    rejectMicrophoneStop(new Error("microphone stop failed"));

    await expect(overlapping).rejects.toThrow("microphone stop failed");
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(operation === "dispose" ? 1 : 0);

    if (operation !== "dispose") {
      throwClear = false;
      await controller.dispose();
    }
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "clear", "dispose"] as const)("shares an active stop release with concurrent %s", async (concurrentOperation) => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveStop: () => void = () => undefined;
    (engine.session.stop as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveStop = () => resolve(undefined); }),
    );
    const microphoneStop = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async (options) => {
        signal = options.signal;
        return { stop: microphoneStop };
      }),
    });
    await controller.start(["en-US"]);
    const owned = (controller as unknown as { active?: { queuedFrames: unknown[] } }).active;
    owned?.queuedFrames.push({ frame: "queued" });

    let firstSettled = false;
    let secondSettled = false;
    const stopping = controller.stop().then(() => { firstSettled = true; });
    await vi.waitFor(() => expect(engine.session.stop).toHaveBeenCalledTimes(1));
    const concurrent = (
      concurrentOperation === "stop" ? controller.stop()
        : concurrentOperation === "clear" ? controller.clear()
          : controller.dispose()
    ).then(() => { secondSettled = true; });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(engine.session.stop).toHaveBeenCalledTimes(1);
    expect(engine.session.cancel).not.toHaveBeenCalled();
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(owned?.queuedFrames).toEqual([]);
    expect(engine.unsubscribes[0]).not.toHaveBeenCalled();

    resolveStop();
    await Promise.all([stopping, concurrent]);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("awaits active-session cancellation before resolving clear", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }),
    );
    const microphoneStop = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async (options) => {
        signal = options.signal;
        return { stop: microphoneStop };
      }),
    });
    await controller.start(["en-US"]);
    const owned = (controller as unknown as { active?: { queuedFrames: unknown[] } }).active;
    owned?.queuedFrames.push({ frame: "queued" });

    let settled = false;
    const clearing = controller.clear().then(() => { settled = true; });
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(owned?.queuedFrames).toEqual([]);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);

    resolveCancel();
    await clearing;
  });

  it("keeps stop events subscribed until the engine stop settles", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const dispatch = vi.fn();
    const microphoneStop = vi.fn(async () => undefined);
    const controller = new SessionController({
      dispatch,
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    const sessionId = await controller.start(["en-US"]);
    dispatch.mockClear();
    (engine.session.stop as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      engine.emit({ type: "state", sessionId, sequence: 1, state: "draining" });
      engine.emit({ type: "state", sessionId, sequence: 2, state: "stopped" });
    });

    await controller.stop();

    expect(dispatch.mock.calls.map(([event]) => event)).toEqual([
      { type: "state", sessionId, sequence: 1, state: "draining" },
      { type: "state", sessionId, sequence: 2, state: "stopped" },
    ]);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("preserves microphone cleanup failure precedence over an engine stop failure", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    (engine.session.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("engine stop failed"));
    const microphoneStop = vi.fn(async () => { throw new Error("microphone stop failed"); });
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    await controller.start(["en-US"]);

    await expect(controller.stop()).rejects.toThrow("microphone stop failed");
    expect(engine.session.stop).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribes[0]).toHaveBeenCalledTimes(1);
  });

  it("preserves final detach failure precedence while settling cancel and microphone failures", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("engine cancel failed"));
    const unsubscribe = vi.fn(() => { throw new Error("unsubscribe failed"); });
    engine.session.subscribe = vi.fn(() => unsubscribe);
    const microphoneStop = vi.fn(async () => { throw new Error("microphone stop failed"); });
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    await controller.start(["en-US"]);

    await expect(controller.clear()).rejects.toThrow("unsubscribe failed");
    expect(engine.session.cancel).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("retires progress reporting when a start becomes active", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let reportProgress: ((progress: number) => void) | undefined;
    const onProgress = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: (options) => {
        reportProgress = options?.onProgress;
        return engine;
      },
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onProgress,
    });

    await controller.start(["en-US"]);
    reportProgress?.(0.42);

    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reports progress when a published cached engine prepares for a later start", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let reportProgress: ((progress: number) => void) | undefined;
    const onProgress = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: (options) => {
        reportProgress = options?.onProgress;
        return engine;
      },
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onProgress,
    });
    await controller.start(["en-US"]);
    await controller.stop();
    engine.prepare.mockImplementationOnce(async () => { reportProgress?.(0.42); });

    await controller.start(["en-US"]);

    expect(onProgress).toHaveBeenCalledWith(0.42);
  });

  it("drops a cached engine that no longer prepares successfully", async () => {
    const firstEngine = new PendingInspectionEngine();
    firstEngine.inspect
      .mockResolvedValueOnce({ available: true })
      .mockRejectedValueOnce(new Error("worker is no longer available"));
    const secondEngine = new PendingInspectionEngine();
    secondEngine.inspect.mockResolvedValue({ available: true });
    const factory = vi.fn<() => TranscriptionEngine>()
      .mockReturnValueOnce(firstEngine)
      .mockReturnValueOnce(secondEngine);
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: factory,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });
    await controller.start(["en-US"]);
    await controller.stop();

    await expect(controller.start(["en-US"])).rejects.toThrow("worker is no longer available");
    expect(firstEngine.dispose).toHaveBeenCalledTimes(1);

    await controller.start(["en-US"]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(secondEngine.open).toHaveBeenCalledTimes(1);
  });

  it("awaits a cached-engine eviction already pending when disposed", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect
      .mockResolvedValueOnce({ available: true })
      .mockRejectedValueOnce(new Error("worker is no longer available"));
    let resolveEngineDispose: () => void = () => undefined;
    engine.dispose.mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveEngineDispose = () => resolve(undefined); }),
    );
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });
    await controller.start(["en-US"]);
    await controller.stop();

    const failedRestart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));
    const disposing = controller.dispose();
    const firstOutcome = await Promise.race([
      disposing.then(() => "disposed" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    expect(firstOutcome).toBe("pending");

    resolveEngineDispose();
    await Promise.all([failedRestart, disposing]);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a newer cached engine while an older cached eviction is pending", async () => {
    const firstEngine = new PendingInspectionEngine();
    firstEngine.inspect
      .mockResolvedValueOnce({ available: true })
      .mockRejectedValueOnce(new Error("first worker failed"));
    const secondEngine = new PendingInspectionEngine();
    secondEngine.inspect.mockResolvedValue({ available: true });
    let resolveFirstDispose: () => void = () => undefined;
    let resolveSecondDispose: () => void = () => undefined;
    firstEngine.dispose.mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveFirstDispose = () => resolve(undefined); }),
    );
    secondEngine.dispose.mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveSecondDispose = () => resolve(undefined); }),
    );
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: vi.fn<() => TranscriptionEngine>()
        .mockReturnValueOnce(firstEngine)
        .mockReturnValueOnce(secondEngine),
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });
    await controller.start(["en-US"]);
    await controller.stop();

    const failedRestart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(firstEngine.dispose).toHaveBeenCalledTimes(1));
    await controller.start(["en-US"]);
    const disposing = controller.dispose();

    await vi.waitFor(() => expect(secondEngine.dispose).toHaveBeenCalledTimes(1));
    const outcome = await Promise.race([
      disposing.then(() => "disposed" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    expect(outcome).toBe("pending");

    resolveSecondDispose();
    await Promise.resolve();
    expect(firstEngine.dispose).toHaveBeenCalledTimes(1);
    expect(secondEngine.dispose).toHaveBeenCalledTimes(1);
    resolveFirstDispose();
    await Promise.all([failedRestart, disposing]);
  });

  it("reuses a rejecting cached disposal only for the same engine identity", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect
      .mockResolvedValueOnce({ available: true })
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce({ available: true });
    let rejectDispose: (error: Error) => void = () => undefined;
    engine.dispose.mockImplementation(
      () => new Promise<undefined>((_resolve, reject) => { rejectDispose = reject; }),
    );
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });
    await controller.start(["en-US"]);
    await controller.stop();

    const failedRestart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));
    await controller.start(["en-US"]);
    const disposing = controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);

    rejectDispose(new Error("shared cached disposal failed"));
    await expect(disposing).rejects.toThrow("shared cached disposal failed");
    await expect(failedRestart).resolves.toEqual(expect.any(String));
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses one rejecting disposal across overlapping private attempts with the same engine", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockImplementation(() => new Promise<never>(() => undefined));
    let rejectDisposal: (error: Error) => void = () => undefined;
    const sharedDisposal = new Promise<undefined>((_resolve, reject) => { rejectDisposal = reject; });
    engine.dispose.mockImplementation(() => sharedDisposal);
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(),
      onLocalError: vi.fn(),
    });

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    const secondStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(2));
    await controller.stop();
    await Promise.all([firstStart, secondStart]);

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    const disposing = controller.dispose();
    rejectDisposal(new Error("shared private disposal failed"));
    await expect(disposing).rejects.toThrow("shared private disposal failed");
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses a private disposal when the same engine identity is later cached", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ available: true });
    let resolveDisposal: () => void = () => undefined;
    const sharedDisposal = new Promise<undefined>((resolve) => {
      resolveDisposal = () => resolve(undefined);
    });
    engine.dispose.mockImplementation(() => sharedDisposal);
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });

    const privateStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    await controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));

    const disposing = controller.dispose();
    await Promise.resolve();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    resolveDisposal();
    await Promise.all([privateStart, disposing]);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("retires and reports a synchronous engine factory failure", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const factory = vi.fn<() => TranscriptionEngine>()
      .mockImplementationOnce(() => { throw new Error("engine construction failed"); })
      .mockReturnValueOnce(engine);
    const onLocalError = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: factory,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError,
    });

    await expect(controller.start(["en-US"])).rejects.toThrow("engine construction failed");
    expect(onLocalError).toHaveBeenCalledWith("engine construction failed");

    await controller.start(["en-US"]);
    expect(engine.open).toHaveBeenCalledTimes(1);
  });

  it("settles and disposes a never-settling private inspection when disposed", async () => {
    const engine = new PendingInspectionEngine();
    let rejectInspection: (error: Error) => void = () => undefined;
    engine.inspect.mockImplementation(() => new Promise((_resolve, reject) => { rejectInspection = reject; }));
    const { controller, onLocalError } = createController(engine);
    let settled = false;
    const start = controller.start(["en-US"]).then(() => { settled = true; });
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));

    await controller.dispose();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    rejectInspection(new Error("inspection eventually failed"));
    await Promise.resolve();
    expect(onLocalError).not.toHaveBeenCalled();
    await start;
  });

  it("settles and disposes a never-settling private prepare when stopped", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    engine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    const { controller } = createController(engine);
    let settled = false;
    const start = controller.start(["en-US"]).then(() => { settled = true; });
    await vi.waitFor(() => expect(engine.prepare).toHaveBeenCalledTimes(1));

    await controller.stop();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await start;
  });

  it("awaits a pending release and does not begin its reserved restart after stop", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const { controller } = createController(engine);
    await controller.start(["en-US"]);
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }));

    const restart = controller.clearAndRestart(["en-US"]);
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    let stopSettled = false;
    const stopping = controller.stop().then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveCancel();
    await stopping;

    await expect(restart).resolves.toEqual(expect.any(String));
    expect(engine.prepare).toHaveBeenCalledTimes(1);
  });

  it("awaits a pending release and does not begin its reserved restart after dispose", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    const { controller } = createController(engine);
    await controller.start(["en-US"]);
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }),
    );

    const restart = controller.clearAndRestart(["en-US"]);
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    let disposeSettled = false;
    const disposing = controller.dispose().then(() => { disposeSettled = true; });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);
    expect(engine.dispose).not.toHaveBeenCalled();

    resolveCancel();
    await disposing;
    await expect(restart).resolves.toEqual(expect.any(String));
    expect(engine.prepare).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("shares terminal disposal and awaits private-engine disposal exactly once", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockImplementation(() => new Promise<never>(() => undefined));
    let resolveEngineDispose: () => void = () => undefined;
    engine.dispose.mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveEngineDispose = () => resolve(undefined); }),
    );
    const { controller } = createController(engine);
    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));

    let firstSettled = false;
    let secondSettled = false;
    const firstDispose = controller.dispose().then(() => { firstSettled = true; });
    const secondDispose = controller.dispose().then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(engine.dispose).toHaveBeenCalledTimes(1);

    resolveEngineDispose();
    await Promise.all([firstDispose, secondDispose, start]);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("awaits private-engine disposal detached by an earlier stop", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    engine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    let resolveEngineDispose: () => void = () => undefined;
    engine.dispose.mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveEngineDispose = () => resolve(undefined); }),
    );
    const { controller } = createController(engine);
    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.prepare).toHaveBeenCalledTimes(1));
    await controller.stop();
    await start;
    expect(engine.dispose).toHaveBeenCalledTimes(1);

    const disposing = controller.dispose();
    const firstOutcome = await Promise.race([
      disposing.then(() => "disposed" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    expect(firstOutcome).toBe("pending");

    resolveEngineDispose();
    await disposing;
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains an observed private-disposal rejection for terminal dispose", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    engine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    let rejectEngineDispose: (error: Error) => void = () => undefined;
    engine.dispose.mockImplementation(
      () => new Promise<undefined>((_resolve, reject) => { rejectEngineDispose = reject; }),
    );
    const { controller } = createController(engine);
    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.prepare).toHaveBeenCalledTimes(1));
    await controller.stop();
    await start;
    rejectEngineDispose(new Error("private disposal failed"));
    await Promise.resolve();

    await expect(controller.dispose()).rejects.toThrow("private disposal failed");
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the cached engine even when active-session release fails", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    (engine.session.cancel as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("session cancellation failed"));
    const { controller } = createController(engine);
    await controller.start(["en-US"]);

    await expect(controller.dispose()).rejects.toThrow("session cancellation failed");
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("retires and reports a release failure before allowing a later start", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    (engine.session.cancel as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("session cancellation failed"));
    const onLocalError = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError,
    });
    await controller.start(["en-US"]);

    await expect(controller.clearAndRestart(["en-US"])).rejects.toThrow("session cancellation failed");
    expect(onLocalError).toHaveBeenCalledWith("session cancellation failed");

    await controller.start(["en-US"]);
    expect(engine.open).toHaveBeenCalledTimes(2);
  });

  it("suppresses a start error after a newer attempt supersedes deferred cleanup", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }),
    );
    const onLocalError = vi.fn();
    const microphoneFactory = vi.fn()
      .mockRejectedValueOnce(new Error("old microphone failed"))
      .mockResolvedValueOnce({ stop: vi.fn(async () => undefined) });
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory,
      onLocalError,
    });

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    const restart = controller.clearAndRestart(["en-US"]);
    resolveCancel();

    await expect(firstStart).resolves.toEqual(expect.any(String));
    await expect(restart).resolves.toEqual(expect.any(String));
    expect(onLocalError).not.toHaveBeenCalled();
  });

  it("keeps a pending prepare engine private from a newer restart", async () => {
    const firstEngine = new PendingInspectionEngine();
    const secondEngine = new PendingInspectionEngine();
    firstEngine.inspect.mockResolvedValue({ available: true });
    secondEngine.inspect.mockResolvedValue({ available: true });
    let resolveFirstPrepare: () => void = () => undefined;
    firstEngine.prepare.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveFirstPrepare = () => resolve(undefined); }));
    const factory = vi.fn<() => TranscriptionEngine>()
      .mockReturnValueOnce(firstEngine)
      .mockReturnValueOnce(secondEngine);
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: factory,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError: vi.fn(),
    });

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(firstEngine.prepare).toHaveBeenCalledTimes(1));
    const secondStart = controller.clearAndRestart(["en-US"]);
    await expect(secondStart).resolves.toEqual(expect.any(String));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(secondEngine.prepare).toHaveBeenCalledTimes(1);
    expect(secondEngine.open).toHaveBeenCalledTimes(1);

    resolveFirstPrepare();
    await expect(firstStart).resolves.toEqual(expect.any(String));
    expect(firstEngine.dispose).toHaveBeenCalledTimes(1);
    expect(secondEngine.dispose).not.toHaveBeenCalled();

    await controller.dispose();
    expect(secondEngine.dispose).toHaveBeenCalledTimes(1);
  });

  it("silences a stale prepare rejection without disturbing the newer engine", async () => {
    const firstEngine = new PendingInspectionEngine();
    const secondEngine = new PendingInspectionEngine();
    firstEngine.inspect.mockResolvedValue({ available: true });
    secondEngine.inspect.mockResolvedValue({ available: true });
    let rejectFirstPrepare: (error: Error) => void = () => undefined;
    firstEngine.prepare.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirstPrepare = reject; }));
    const factory = vi.fn<() => TranscriptionEngine>()
      .mockReturnValueOnce(firstEngine)
      .mockReturnValueOnce(secondEngine);
    const onLocalError = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: factory,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError,
    });

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(firstEngine.prepare).toHaveBeenCalledTimes(1));
    await expect(controller.clearAndRestart(["en-US"])).resolves.toEqual(expect.any(String));
    rejectFirstPrepare(new Error("first prepare failed"));

    await expect(firstStart).resolves.toEqual(expect.any(String));
    expect(firstEngine.dispose).toHaveBeenCalledTimes(1);
    expect(secondEngine.dispose).not.toHaveBeenCalled();
    expect(onLocalError).not.toHaveBeenCalled();
  });

  it("does not prepare or report an error when a stopped inspection later becomes available", async () => {
    const engine = new PendingInspectionEngine();
    let resolveInspection: (inspection: EngineInspection) => void = () => undefined;
    engine.inspect.mockImplementation(() => new Promise((resolve) => { resolveInspection = resolve; }));
    const { controller, onLocalError } = createController(engine);

    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    await controller.stop();
    resolveInspection({ available: true });

    await expect(start).resolves.toEqual(expect.any(String));
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.open).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(onLocalError).not.toHaveBeenCalled();

    await controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not report an inspection rejection that arrives after stop", async () => {
    const engine = new PendingInspectionEngine();
    let rejectInspection: (error: Error) => void = () => undefined;
    engine.inspect.mockImplementation(() => new Promise((_resolve, reject) => { rejectInspection = reject; }));
    const { controller, onLocalError } = createController(engine);

    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    await controller.stop();
    rejectInspection(new Error("cross-origin isolation is unavailable"));

    await expect(start).resolves.toEqual(expect.any(String));
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.open).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(onLocalError).not.toHaveBeenCalled();
  });

  it("does not prepare or dispose twice when an unmounted inspection later resolves", async () => {
    const engine = new PendingInspectionEngine();
    let resolveInspection: (inspection: EngineInspection) => void = () => undefined;
    engine.inspect.mockImplementation(() => new Promise((resolve) => { resolveInspection = resolve; }));
    const { controller, onLocalError } = createController(engine);

    const start = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    await controller.dispose();
    resolveInspection({ available: true });

    await expect(start).resolves.toEqual(expect.any(String));
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.open).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(onLocalError).not.toHaveBeenCalled();
  });

  it("does not let an older inspection dispose the engine used by a newer start", async () => {
    const firstEngine = new PendingInspectionEngine();
    const secondEngine = new PendingInspectionEngine();
    let resolveFirstInspection: (inspection: EngineInspection) => void = () => undefined;
    firstEngine.inspect
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstInspection = resolve; }))
    secondEngine.inspect
      .mockResolvedValueOnce({ available: true });
    const onLocalError = vi.fn();
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: vi.fn<() => TranscriptionEngine>()
        .mockReturnValueOnce(firstEngine)
        .mockReturnValueOnce(secondEngine),
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      onLocalError,
    });

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(firstEngine.inspect).toHaveBeenCalledTimes(1));
    const secondStart = controller.start(["en-US"]);
    await expect(secondStart).resolves.toEqual(expect.any(String));
    resolveFirstInspection({ available: true });

    await expect(firstStart).resolves.toEqual(expect.any(String));
    expect(firstEngine.dispose).toHaveBeenCalledTimes(1);
    expect(secondEngine.prepare).toHaveBeenCalledTimes(1);
    expect(secondEngine.open).toHaveBeenCalledTimes(1);
    expect(secondEngine.dispose).not.toHaveBeenCalled();
    expect(onLocalError).not.toHaveBeenCalled();

    await controller.dispose();
    expect(secondEngine.dispose).toHaveBeenCalledTimes(1);
  });
});
