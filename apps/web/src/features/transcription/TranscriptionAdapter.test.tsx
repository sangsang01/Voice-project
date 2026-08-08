import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  EngineEvent,
  EngineEventListener,
  PcmFrame,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptionEngine } from "./engineFactory";
import { TranscriptionAdapter } from "./TranscriptionAdapter";

vi.mock("./engineFactory", () => ({ createTranscriptionEngine: vi.fn() }));
const mockCreateEngine = vi.mocked(createTranscriptionEngine);

type EventWithoutSession<E extends EngineEvent = EngineEvent> = E extends EngineEvent
  ? Omit<E, "sessionId">
  : never;

class ControlledSession implements TranscriptionSession {
  private readonly listeners = new Set<EngineEventListener>();
  public readonly frames: PcmFrame[] = [];
  public stop = vi.fn(async () => {
    this.emit({ type: "state", sequence: 1, state: "stopped" });
  });
  public cancel = vi.fn(async () => undefined);
  public rejectNextFrame = false;
  public sessionId = "session-under-test";

  public push(frame: PcmFrame) {
    if (this.rejectNextFrame) {
      this.rejectNextFrame = false;
      return { accepted: false as const, reason: "backpressure" as const };
    }
    this.frames.push(frame);
    return { accepted: true as const };
  }

  public subscribe(listener: EngineEventListener) {
    this.listeners.add(listener);
    listener({ type: "state", sessionId: this.sessionId, sequence: 0, state: "listening" });
    return () => this.listeners.delete(listener);
  }

  public emit(event: EventWithoutSession) {
    for (const listener of this.listeners) listener({ ...event, sessionId: this.sessionId } as EngineEvent);
  }
}

class ControlledEngine implements TranscriptionEngine {
  public readonly session = new ControlledSession();
  public readonly prepare = vi.fn(async () => undefined);
  public readonly open = vi.fn(async (request: SessionRequest) => {
    this.session.sessionId = request.sessionId;
    return this.session;
  });
  public readonly dispose = vi.fn(async () => undefined);
  public readonly inspect = vi.fn(async () => ({ available: true }));
}

function frame(sequence: number): PcmFrame {
  return { sequence, startMs: sequence * 20, samples: new Int16Array(320) };
}

function renderAdapter(options: { engine?: ControlledEngine; failMicrophone?: boolean } = {}) {
  const engine = options.engine ?? new ControlledEngine();
  let onFrame: ((nextFrame: PcmFrame) => void) | undefined;
  const microphone = vi.fn(async (input: { onFrame(frame: PcmFrame): void }) => {
    if (options.failMicrophone) throw new Error("Microphone permission was denied");
    onFrame = input.onFrame;
    return { stop: vi.fn(async () => undefined) };
  });

  render(
    <TranscriptionAdapter
      engineFactory={() => engine}
      microphoneFactory={microphone}
      initialLanguages={[]}
    />,
  );

  return { engine, microphone, emitFrame: (nextFrame: PcmFrame) => onFrame?.(nextFrame) };
}

