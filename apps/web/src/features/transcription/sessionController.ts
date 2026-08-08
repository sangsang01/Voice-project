import type { EngineEvent, PcmFrame, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import type { MicrophoneCapture } from "./audio/microphone";
import { startMicrophoneCapture } from "./audio/microphone";
import type { SessionAction } from "./sessionReducer";

export interface MicrophoneStartOptions { onFrame(frame: PcmFrame): void; signal: AbortSignal; }
export type MicrophoneFactory = (options: MicrophoneStartOptions) => Promise<MicrophoneCapture>;
export type EngineFactory = () => TranscriptionEngine;

export interface SessionControllerOptions {
  dispatch(action: SessionAction): void;
  engineFactory?: EngineFactory;
  microphoneFactory?: MicrophoneFactory;
  onLocalError?(message: string): void;
  onBackpressureWarning?(message: string): void;
}

interface ActiveSession {
  readonly id: string;
  readonly engine: TranscriptionEngine;
  readonly session: TranscriptionSession;
  readonly abortController: AbortController;
  microphone?: MicrophoneCapture;
  unsubscribe?: () => void;
  readonly queuedFrames: PcmFrame[];
}

const AUDIO = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 } as const;

export class SessionController {
  private readonly dispatch: (action: SessionAction) => void;
  private readonly engineFactory: EngineFactory;
  private readonly microphoneFactory: MicrophoneFactory;
  private readonly onLocalError: (message: string) => void;
  private readonly onBackpressureWarning: (message: string) => void;
  private active: ActiveSession | undefined;
  // Kept across start/stop cycles: engine.prepare() is idempotent once already
  // prepared, so reusing the same engine means the model only ever loads once
  // per page session instead of being reloaded from scratch on every recording.
  // Only torn down by dispose() (unmount) or resetEngine() (engine kind switch).
  private engine: TranscriptionEngine | undefined;
  // Bumped by stop()/clear() so a startWithId() call already in flight (e.g. still
  // downloading the model) can detect it was cancelled and discard its result
  // instead of silently becoming the active session after the user gave up on it.
  private startToken = 0;

  public constructor(options: SessionControllerOptions) {
    this.dispatch = options.dispatch;
    this.engineFactory = options.engineFactory ?? (() => new LocalWhisperEngine());
    this.microphoneFactory = options.microphoneFactory ?? startMicrophoneCapture;
    this.onLocalError = options.onLocalError ?? (() => undefined);
    this.onBackpressureWarning = options.onBackpressureWarning ?? (() => undefined);
  }

  public async start(candidateLanguages: readonly string[]): Promise<string> {
    return this.startWithId(candidateLanguages, crypto.randomUUID());
  }

  public async stop(): Promise<void> {
    this.startToken += 1;
    const active = this.active;
    if (!active) return;
    try { await active.session.stop(); }
    finally {
      if (this.active === active) this.active = undefined;
      await this.release(active, false);
    }
  }

  public async clearAndRestart(candidateLanguages: readonly string[]): Promise<string> {
    const nextSessionId = crypto.randomUUID();
    await this.clear(nextSessionId);
    return this.startWithId(candidateLanguages, nextSessionId);
  }

  public async clear(nextSessionId: string = crypto.randomUUID()): Promise<void> {
    this.startToken += 1;
    const active = this.active;
    // Invalidate before cancellation so late engine events cannot re-populate the cleared transcript.
    this.active = undefined;
    this.dispatch({ type: "clear", nextSessionId });
    if (active) await this.release(active, true);
  }

  public async dispose(): Promise<void> {
    await this.clear();
    await this.dropEngine();
  }

  /** Discards the cached engine so the next start() builds a fresh one -- call when switching between local/cloud. */
  public async resetEngine(): Promise<void> {
    await this.dropEngine();
  }

  private async dropEngine(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    this.engine = undefined;
    await engine.dispose();
  }

  private async startWithId(candidateLanguages: readonly string[], sessionId: string): Promise<string> {
    await this.clear(sessionId);
    const token = ++this.startToken;
    const request: SessionRequest = { sessionId, candidateLanguages: candidateLanguages as SessionRequest["candidateLanguages"], mode: "transcribe", audio: AUDIO };
    const engine = this.engine ?? this.engineFactory();
    this.engine = engine;
    const abortController = new AbortController();
    let active: ActiveSession | undefined;
    try {
      await engine.prepare(request);
      if (token !== this.startToken) {
        // stop()/clear() ran while the model was still loading; don't open a session or
        // request the microphone for a start the user already cancelled. The in-flight
        // prepare() can't safely be left running for a later start to reuse (a concurrent
        // prepare() on the same engine would race), so this attempt is discarded.
        if (this.engine === engine) this.engine = undefined;
        await engine.dispose();
        return sessionId;
      }
      const session = await engine.open(request);
      if (token !== this.startToken) {
        if (this.engine === engine) this.engine = undefined;
        abortController.abort();
        await session.cancel().catch(() => undefined);
        await engine.dispose();
        return sessionId;
      }
      active = { id: sessionId, engine, session, abortController, queuedFrames: [] };
      this.active = active;
      active.unsubscribe = session.subscribe((event) => this.handleEvent(active!, event));
      active.microphone = await this.microphoneFactory({ signal: abortController.signal, onFrame: (frame) => this.pushFrame(active!, frame) });
      return sessionId;
    } catch (error) {
      if (this.active === active) this.active = undefined;
      this.onLocalError(error instanceof Error ? error.message : "Local transcription is unavailable");
      abortController.abort();
      if (active) {
        // engine.open() already succeeded and only the microphone failed afterward --
        // the engine itself is presumably fine, so keep it cached for the next start().
        await this.release(active, true);
      } else {
        // prepare()/open() itself failed -- the engine may be broken, don't cache it.
        if (this.engine === engine) this.engine = undefined;
        await engine.dispose();
      }
      throw error;
    }
  }

  private handleEvent(active: ActiveSession, event: EngineEvent): void {
    if (this.active === active && event.sessionId === active.id) this.dispatch(event);
  }

  private pushFrame(active: ActiveSession, frame: PcmFrame): void {
    if (this.active !== active) return;
    active.queuedFrames.push(frame);
    while (active.queuedFrames.length > 0) {
      const result = active.session.push(active.queuedFrames[0]);
      if (result.accepted) { active.queuedFrames.shift(); continue; }
      active.queuedFrames.shift();
      this.onBackpressureWarning("Audio is arriving faster than the local model can process it; the oldest queued frame was dropped.");
      break;
    }
  }

  // Tears down the session (mic, subscription, socket/worker session) but deliberately
  // leaves the engine itself alone -- it's cached on `this.engine` for reuse by the next
  // start() so a prepared model doesn't reload on every single recording.
  private async release(active: ActiveSession, cancel: boolean): Promise<void> {
    try {
      active.abortController.abort();
      if (cancel) await active.session.cancel();
    } finally {
      try { await active.microphone?.stop(); }
      finally { active.unsubscribe?.(); }
    }
  }
}
