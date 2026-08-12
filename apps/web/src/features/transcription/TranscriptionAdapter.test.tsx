import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  EngineEvent,
  EngineEventListener,
  EngineInspection,
  PcmFrame,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";
import { describe, expect, it, vi } from "vitest";

const defaultLocalEngine = vi.hoisted(() => ({
  created: 0,
  onProgress: undefined as ((progress: number) => void) | undefined,
  onProgressCallbacks: [] as Array<((progress: number) => void) | undefined>,
  inspect: vi.fn(async () => ({ available: true })),
  prepare: vi.fn(async () => undefined),
  open: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

const defaultRemoteEngine = vi.hoisted(() => ({
  created: 0,
  options: [] as Array<{ endpoint: string; tokenProvider?: () => Promise<string> | string }>,
  inspect: vi.fn(async () => ({ available: true })),
  prepare: vi.fn(async () => undefined),
  open: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("@voice/local-whisper-engine", () => ({
  LocalWhisperEngine: class {
    public readonly inspect = defaultLocalEngine.inspect;
    public readonly prepare = defaultLocalEngine.prepare;
    public readonly open = defaultLocalEngine.open;
    public readonly dispose = defaultLocalEngine.dispose;

    public constructor(options: { onProgress?: (progress: number) => void } = {}) {
      defaultLocalEngine.created += 1;
      defaultLocalEngine.onProgress = options.onProgress;
      defaultLocalEngine.onProgressCallbacks.push(options.onProgress);
    }
  },
}));

vi.mock("@voice/remote-whisper-engine", () => ({
  RemoteWhisperEngine: class {
    public readonly inspect = defaultRemoteEngine.inspect;
    public readonly prepare = defaultRemoteEngine.prepare;
    public readonly open = defaultRemoteEngine.open;
    public readonly dispose = defaultRemoteEngine.dispose;

    public constructor(options: { endpoint: string; tokenProvider?: () => Promise<string> | string }) {
      defaultRemoteEngine.created += 1;
      defaultRemoteEngine.options.push(options);
    }
  },
}));
import { TranscriptionAdapter } from "./TranscriptionAdapter";

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
  public readonly inspect = vi.fn<() => Promise<EngineInspection>>(async () => ({ available: true }));
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
    expect(engine.inspect).toHaveBeenCalledTimes(2);
    expect(engine.prepare).toHaveBeenCalledTimes(2);
    expect(engine.dispose).not.toHaveBeenCalled();
  });

  it("shows model preparation while a local model load remains pending", async () => {
    const engine = new ControlledEngine();
    engine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    renderAdapter({ engine });

    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Preparing local model…")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("renders progress reported by the default local engine", async () => {
    defaultLocalEngine.inspect.mockResolvedValue({ available: true });
    defaultLocalEngine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    render(<TranscriptionAdapter initialLanguages={["en-US"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Preparing");
    await waitFor(() => expect(defaultLocalEngine.onProgress).toEqual(expect.any(Function)));
    act(() => defaultLocalEngine.onProgress?.(0.42));

    expect(await screen.findByText("Preparing local model 42%")).toBeVisible();
    const progress = screen.getByRole("progressbar", { name: "Local model preparation" });
    expect(progress).toHaveAttribute("value", "0.42");
    expect(progress.closest(".transcript")).toBeNull();
  });

  it("keeps the latest model load visible when an older run settles", async () => {
    defaultLocalEngine.created = 0;
    defaultLocalEngine.inspect.mockReset();
    defaultLocalEngine.prepare.mockReset();
    defaultLocalEngine.open.mockReset();
    defaultLocalEngine.dispose.mockReset();
    defaultLocalEngine.inspect.mockResolvedValue({ available: true });
    let resolveFirstPrepare: () => void = () => undefined;
    defaultLocalEngine.prepare
      .mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveFirstPrepare = () => resolve(undefined); }))
      .mockImplementationOnce(() => new Promise<never>(() => undefined));
    render(<TranscriptionAdapter initialLanguages={["en-US"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(defaultLocalEngine.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Clear & Restart" }));
    await waitFor(() => expect(defaultLocalEngine.prepare).toHaveBeenCalledTimes(2));
    expect(defaultLocalEngine.created).toBe(2);
    act(() => defaultLocalEngine.onProgress?.(0.42));
    expect(await screen.findByText("Preparing local model 42%")).toBeVisible();

    resolveFirstPrepare();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Preparing");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
      expect(screen.getByText("Preparing local model 42%")).toBeVisible();
    });
  });

  it("ignores progress emitted by a superseded local engine", async () => {
    defaultLocalEngine.created = 0;
    defaultLocalEngine.onProgressCallbacks = [];
    defaultLocalEngine.inspect.mockReset();
    defaultLocalEngine.prepare.mockReset();
    defaultLocalEngine.open.mockReset();
    defaultLocalEngine.dispose.mockReset();
    defaultLocalEngine.inspect.mockResolvedValue({ available: true });
    defaultLocalEngine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    render(<TranscriptionAdapter initialLanguages={["en-US"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(defaultLocalEngine.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Clear & Restart" }));
    await waitFor(() => expect(defaultLocalEngine.prepare).toHaveBeenCalledTimes(2));
    expect(defaultLocalEngine.onProgressCallbacks).toHaveLength(2);

    act(() => defaultLocalEngine.onProgressCallbacks[1]?.(0.42));
    expect(await screen.findByText("Preparing local model 42%")).toBeVisible();
    act(() => defaultLocalEngine.onProgressCallbacks[0]?.(0.9));
    expect(screen.getByText("Preparing local model 42%")).toBeVisible();
  });

  it("surfaces unsupported local capabilities without preparing or opening an engine", async () => {
    const engine = new ControlledEngine();
    engine.inspect.mockResolvedValue({
      available: false,
      reason: "Local transcription needs cross-origin isolation. Serve this page with the COOP and COEP headers.",
    });
    engine.prepare.mockImplementation(async () => { throw new Error("prepare must not run"); });
    engine.open.mockImplementation(async () => { throw new Error("open must not run"); });
    renderAdapter({ engine });

    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("cross-origin isolation");
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
    expect(engine.inspect).toHaveBeenCalledTimes(1);
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(engine.open).not.toHaveBeenCalled();
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

  it("defaults to RemoteWhisperEngine and Online real-time when the websocket URL is configured", async () => {
    vi.stubEnv("VITE_TRANSCRIPTION_WS_URL", "wss://transcription.example/ws");
    defaultLocalEngine.created = 0;
    defaultRemoteEngine.created = 0;
    defaultRemoteEngine.options = [];
    defaultRemoteEngine.inspect.mockResolvedValue({ available: true });
    defaultRemoteEngine.prepare.mockResolvedValue(undefined);
    defaultRemoteEngine.open.mockImplementation(async () => {
      throw new Error("open should not be required for this construction check");
    });
    defaultRemoteEngine.dispose.mockResolvedValue(undefined);

    render(<TranscriptionAdapter initialLanguages={["en-US"]} microphoneFactory={async () => ({ stop: vi.fn(async () => undefined) })} />);

    expect(screen.getByRole("button", { name: "Online real-time" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Offline local" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(defaultRemoteEngine.created).toBe(1));
    expect(defaultRemoteEngine.options[0]?.endpoint).toBe("wss://transcription.example/ws");
    expect(defaultLocalEngine.created).toBe(0);
    vi.unstubAllEnvs();
  });

  it("lets the mode control switch to Offline local and rebuilds the engine", async () => {
    vi.stubEnv("VITE_TRANSCRIPTION_WS_URL", "wss://transcription.example/ws");
    defaultLocalEngine.created = 0;
    defaultRemoteEngine.created = 0;
    defaultLocalEngine.inspect.mockResolvedValue({ available: true });
    defaultLocalEngine.prepare.mockImplementation(() => new Promise<never>(() => undefined));
    defaultRemoteEngine.inspect.mockResolvedValue({ available: true });
    defaultRemoteEngine.prepare.mockImplementation(() => new Promise<never>(() => undefined));

    render(<TranscriptionAdapter initialLanguages={["en-US"]} microphoneFactory={async () => ({ stop: vi.fn(async () => undefined) })} />);

    fireEvent.click(screen.getByRole("button", { name: "Offline local" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Offline local" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Online real-time" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(defaultLocalEngine.created).toBe(1));
    expect(defaultRemoteEngine.created).toBe(0);
    vi.unstubAllEnvs();
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

    const provisional = await screen.findByText("Hello");
    const provisionalSegment = provisional.closest("p");
    expect(provisionalSegment).toHaveClass("transcript-segment--provisional");
    expect(provisionalSegment).toHaveAttribute("data-final", "false");
    expect(provisionalSegment).toHaveTextContent("Updating");
    expect(document.querySelector(".transcript")).toHaveAttribute("aria-live", "off");
    const politeRegion = document.querySelector(".visually-hidden[aria-live='polite']");
    expect(politeRegion).not.toBeNull();
    expect(politeRegion).not.toHaveTextContent("Hello");

    engine.session.emit({
      type: "segment.upsert", sequence: 3, segment: {
        id: "s1", ordinal: 1, revision: 2, startMs: 0, endMs: 300, text: "Hello world", language: { tag: "en-US" }, isFinal: true,
      },
    });

    await waitFor(() => {
      expect(document.querySelectorAll(".transcript p[data-final='true']")).toHaveLength(1);
    });
    const finalSegment = document.querySelector(".transcript p[data-final='true']");
    expect(finalSegment).toHaveTextContent("Hello world");
    expect(finalSegment).toHaveTextContent("en-US");
    expect(finalSegment).not.toHaveClass("transcript-segment--provisional");
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    expect(screen.getAllByText("Hello world")).toHaveLength(2);
    expect(politeRegion).toHaveTextContent("Hello world");
  });

  it("warns on backpressure and ignores stale events after clear and restart", async () => {
    const engine = new ControlledEngine();
    const { emitFrame } = renderAdapter({ engine });
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalled());
    engine.session.rejectNextFrame = true;
    emitFrame(frame(0));
    expect(await screen.findByText(/Audio is arriving faster than the transcription service/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear & Restart" }));
    await waitFor(() => expect(engine.session.cancel).toHaveBeenCalled());
    engine.session.emit({
      type: "segment.upsert", sequence: 2, segment: {
        id: "stale", ordinal: 1, revision: 1, startMs: 0, endMs: 20, text: "stale", language: { tag: "en-US" }, isFinal: false,
      },
    });
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });

  it("shows local microphone failures", async () => {
    renderAdapter({ failMicrophone: true });
    fireEvent.click(screen.getByRole("button", { name: "English (US)" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone permission was denied");
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
  });

  it("constructs one engine and disposes it once when unmounted", async () => {
    const engine = new ControlledEngine();
    const factory = vi.fn(() => engine);
    const microphone = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));
    const view = render(<TranscriptionAdapter engineFactory={factory} microphoneFactory={microphone} initialLanguages={["en-US"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));
    expect(factory).toHaveBeenCalledTimes(1);

    view.unmount();
    await waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));
  });
});