describe("TranscriptionAdapter", () => {
  it("validates selection to one through four unique languages", () => {
    renderAdapter();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Select between 1 and 4 unique languages");

    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Vietnamese" }));
    fireEvent.click(screen.getByRole("button", { name: "Spanish" }));
    fireEvent.click(screen.getByRole("button", { name: "Chinese" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the local engine before requesting microphone permission and drains on stop", async () => {
    const { engine, microphone } = renderAdapter();
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));
    expect(microphone).toHaveBeenCalledTimes(1);
    expect(engine.open.mock.invocationCallOrder[0]).toBeLessThan(microphone.mock.invocationCallOrder[0]);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(engine.session.stop).toHaveBeenCalledTimes(1));
  });

  it("reuses the same engine across stop and start instead of reloading the model on every recording", async () => {
    const engine = new ControlledEngine();
    const factory = vi.fn(() => engine);
    const microphone = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));
    render(<TranscriptionAdapter engineFactory={factory} microphoneFactory={microphone} initialLanguages={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(engine.session.stop).toHaveBeenCalledTimes(1));
    expect(engine.dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(2));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine.prepare).toHaveBeenCalledTimes(2);
    expect(engine.dispose).not.toHaveBeenCalled();
  });

  it("stopping while the model is still preparing cancels the pending start instead of going live", async () => {
    const engine = new ControlledEngine();
    let resolvePrepare: () => void = () => undefined;
    engine.prepare.mockImplementation(() => new Promise<undefined>((resolve) => { resolvePrepare = () => resolve(undefined); }));
    const { microphone } = renderAdapter({ engine });

    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Preparing local model…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
    expect(screen.queryByText("Preparing local model…")).not.toBeInTheDocument();

    resolvePrepare();
    await waitFor(() => expect(engine.dispose).toHaveBeenCalled());
    expect(engine.open).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
  });

  it("renders provisional and final segments with language badges and model progress", async () => {
    const { engine } = renderAdapter();
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalled());

    engine.session.emit({
      type: "state", sequence: 1, state: "listening",
    });
    engine.session.emit({
      type: "segment.upsert", sequence: 2, segment: {
        id: "s1", ordinal: 1, revision: 1, startMs: 0, endMs: 200, text: "Hello", language: { tag: "en-US" }, isFinal: false,
      },
    });
    engine.session.emit({
      type: "segment.upsert", sequence: 3, segment: {
        id: "s1", ordinal: 1, revision: 2, startMs: 0, endMs: 300, text: "Hello world", language: { tag: "en-US" }, isFinal: true,
      },
    });

    expect(await screen.findByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("en-US")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
  });

  it("warns on backpressure and ignores stale events after clear and restart", async () => {
    const engine = new ControlledEngine();
    const { emitFrame } = renderAdapter({ engine });
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalled());
    engine.session.rejectNextFrame = true;
    emitFrame(frame(0));
    expect(await screen.findByText(/Audio is arriving faster/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear & Restart" }));
    await waitFor(() => expect(engine.session.cancel).toHaveBeenCalled());
    engine.session.emit({
      type: "segment.upsert", sequence: 2, segment: {
        id: "stale", ordinal: 1, revision: 1, startMs: 0, endMs: 20, text: "stale", language: { tag: "en-US" }, isFinal: false,
      },
    });
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });

  it("shows local microphone failures and requires explicit consent before cloud use", async () => {
    renderAdapter({ failMicrophone: true });
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone permission was denied");
    expect(screen.getByRole("status")).toHaveTextContent("Standby");

    fireEvent.click(screen.getByRole("button", { name: "Use cloud transcription" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Cloud transcription sends audio off this device");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("TranscriptionAdapter engine selection", () => {
  const fakeMicrophone = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));

  beforeEach(() => {
    mockCreateEngine.mockReset();
    fakeMicrophone.mockClear();
  });

  function selectEnglishAndStart() {
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
  }

  it("uses the local engine by default, without any consent", async () => {
    const localEngine = new ControlledEngine();
    mockCreateEngine.mockReturnValue(localEngine);

    render(<TranscriptionAdapter initialLanguages={[]} microphoneFactory={fakeMicrophone} websocketUrl="wss://api.test/transcribe" />);
    selectEnglishAndStart();

    await waitFor(() => expect(localEngine.open).toHaveBeenCalledTimes(1));
    expect(mockCreateEngine).toHaveBeenCalledTimes(1);
    expect(mockCreateEngine).toHaveBeenCalledWith({ kind: "local", cloudConsent: false, websocketUrl: "wss://api.test/transcribe", onProgress: expect.any(Function) });
  });

  it("only constructs the cloud (browser) client after explicit consent, never a local engine", async () => {
    const localEngine = new ControlledEngine();
    const cloudEngine = new ControlledEngine();
    mockCreateEngine.mockImplementation(({ kind }) => (kind === "cloud" ? cloudEngine : localEngine));

    render(<TranscriptionAdapter initialLanguages={[]} microphoneFactory={fakeMicrophone} websocketUrl="wss://api.test/transcribe" />);
    fireEvent.click(screen.getByRole("button", { name: "Use cloud transcription" }));
    fireEvent.click(screen.getByRole("button", { name: "I consent to cloud transcription" }));
    selectEnglishAndStart();

    await waitFor(() => expect(cloudEngine.open).toHaveBeenCalledTimes(1));
    expect(localEngine.open).not.toHaveBeenCalled();
    expect(mockCreateEngine).toHaveBeenCalledTimes(1);
    expect(mockCreateEngine).toHaveBeenCalledWith({ kind: "cloud", cloudConsent: true, websocketUrl: "wss://api.test/transcribe", onProgress: expect.any(Function) });
  });

  it("never attempts the cloud engine before consent is given", () => {
    const localEngine = new ControlledEngine();
    mockCreateEngine.mockReturnValue(localEngine);

    render(<TranscriptionAdapter initialLanguages={[]} microphoneFactory={fakeMicrophone} />);
    fireEvent.click(screen.getByRole("button", { name: "Use cloud transcription" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    selectEnglishAndStart();

    expect(mockCreateEngine).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "cloud" }));
  });

  it("shows a visible error and stays stopped when the cloud engine fails to open, without silently falling back to another provider", async () => {
    const localEngine = new ControlledEngine();
    const cloudEngine = new ControlledEngine();
    cloudEngine.open.mockRejectedValueOnce(new Error("cloud transcription requires explicit user consent"));
    mockCreateEngine.mockImplementation(({ kind }) => (kind === "cloud" ? cloudEngine : localEngine));

    render(<TranscriptionAdapter initialLanguages={[]} microphoneFactory={fakeMicrophone} websocketUrl="wss://api.test/transcribe" />);
    fireEvent.click(screen.getByRole("button", { name: "Use cloud transcription" }));
    fireEvent.click(screen.getByRole("button", { name: "I consent to cloud transcription" }));
    selectEnglishAndStart();

    expect(await screen.findByRole("alert")).toHaveTextContent("cloud transcription requires explicit user consent");
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
    expect(localEngine.open).not.toHaveBeenCalled();
    expect(mockCreateEngine).toHaveBeenCalledTimes(1);
  });
});
