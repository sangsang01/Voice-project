import type { EngineInspection, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./sessionController";

class PendingInspectionEngine implements TranscriptionEngine {
  public readonly session: TranscriptionSession = {
    push: () => ({ accepted: true }),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
  };
  public readonly inspect = vi.fn<() => Promise<EngineInspection>>();
  public readonly prepare = vi.fn(async () => undefined);
  public readonly open = vi.fn(async () => this.session);
  public readonly dispose = vi.fn(async () => undefined);
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

describe("SessionController inspection cancellation", () => {
  it("awaits an active session stop before resolving stop", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveStop: () => void = () => undefined;
    (engine.session.stop as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveStop = () => resolve(undefined); }),
    );
    const microphoneStop = vi.fn(async () => undefined);
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: microphoneStop })),
    });
    await controller.start(["en-US"]);

    let settled = false;
    const stopping = controller.stop().then(() => { settled = true; });
    await vi.waitFor(() => expect(engine.session.stop).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    resolveStop();
    await stopping;
    expect(microphoneStop).toHaveBeenCalledTimes(1);
  });

  it("awaits active-session cancellation before resolving clear", async () => {
    const engine = new PendingInspectionEngine();
    engine.inspect.mockResolvedValue({ available: true });
    let resolveCancel: () => void = () => undefined;
    (engine.session.cancel as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<undefined>((resolve) => { resolveCancel = () => resolve(undefined); }),
    );
    const controller = new SessionController({
      dispatch: vi.fn(),
      engineFactory: () => engine,
      microphoneFactory: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
    });
    await controller.start(["en-US"]);

    let settled = false;
    const clearing = controller.clear().then(() => { settled = true; });
    await vi.waitFor(() => expect(engine.session.cancel).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    resolveCancel();
    await clearing;
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
