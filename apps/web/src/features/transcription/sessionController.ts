import type { EngineEvent, PcmFrame, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import type { MicrophoneCapture } from "./audio/microphone";
import { startMicrophoneCapture } from "./audio/microphone";
import type { SessionAction } from "./sessionReducer";

export interface MicrophoneStartOptions { onFrame(frame: PcmFrame): void; signal: AbortSignal; }
export type MicrophoneFactory = (options: MicrophoneStartOptions) => Promise<MicrophoneCapture>;
export interface EngineFactoryOptions { onProgress?(progress: number): void; }
export type EngineFactory = (options?: EngineFactoryOptions) => TranscriptionEngine;

export interface SessionControllerOptions {
  dispatch(action: SessionAction): void;
  engineFactory?: EngineFactory;
  microphoneFactory?: MicrophoneFactory;
  onProgress?(progress: number): void;
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
  release?: Promise<void>;
}

interface StartAttempt {
  readonly sessionId: string;
  readonly cancelled: Promise<void>;
  cancel(): void;
  engine?: TranscriptionEngine;
  ownsPrivateEngine: boolean;
  publishedEngine: boolean;
  disposal?: Promise<void>;
}

type AttemptResult<T> =
  | { type: "value"; value: T }
  | { type: "error"; error: unknown }
  | { type: "cancelled" };

const AUDIO = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 } as const;

export class SessionController {
  private readonly dispatch: (action: SessionAction) => void;
  private readonly engineFactory: EngineFactory;
  private readonly microphoneFactory: MicrophoneFactory;
  private readonly onProgress: (progress: number) => void;
  private readonly onLocalError: (message: string) => void;
  private readonly onBackpressureWarning: (message: string) => void;
  private active: ActiveSession | undefined;
  // Only a successfully opened, current engine becomes the reusable cache. Engines
  // that are still inspecting/preparing belong solely to their start attempt.
  private engine: TranscriptionEngine | undefined;
  private currentAttempt: StartAttempt | undefined;
  private releasing: Promise<void> | undefined;
  private readonly engineDisposals = new Set<Promise<void>>();
  private readonly engineDisposalFailures: unknown[] = [];
  private cachedEngineDisposal: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private disposed = false;

  public constructor(options: SessionControllerOptions) {
    this.dispatch = options.dispatch;
    this.engineFactory = options.engineFactory ?? ((engineOptions) => new LocalWhisperEngine(engineOptions));
    this.microphoneFactory = options.microphoneFactory ?? startMicrophoneCapture;
    this.onProgress = options.onProgress ?? (() => undefined);
    this.onLocalError = options.onLocalError ?? (() => undefined);
    this.onBackpressureWarning = options.onBackpressureWarning ?? (() => undefined);
  }

  public async start(candidateLanguages: readonly string[]): Promise<string> {
    return this.beginStart(candidateLanguages, crypto.randomUUID());
  }

  public async stop(): Promise<void> {
    this.cancelCurrentAttempt();
    const active = this.active;
    if (!active) {
      await this.releasing;
      return;
    }
    try {
      await active.session.stop();
    } finally {
      if (this.active === active) this.active = undefined;
      await this.release(active, false);
    }
  }

  public async clearAndRestart(candidateLanguages: readonly string[]): Promise<string> {
    return this.beginStart(candidateLanguages, crypto.randomUUID());
  }

  public async clear(nextSessionId: string = crypto.randomUUID()): Promise<void> {
    this.cancelCurrentAttempt();
    await this.clearActive(nextSessionId);
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const attempt = this.cancelCurrentAttempt();
    this.disposal = (async () => {
      let failed = false;
      let failure: unknown;
      const recordFailure = (error: unknown) => {
        if (!failed) {
          failed = true;
          failure = error;
        }
      };
      try { await this.clearActive(); }
      catch (error) { recordFailure(error); }
      void this.disposePrivateEngine(attempt);
      void this.dropEngine();
      for (const error of await this.drainEngineDisposals()) recordFailure(error);
      if (failed) throw failure;
    })();
    return this.disposal;
  }

  private async beginStart(candidateLanguages: readonly string[], sessionId: string): Promise<string> {
    if (this.disposed) return sessionId;
    // Reserve before releasing the old session: a Stop/Dispose while release is
    // pending must cancel this replacement instead of letting it start afterward.
    const attempt = this.reserveAttempt(sessionId);
    try {
      await this.awaitAttempt(attempt, this.clearActive(sessionId));
    } catch (error) {
      if (!this.isCurrent(attempt)) return sessionId;
      this.failAttempt(attempt, error);
      throw error;
    }
    if (!this.isCurrent(attempt)) return sessionId;
    return this.runAttempt(attempt, candidateLanguages);
  }

