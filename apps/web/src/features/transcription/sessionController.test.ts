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
    expect(engine.dispose).not.toHaveBeenCalled();
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
    expect(engine.dispose).not.toHaveBeenCalled();
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
    const engine = new PendingInspectionEngine();
    let resolveFirstInspection: (inspection: EngineInspection) => void = () => undefined;
    engine.inspect
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstInspection = resolve; }))
      .mockResolvedValueOnce({ available: true });
    const { controller, onLocalError } = createController(engine);

    const firstStart = controller.start(["en-US"]);
    await vi.waitFor(() => expect(engine.inspect).toHaveBeenCalledTimes(1));
    const secondStart = controller.start(["en-US"]);
    await expect(secondStart).resolves.toEqual(expect.any(String));
    resolveFirstInspection({ available: true });

    await expect(firstStart).resolves.toEqual(expect.any(String));
    expect(engine.prepare).toHaveBeenCalledTimes(1);
    expect(engine.open).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(onLocalError).not.toHaveBeenCalled();

    await controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});
