import type { EngineInspection, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { describe, expect, it, vi } from "vitest";
import { SessionController } from "./sessionController";

class PendingInspectionEngine implements TranscriptionEngine {
  private readonly session: TranscriptionSession = {
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