  private async runAttempt(attempt: StartAttempt, candidateLanguages: readonly string[]): Promise<string> {
    if (!this.isCurrent(attempt)) return attempt.sessionId;
    const request: SessionRequest = {
      sessionId: attempt.sessionId,
      candidateLanguages: candidateLanguages as SessionRequest["candidateLanguages"],
      mode: "transcribe",
      audio: AUDIO,
    };
    const abortController = new AbortController();
    const cachedEngine = this.engine;
    let engine: TranscriptionEngine | undefined;
    let active: ActiveSession | undefined;

    try {
      engine = cachedEngine;
      if (!engine) {
        const progressSource: { engine?: TranscriptionEngine } = {};
        engine = this.engineFactory({
          onProgress: (progress) => {
            if (progressSource.engine) this.reportProgress(progressSource.engine, progress);
          },
        });
        progressSource.engine = engine;
      }
      attempt.engine = engine;
      attempt.ownsPrivateEngine = cachedEngine === undefined;
      attempt.publishedEngine = cachedEngine !== undefined;

      const inspection = await this.awaitAttempt(attempt, Promise.resolve(engine.inspect()));
      if (!this.isCurrent(attempt) || inspection === undefined) return attempt.sessionId;
      if (!inspection.available) throw new Error(inspection.reason ?? "Local transcription is unavailable");

      await this.awaitAttempt(attempt, Promise.resolve(engine.prepare(request)));
      if (!this.isCurrent(attempt)) return attempt.sessionId;

      const opening = Promise.resolve(engine.open(request));
      void opening.then(
        (session) => { if (!this.isCurrent(attempt)) void session.cancel().catch(() => undefined); },
        () => undefined,
      );
      const session = await this.awaitAttempt(attempt, opening);
      if (!this.isCurrent(attempt) || session === undefined) {
        abortController.abort();
        return attempt.sessionId;
      }

      // An opened session proves this engine is usable and can now be cached. This
      // assignment is guarded by isCurrent above, so a stale attempt cannot publish.
      this.engine = engine;
      attempt.publishedEngine = true;
      active = { id: attempt.sessionId, engine, session, abortController, queuedFrames: [] };
      this.active = active;
      active.unsubscribe = session.subscribe((event) => this.handleEvent(active!, event));

      const startingMicrophone = Promise.resolve(this.microphoneFactory({
        signal: abortController.signal,
        onFrame: (frame) => this.pushFrame(active!, frame),
      }));
      void startingMicrophone.then(
        (capture) => { if (!this.isCurrent(attempt)) void capture.stop().catch(() => undefined); },
        () => undefined,
      );
      const microphone = await this.awaitAttempt(attempt, startingMicrophone);
      if (!this.isCurrent(attempt)) return attempt.sessionId;
      active.microphone = microphone;
      this.finishAttempt(attempt);
      return attempt.sessionId;
    } catch (error) {
      if (!this.isCurrent(attempt)) return attempt.sessionId;
      abortController.abort();
      let failure = error;
      if (active && this.active === active) {
        this.active = undefined;
        try { await this.release(active, true); }
        catch (cleanupError) { failure = cleanupError; }
      } else if (engine && this.engine === engine) {
        // A previously cached engine that now fails inspection, preparation, or
        // open is no longer usable; evict only this exact current cache entry.
        try { await this.dropEngine(); }
        catch (cleanupError) { failure = cleanupError; }
      }
      if (!this.isCurrent(attempt)) return attempt.sessionId;
      this.failAttempt(attempt, failure);
      throw failure;
    } finally {
      if (!this.isCurrent(attempt)) void this.disposePrivateEngine(attempt);
    }
  }

  private reserveAttempt(sessionId: string): StartAttempt {
    this.cancelCurrentAttempt();
    let resolveCancelled: () => void = () => undefined;
    const attempt: StartAttempt = {
      sessionId,
      cancelled: new Promise<void>((resolve) => { resolveCancelled = resolve; }),
      cancel: () => resolveCancelled(),
      ownsPrivateEngine: false,
      publishedEngine: false,
    };
    this.currentAttempt = attempt;
    return attempt;
  }

