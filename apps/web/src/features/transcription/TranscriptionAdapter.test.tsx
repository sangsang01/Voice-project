import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  EngineEvent,
  EngineEventListener,
  EngineInspection,
  PcmFrame,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const defaultLocalEngine = vi.hoisted(() => ({
  created: 0,
  onProgress: undefined as ((progress: number) => void) | undefined,
  onProgressCallbacks: [] as Array<((progress: number) => void) | undefined>,
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

const defaultRemoteEngine = vi.hoisted(() => ({
  created: 0,
  endpoints: [] as string[],
  inspect: vi.fn(async () => ({ available: true })),
  prepare: vi.fn(async () => undefined),
  open: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("@voice/remote-whisper-engine", () => ({
  RemoteWhisperEngine: class {
    public readonly inspect = defaultRemoteEngine.inspect;
    public readonly prepare = defaultRemoteEngine.prepare;
    public readonly open = defaultRemoteEngine.open;
    public readonly dispose = defaultRemoteEngine.dispose;

    public constructor(options: { endpoint: string }) {
      defaultRemoteEngine.created += 1;
      defaultRemoteEngine.endpoints.push(options.endpoint);
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers English, Vietnamese, and Spanish in a language dropdown", () => {
    renderAdapter();

    const language = screen.getByRole("combobox", { name: "Language" });
    expect(language).toHaveValue("en-US");
    expect(within(language).getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(within(language).getByRole("option", { name: "Vietnamese" })).toBeInTheDocument();
    expect(within(language).getByRole("option", { name: "Spanish" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Chinese" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "English (US)" })).not.toBeInTheDocument();
  });

  it("starts with the selected language as the only candidate", async () => {
    const { engine } = renderAdapter();

    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "vi-VN" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));
    expect(engine.open.mock.calls[0]?.[0].candidateLanguages).toEqual(["vi-VN"]);
  });

  it("does not offer Live or Offline mode controls and always uses the remote engine", async () => {
    defaultLocalEngine.created = 0;
    defaultRemoteEngine.created = 0;
    defaultRemoteEngine.endpoints = [];
    vi.stubEnv("VITE_TRANSCRIPTION_WS_URL", "ws://127.0.0.1:8787");
    render(<TranscriptionAdapter initialLanguages={["en-US"]} />);

    expect(screen.queryByRole("button", { name: "Live (this PC)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Offline local" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(defaultRemoteEngine.created).toBe(1));
    expect(defaultLocalEngine.created).toBe(0);
    expect(defaultRemoteEngine.endpoints).toEqual(["ws://127.0.0.1:8787"]);
  });

  it("requests microphone permission alongside model preparation and drains on stop", async () => {
    const { engine, microphone } = renderAdapter();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));
    expect(microphone).toHaveBeenCalledTimes(1);
    // Capture starts in parallel with (not after) model preparation, so its real
    // audio graph is already warm by the time the session opens instead of racing
    // the model-loading worker's heavy WASM computation.
    expect(microphone.mock.invocationCallOrder[0]).toBeLessThan(engine.open.mock.invocationCallOrder[0]);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(engine.session.stop).toHaveBeenCalledTimes(1));
  });

  it("reuses the same engine across stop and start instead of reloading the model on every recording", async () => {
    const engine = new ControlledEngine();
    const factory = vi.fn(() => engine);
    const microphone = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));
    render(<TranscriptionAdapter engineFactory={factory} microphoneFactory={microphone} initialLanguages={[]} />);

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

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Preparing local model…")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Preparing local model…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
    expect(screen.queryByText("Preparing local model…")).not.toBeInTheDocument();

    resolvePrepare();
    await waitFor(() => expect(engine.dispose).toHaveBeenCalled());
    expect(engine.open).not.toHaveBeenCalled();
    // Capture now starts eagerly, in parallel with model preparation, rather than
    // waiting for it; stopping while still preparing must tear that capture down
    // instead of leaving it live and unused.
    expect(microphone).toHaveBeenCalledTimes(1);
    const capture = await microphone.mock.results[0]!.value;
    await waitFor(() => expect(capture.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Standby");
  });

  it("renders provisional and final segments with language badges and model progress", async () => {
    const { engine } = renderAdapter();
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

    const transcript = document.querySelector(".transcript") as HTMLElement;
    expect(await within(transcript).findByText("Hello world")).toBeVisible();
    expect(within(transcript).getByText("English")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Listening");

    engine.session.emit({
      type: "segment.upsert", sequence: 4, segment: {
        id: "s2", ordinal: 2, revision: 1, startMs: 400, endMs: 700, text: "Xin chào", language: { tag: "vi-VN" }, isFinal: true,
      },
    });
    engine.session.emit({
      type: "segment.upsert", sequence: 5, segment: {
        id: "s3", ordinal: 3, revision: 1, startMs: 700, endMs: 900, text: "?", language: { tag: "und" }, isFinal: true,
      },
    });
    expect(await within(transcript).findByText("Vietnamese")).toBeVisible();
    expect(within(transcript).queryByText("und")).not.toBeInTheDocument();
  });

  it("warns on backpressure and ignores stale events after clear and restart", async () => {
    const engine = new ControlledEngine();
    const { emitFrame } = renderAdapter({ engine });
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

  it("shows local microphone failures", async () => {
    renderAdapter({ failMicrophone: true });
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

  it("starts a live session after React Strict Mode remounts the adapter", async () => {
    const engine = new ControlledEngine();
    const factory = vi.fn(() => engine);
    const microphone = vi.fn(async () => ({ stop: vi.fn(async () => undefined) }));
    render(
      <StrictMode>
        <TranscriptionAdapter engineFactory={factory} microphoneFactory={microphone} initialLanguages={["en-US"]} />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("Listening");
    expect(screen.getByText("Hearing you… captions will appear here.")).toBeInTheDocument();
  });

  it("replaces a provisional caption in place and keeps finalized text in a polite live region", async () => {
    const { engine } = renderAdapter();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(engine.open).toHaveBeenCalled());

    engine.session.emit({
      type: "segment.upsert", sequence: 1, segment: {
        id: "caption-1", ordinal: 1, revision: 0, startMs: 0, endMs: 200, text: "Hello", language: { tag: "en-US" }, isFinal: false,
      },
    });

    const transcript = document.querySelector(".transcript");
    expect(transcript).toHaveAttribute("aria-live", "off");
    const provisional = await waitFor(() => {
      const paragraph = transcript?.querySelector("p");
      expect(paragraph).toHaveClass("transcript-segment--provisional");
      return paragraph as HTMLElement;
    });
    expect(provisional).toHaveAttribute("data-final", "false");
    expect(provisional).toHaveTextContent("Hello");
    expect(provisional.querySelector(".transcript-updating")).toBeNull();
    expect(provisional).not.toHaveTextContent("…");
    const liveRegion = document.querySelector(".visually-hidden");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).not.toHaveTextContent("Hello");

    engine.session.emit({
      type: "segment.upsert", sequence: 2, segment: {
        id: "caption-1", ordinal: 1, revision: 1, startMs: 0, endMs: 300, text: "Hello world", language: { tag: "en-US" }, isFinal: true,
      },
    });

    await waitFor(() => {
      expect(transcript?.querySelectorAll("[data-final]")).toHaveLength(1);
      expect(transcript?.querySelector("p")).toHaveAttribute("data-final", "true");
    });
    const finalParagraph = transcript?.querySelector("p");
    expect(finalParagraph).toHaveAttribute("data-final", "true");
    expect(finalParagraph).toHaveTextContent("Hello world");
    expect(finalParagraph).not.toHaveClass("transcript-segment--provisional");
    expect(screen.queryByText(/Updating/)).not.toBeInTheDocument();
    expect(liveRegion).toHaveTextContent("Hello world");
  });
});
