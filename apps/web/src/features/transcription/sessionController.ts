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
  readonly attempt: StartAttempt;
  readonly engine: TranscriptionEngine;
  readonly session: TranscriptionSession;
  readonly abortController: AbortController;
  microphone?: MicrophoneCapture;
  unsubscribe?: () => void;
  readonly queuedFrames: PcmFrame[];
  release?: Promise<void>;
  retiringEvents?: "fatal-followup" | "stop";
  releaseFailureReported?: boolean;
  lateMicrophoneStop?: Promise<void>;
}

type ReleaseMode = "stop" | "cancel" | "already-terminal";
type AfterPublishFailureMode = "throw" | "aggregate";

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
  private readonly engineDisposalsByIdentity = new WeakMap<TranscriptionEngine, Promise<void>>();
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
    if (this.active === active) this.active = undefined;
    if (!active) {
      await this.releasing;
      return;
    }
    await this.release(active, "stop");
  }

  public async resetEngine(): Promise<void> {
    await this.stop();
    await this.dropEngine();
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

    // Microphone capture starts immediately, in parallel with model loading,
    // instead of waiting for it. Frames that arrive before a session exists are
    // buffered here and flushed once it opens. Starting capture only after the
    // model finished loading left the real audio graph's warm-up window racing
    // against the model-loading worker's heavy WASM computation, which could
    // leave the captured stream silent for the entire session.
    let microphoneClaimed = false;
    const pendingFrames: PcmFrame[] = [];
    let deliverFrame: (frame: PcmFrame) => void = (frame) => pendingFrames.push(frame);
    const startingMicrophone = new Promise<MicrophoneCapture>((resolve, reject) => {
      try {
        resolve(this.microphoneFactory({
          signal: abortController.signal,
          onFrame: (frame) => deliverFrame(frame),
        }));
      } catch (error) {
        reject(error);
      }
    });
    // Every operation is observed through both resolve and reject handlers, per
    // this file's established idiom, so a stale or failed capture never becomes
    // an unhandled rejection while other work is still in flight.
    void startingMicrophone.then(() => undefined, () => undefined);

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
      active = { id: attempt.sessionId, attempt, engine, session, abortController, queuedFrames: [] };
      this.active = active;
      active.unsubscribe = session.subscribe((event) => this.handleEvent(active!, event));
      if (!this.isCurrent(attempt) || this.active !== active) return attempt.sessionId;

      deliverFrame = (frame) => this.pushFrame(active!, frame);
      for (const frame of pendingFrames) this.pushFrame(active, frame);
      pendingFrames.length = 0;

      const microphone = await this.awaitAttempt(attempt, startingMicrophone);
      if (!this.isCurrent(attempt) || this.active !== active) {
        if (microphone) this.stopLateMicrophone(active, microphone);
        return attempt.sessionId;
      }
      active.microphone = microphone;
      microphoneClaimed = true;
      this.finishAttempt(attempt);
      return attempt.sessionId;
    } catch (error) {
      if (!this.isCurrent(attempt)) return attempt.sessionId;
      abortController.abort();
      let failure = error;
      if (active && this.active === active) {
        this.active = undefined;
        try { await this.release(active, "cancel"); }
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
      // A capture that resolves after every other path already returned (e.g. the
      // engine synchronously reporting a terminated session from subscribe, before
      // this attempt ever reached the point of adopting the microphone) would
      // otherwise leak a live microphone stream. stopLateMicrophone is idempotent,
      // so this never double-stops a capture already handled above.
      if (!microphoneClaimed) {
        const activeForCleanup = active;
        void startingMicrophone.then(
          (capture) => {
            if (!capture) return;
            if (activeForCleanup) this.stopLateMicrophone(activeForCleanup, capture);
            else void Promise.resolve(capture.stop()).catch(() => undefined);
          },
          () => undefined,
        );
      }
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
    const existing = this.engineDisposalsByIdentity.get(engine);
    if (existing) return existing;
    let disposal: Promise<void>;
    try { disposal = Promise.resolve(engine.dispose()); }
    catch (error) { disposal = Promise.reject(error); }
    this.engineDisposalsByIdentity.set(engine, disposal);
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
    if (event.sessionId !== active.id) return;

    if (this.active === active) {
      if (!this.isTerminalEvent(event)) {
        this.dispatch(event);
        return;
      }

      this.active = undefined;
      if (this.currentAttempt === active.attempt) {
        this.currentAttempt = undefined;
        active.attempt.cancel();
      }
      active.retiringEvents = event.type === "error" ? "fatal-followup" : undefined;
      void this.release(active, "already-terminal", () => this.dispatch(event));
      return;
    }

    // Some engines synchronously deliver fatal-error then stopped callbacks from
    // one terminal notification. Keep only that stopped follow-up dispatchable
    // while this exact session owns the in-flight terminal release.
    if (active.release === undefined || this.releasing !== active.release) return;

    if (active.retiringEvents === "stop") {
      this.dispatch(event);
      if (event.type === "state" && event.state === "stopped") {
        active.retiringEvents = undefined;
      }
      return;
    }

    if (
      active.retiringEvents === "fatal-followup"
      && event.type === "state"
      && event.state === "stopped"
    ) {
      active.retiringEvents = undefined;
      this.dispatch(event);
    }
  }

  private isTerminalEvent(event: EngineEvent): boolean {
    return (event.type === "error" && event.fatal)
      || (event.type === "state" && event.state === "stopped");
  }

  private observeTerminalRelease(active: ActiveSession, release: Promise<void>): void {
    void release.then(
      () => undefined,
      (error) => {
        if (active.releaseFailureReported) return;
        active.releaseFailureReported = true;
        try {
          this.onLocalError(error instanceof Error ? error.message : "Failed to release transcription capture");
        } catch {
          // A consumer callback must not turn an observed cleanup failure into an
          // unhandled rejection from this synchronous event bridge.
        }
      },
    );
  }

  private stopLateMicrophone(active: ActiveSession, microphone: MicrophoneCapture): void {
    if (active.lateMicrophoneStop) return;
    let stopping: Promise<void>;
    try {
      stopping = Promise.resolve(microphone.stop());
    } catch (error) {
      stopping = Promise.reject(error);
    }
    active.lateMicrophoneStop = stopping;
    this.observeTerminalRelease(active, stopping);
  }

  private startCleanup(operation: () => void | Promise<void>): Promise<void> {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private detach(active: ActiveSession): void {
    const unsubscribe = active.unsubscribe;
    active.unsubscribe = undefined;
    unsubscribe?.();
  }

  private pushFrame(active: ActiveSession, frame: PcmFrame): void {
    if (this.active !== active) return;
    active.queuedFrames.push(frame);
    while (active.queuedFrames.length > 0) {
      const result = active.session.push(active.queuedFrames[0]);
      if (result.accepted) { active.queuedFrames.shift(); continue; }
      active.queuedFrames.shift();
      this.onBackpressureWarning("Audio is arriving faster than the transcription service can process it; the oldest queued frame was dropped.");
      break;
    }
  }

  private async clearActive(nextSessionId: string = crypto.randomUUID()): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active) {
      await this.release(
        active,
        "cancel",
        () => this.dispatch({ type: "clear", nextSessionId }),
        "aggregate",
      );
      return;
    }
    const releasing = this.releasing;
    let dispatchFailed = false;
    let dispatchFailure: unknown;
    try {
      this.dispatch({ type: "clear", nextSessionId });
    } catch (error) {
      dispatchFailed = true;
      dispatchFailure = error;
    }
    let releaseFailed = false;
    let releaseFailure: unknown;
    try { await releasing; }
    catch (error) {
      releaseFailed = true;
      releaseFailure = error;
    }
    // The pending release is later in the cleanup order and retains the
    // established precedence over a clear-dispatch failure.
    if (releaseFailed) throw releaseFailure;
    if (dispatchFailed) throw dispatchFailure;
  }

  private dropEngine(): Promise<void> {
    const engine = this.engine;
    if (!engine) return Promise.resolve();
    this.engine = undefined;
    return this.startEngineDisposal(engine);
  }

  // Publish ownership before invoking engine or capture callbacks: either can
  // synchronously replay terminal events or trigger a concurrent controller call.
  // The first release mode wins and all later callers await this exact promise.
  private release(
    active: ActiveSession,
    mode: ReleaseMode,
    afterPublish?: () => void,
    afterPublishFailureMode: AfterPublishFailureMode = "throw",
  ): Promise<void> {
    if (!active.release) {
      let resolveRelease: () => void = () => undefined;
      let rejectRelease: (error: unknown) => void = () => undefined;
      const completion = new Promise<void>((resolve, reject) => {
        resolveRelease = resolve;
        rejectRelease = reject;
      });
      active.release = completion.finally(() => {
        active.retiringEvents = undefined;
        if (this.active === active) this.active = undefined;
        if (this.releasing === active.release) this.releasing = undefined;
      });
      this.releasing = active.release;
      if (mode === "already-terminal") this.observeTerminalRelease(active, active.release);
      let dispatchFailed = false;
      let dispatchFailure: unknown;
      let dispatching = Promise.resolve();
      try {
        afterPublish?.();
      } catch (error) {
        if (afterPublishFailureMode === "aggregate") {
          dispatching = Promise.reject(error);
        } else {
          dispatchFailed = true;
          dispatchFailure = error;
        }
      }

      if (mode === "stop") active.retiringEvents = "stop";
      active.queuedFrames.length = 0;
      const aborting = this.startCleanup(() => active.abortController.abort());
      const sessionOperation = mode === "stop"
        ? this.startCleanup(() => active.session.stop())
        : mode === "cancel"
          ? this.startCleanup(() => active.session.cancel())
          : Promise.resolve();
      const stoppingMicrophone = this.startCleanup(async () => {
        await active.microphone?.stop();
      });

      let detaching: Promise<void>;
      if (mode === "cancel") {
        detaching = this.startCleanup(() => this.detach(active));
      } else if (mode === "already-terminal") {
        // Let a synchronous fatal -> stopped callback pair finish, then detach
        // independently of a slow or hung microphone stop.
        detaching = Promise.resolve().then(() => this.detach(active));
      } else {
        detaching = Promise.resolve();
      }

      if (mode === "stop") {
        detaching = sessionOperation.then(
          () => this.detach(active),
          () => this.detach(active),
        );
      }

      // Match the established nested-finally precedence: every later cleanup
      // failure overrides an earlier one, while all operations still settle.
      void Promise.allSettled([dispatching, aborting, sessionOperation, stoppingMicrophone, detaching]).then((results) => {
        let failure: PromiseRejectedResult | undefined;
        for (const result of results) {
          if (result.status === "rejected") failure = result;
        }
        if (failure?.status === "rejected") rejectRelease(failure.reason);
        else resolveRelease();
      });
      if (dispatchFailed) throw dispatchFailure;
    } else {
      afterPublish?.();
    }
    return active.release;
  }
}