  private cancelCurrentAttempt(): StartAttempt | undefined {
    const attempt = this.currentAttempt;
    if (!attempt) return undefined;
    this.currentAttempt = undefined;
    attempt.cancel();
    void this.disposePrivateEngine(attempt);
    return attempt;
  }

  private finishAttempt(attempt: StartAttempt): void {
    if (this.currentAttempt === attempt) this.currentAttempt = undefined;
  }

  private isCurrent(attempt: StartAttempt): boolean {
    return !this.disposed && this.currentAttempt === attempt;
  }

  // Every operation is observed through both resolve and reject handlers. If
  // cancellation wins the race, a later rejection remains handled rather than
  // becoming an unhandled promise rejection.
  private async awaitAttempt<T>(attempt: StartAttempt, operation: Promise<T>): Promise<T | undefined> {
    const result = await Promise.race<AttemptResult<T>>([
      operation.then(
        (value) => ({ type: "value", value } as AttemptResult<T>),
        (error) => ({ type: "error", error } as AttemptResult<T>),
      ),
      attempt.cancelled.then(() => ({ type: "cancelled" } as AttemptResult<T>)),
    ]);
    if (result.type === "cancelled") return undefined;
    if (result.type === "error") throw result.error;
    return result.value;
  }

  private disposePrivateEngine(attempt: StartAttempt | undefined): Promise<void> | undefined {
    if (!attempt || !attempt.ownsPrivateEngine || attempt.publishedEngine || !attempt.engine) return undefined;
    if (!attempt.disposal) {
      const disposal = this.startEngineDisposal(attempt.engine);
      attempt.disposal = disposal;
    }
    return attempt.disposal;
  }

  private startEngineDisposal(engine: TranscriptionEngine): Promise<void> {
    let disposal: Promise<void>;
    try { disposal = Promise.resolve(engine.dispose()); }
    catch (error) { disposal = Promise.reject(error); }
    this.engineDisposals.add(disposal);
    void disposal.then(
      () => { this.engineDisposals.delete(disposal); },
      (error) => {
        this.engineDisposalFailures.push(error);
        this.engineDisposals.delete(disposal);
      },
    );
    return disposal;
  }

  private async drainEngineDisposals(): Promise<readonly unknown[]> {
    while (this.engineDisposals.size > 0) await Promise.allSettled(this.engineDisposals);
    return this.engineDisposalFailures;
  }

  private reportProgress(engine: TranscriptionEngine, progress: number): void {
    const attempt = this.currentAttempt;
    if (attempt?.engine === engine && this.isCurrent(attempt)) this.onProgress(progress);
  }

  private failAttempt(attempt: StartAttempt, error: unknown): void {
    if (this.currentAttempt === attempt) this.currentAttempt = undefined;
    void this.disposePrivateEngine(attempt);
    this.onLocalError(error instanceof Error ? error.message : "Local transcription is unavailable");
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

  private async clearActive(nextSessionId: string = crypto.randomUUID()): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.dispatch({ type: "clear", nextSessionId });
    if (active) await this.release(active, true);
    else await this.releasing;
  }

  private dropEngine(): Promise<void> {
    if (this.cachedEngineDisposal) return this.cachedEngineDisposal;
    const engine = this.engine;
    if (!engine) return Promise.resolve();
    this.engine = undefined;
    const disposal = this.startEngineDisposal(engine);
    this.cachedEngineDisposal = disposal;
    void disposal.then(
      () => { if (this.cachedEngineDisposal === disposal) this.cachedEngineDisposal = undefined; },
      () => { if (this.cachedEngineDisposal === disposal) this.cachedEngineDisposal = undefined; },
    );
    return disposal;
  }

  // Teardown is shared by concurrent stop/clear/dispose calls. The first caller's
  // cancellation mode wins, and every caller awaits the same cleanup promise.
  private release(active: ActiveSession, cancel: boolean): Promise<void> {
    if (!active.release) {
      const releasing = (async () => {
        try {
          active.abortController.abort();
          if (cancel) await active.session.cancel();
        } finally {
          try { await active.microphone?.stop(); }
          finally { active.unsubscribe?.(); }
        }
      })();
      active.release = releasing.finally(() => {
        if (this.releasing === active.release) this.releasing = undefined;
      });
      this.releasing = active.release;
    }
    return active.release;
  }
}
