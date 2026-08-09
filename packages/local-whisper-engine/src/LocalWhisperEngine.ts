import type {
  EngineEvent,
  EngineEventListener,
  EngineInspection,
  PcmFrame,
  PushResult,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";
import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";

import { inspectLocalCapabilities } from "./browser/capabilities.js";
import type { MainToWorker, WorkerEvent } from "./worker/protocol.js";

export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MainToWorker, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface LocalWhisperEngineOptions {
  inferenceTimeoutMs?: number;
  maxBufferedFrames?: number;
  onProgress?: (progress: number) => void;
  workerFactory?: () => WorkerLike;
}

interface PendingPrepare {
  generation: number;
  requestId: number;
  worker: WorkerLike;
  resolve(): void;
  reject(error: Error): void;
}

interface InferenceWatchdog {
  generation: number;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  token: number;
  worker: WorkerLike;
}

class LocalSession implements TranscriptionSession {
  private readonly listeners = new Set<EngineEventListener>();
  private eventSequence = -1;
  private terminal = false;
  private closing = false;
  private stopping: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
  private buffered = 0;
  private subscribed = false;
  private readonly pendingEvents: EngineEvent[] = [];

  public constructor(
    private readonly request: SessionRequest,
    private readonly worker: WorkerLike,
    private readonly maxBufferedFrames: number,
    private readonly onWorkerFailure: (error: unknown) => Error,
  ) {}

  public push(frame: PcmFrame): PushResult {
    if (this.terminal || this.closing || this.buffered >= this.maxBufferedFrames) return { accepted: false, reason: "backpressure" };
    const valid = validatePcmFrame(frame);
    const samples = valid.samples.slice();
    try {
      this.worker.postMessage({ type: "push", sessionId: this.request.sessionId, frame: { ...valid, samples } }, [samples.buffer]);
    } catch (error) {
      this.onWorkerFailure(error);
      return { accepted: false, reason: "backpressure" };
    }
    this.buffered += 1;
    return { accepted: true };
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.terminal) return Promise.resolve();
    this.closing = true;
    this.stopping = new Promise((resolve) => { this.resolveStop = resolve; });
    try {
      this.worker.postMessage({ type: "stop", sessionId: this.request.sessionId });
    } catch (error) {
      this.onWorkerFailure(error);
    }
    return this.stopping;
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    let failure: Error | undefined;
    try {
      this.worker.postMessage({ type: "cancel", sessionId: this.request.sessionId });
    } catch (error) {
      failure = this.onWorkerFailure(error);
    } finally {
      this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, state: "stopped" });
      this.resolveStop?.();
    }
    if (failure) throw failure;
  }

  public subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      for (const event of this.pendingEvents.splice(0)) this.notify(listener, event);
    }
    return () => this.listeners.delete(listener);
  }

  public receive(event: EngineEvent): void {
    if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.eventSequence) return;
    this.eventSequence = event.sequence;
    if (event.type === "state" && event.state === "stopped") {
      this.terminal = true;
      this.resolveStop?.();
    }
    this.emit(event);
  }

  public credit(frames: number): void {
    if (!this.terminal) this.buffered = Math.max(0, this.buffered - frames);
  }

  public fail(code: "INTERNAL" | "TIMEOUT", message: string): void {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    this.emit({ type: "error", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, code, fatal: true, message });
    this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, state: "stopped" });
    this.resolveStop?.();
  }

  public get isTerminal(): boolean {
    return this.terminal;
  }

  public get sessionId(): string {
    return this.request.sessionId;
  }

  private emit(event: EngineEvent): void {
    this.eventSequence = Math.max(this.eventSequence, event.sequence);
    if (!this.subscribed) {
      this.pendingEvents.push(event);
      return;
    }
    for (const listener of this.listeners) this.notify(listener, event);
  }

  private notify(listener: EngineEventListener, event: EngineEvent): void {
    try {
      listener(event);
    } catch {
      // Listener failures are deliberately isolated and swallowed: the engine
      // contract has no listener-error channel, and lifecycle cleanup must win.
    }
  }
}

export class LocalWhisperEngine implements TranscriptionEngine {
  private worker: WorkerLike | undefined;
  private prepared = false;
  private disposed = false;
  private requestId = 0;
  private workerGeneration = 0;
  private preparing: Promise<void> | undefined;
  private pendingPrepare: PendingPrepare | undefined;
  private inferenceWatchdog: InferenceWatchdog | undefined;
  private activeSession: LocalSession | undefined;

  public constructor(private readonly options: LocalWhisperEngineOptions = {}) {}

  public async inspect(): Promise<EngineInspection> {
    if (this.disposed) return { available: false, reason: "disposed" };
    const capabilities = inspectLocalCapabilities();
    return capabilities.supported ? { available: true } : { available: false, reason: capabilities.reason };
  }

  public async prepare(request: SessionRequest): Promise<void> {
    this.assertAvailable();
    validateSessionRequest(request);
    if (this.prepared) return;
    if (this.preparing) return this.preparing;

    const preparing = this.startWorker();
    this.preparing = preparing;
    try {
      await preparing;
    } finally {
      if (this.preparing === preparing) this.preparing = undefined;
    }
  }

  public async open(request: SessionRequest): Promise<TranscriptionSession> {
    this.assertAvailable();
    const valid = validateSessionRequest(request);
    if (!this.prepared || !this.worker) throw new Error("engine must be prepared before opening a session");
    if (this.activeSession && !this.activeSession.isTerminal) throw new Error("an active local Whisper session already exists");
    // Mirrors the worker's own cap (see localWhisper.worker.ts): ~60s of audio at
    // 20ms per frame, which is well above the 25s longest possible utterance.
    const worker = this.worker;
    const generation = this.workerGeneration;
    const session = new LocalSession(
      valid,
      worker,
      this.options.maxBufferedFrames ?? 3000,
      (error) => this.handleSessionPostFailure(worker, generation, error),
    );
    this.activeSession = session;
    try {
      worker.postMessage({ type: "open", request: valid });
    } catch (error) {
      throw this.handleSessionPostFailure(worker, generation, error);
    }
    return session;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.prepared = false;
    this.clearInferenceWatchdog();
    try {
      await this.activeSession?.cancel();
    } catch {
      // Worker teardown below is authoritative even if posting cancel failed.
    }
    this.activeSession = undefined;
    const worker = this.worker;
    if (worker) {
      try {
        worker.postMessage({ type: "dispose" });
      } catch {
        // A worker that is already failing still needs local teardown below.
      }
      worker.onmessage = null;
      worker.onerror = null;
      this.settlePrepare(worker, this.workerGeneration, new Error("engine is disposed"));
      this.worker = undefined;
      let terminationFailure: Error | undefined;
      try {
        worker.terminate();
      } catch (error) {
        terminationFailure = normalizeError(error, "failed to terminate local Whisper worker");
      }
      if (terminationFailure) {
        this.worker = undefined;
        this.preparing = undefined;
        throw terminationFailure;
      }
    } else if (this.pendingPrepare) {
      this.settlePrepare(
        this.pendingPrepare.worker,
        this.pendingPrepare.generation,
        new Error("engine is disposed"),
      );
    }
    this.worker = undefined;
    this.preparing = undefined;
  }

  private startWorker(): Promise<void> {
    if (this.worker) {
      this.invalidateWorker(
        this.worker,
        this.workerGeneration,
        new Error("local Whisper worker was replaced"),
      );
    }
    const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
    const generation = ++this.workerGeneration;
    this.worker = worker;
    const requestId = ++this.requestId;
    const preparing = new Promise<void>((resolve, reject) => {
      this.pendingPrepare = { generation, requestId, worker, resolve, reject };
    });
    worker.onmessage = (message) => this.handleWorkerMessage(worker, generation, message.data);
    worker.onerror = () => this.invalidateWorker(
      worker,
      generation,
      new Error("local Whisper worker failed"),
      { code: "INTERNAL", message: "local Whisper worker failed" },
    );
    try {
      worker.postMessage({ type: "prepare", requestId });
    } catch (error) {
      this.invalidateWorker(worker, generation, normalizeError(error, "local Whisper worker failed"));
    }
    return preparing;
  }

  private handleWorkerMessage(worker: WorkerLike, generation: number, event: WorkerEvent): void {
    if (!this.isCurrentWorker(worker, generation)) return;

    if (event.type === "progress") {
      if (this.pendingPrepare?.requestId === event.requestId) this.options.onProgress?.(event.progress);
      return;
    }
    if (event.type === "prepared") {
      const pending = this.pendingPrepare;
      if (!pending || pending.requestId !== event.requestId) return;
      if (this.disposed || !this.isCurrentWorker(worker, generation)) {
        this.settlePrepare(worker, generation, new Error("engine is disposed"));
        return;
      }
      this.prepared = true;
      this.settlePrepare(worker, generation);
      return;
    }
    if (event.type === "prepare.error") {
      if (this.pendingPrepare?.requestId !== event.requestId) return;
      this.invalidateWorker(worker, generation, new Error(event.message || "local Whisper preparation failed"));
      return;
    }
    if (event.type === "inference.started") {
      this.startInferenceWatchdog(worker, generation, event.sessionId, event.token);
      return;
    }
    if (event.type === "inference.finished") {
      this.finishInferenceWatchdog(worker, generation, event.sessionId, event.token);
      return;
    }
    if (event.type === "credit" && this.activeSession?.sessionId === event.sessionId) {
      this.activeSession.credit(event.frames);
      return;
    }
    if (event.type === "event") {
      this.activeSession?.receive(event.event);
      if (this.activeSession?.isTerminal) this.activeSession = undefined;
    }
  }

  private startInferenceWatchdog(
    worker: WorkerLike,
    generation: number,
    sessionId: string,
    token: number,
  ): void {
    if (this.activeSession?.sessionId !== sessionId) return;
    this.clearInferenceWatchdog();
    let watchdog: InferenceWatchdog;
    const timer = setTimeout(
      () => this.handleInferenceTimeout(watchdog),
      this.options.inferenceTimeoutMs ?? 30_000,
    );
    watchdog = {
      generation,
      sessionId,
      token,
      worker,
      timer,
    };
    this.inferenceWatchdog = watchdog;
  }

  private finishInferenceWatchdog(
    worker: WorkerLike,
    generation: number,
    sessionId: string,
    token: number,
  ): void {
    const watchdog = this.inferenceWatchdog;
    if (
      watchdog?.worker === worker
      && watchdog.generation === generation
      && watchdog.sessionId === sessionId
      && watchdog.token === token
    ) {
      this.clearInferenceWatchdog();
    }
  }

  private handleInferenceTimeout(watchdog: InferenceWatchdog): void {
    if (this.inferenceWatchdog !== watchdog || !this.isCurrentWorker(watchdog.worker, watchdog.generation)) return;
    this.clearInferenceWatchdog();
    const matchingSession = this.activeSession?.sessionId === watchdog.sessionId;
    this.invalidateWorker(
      watchdog.worker,
      watchdog.generation,
      new Error("Local transcription timed out"),
      matchingSession
        ? { code: "TIMEOUT", message: "Local transcription timed out" }
        : { code: "INTERNAL", message: "local Whisper worker failed" },
    );
  }

  private invalidateWorker(
    worker: WorkerLike,
    generation: number,
    error: Error,
    sessionFailure?: { code: "INTERNAL" | "TIMEOUT"; message: string },
  ): Error {
    if (!this.isCurrentWorker(worker, generation)) return error;
    this.prepared = false;
    this.clearInferenceWatchdog();
    worker.onmessage = null;
    worker.onerror = null;
    this.worker = undefined;
    let surfacedError = error;
    try {
      worker.terminate();
    } catch (terminationError) {
      const normalized = normalizeError(terminationError, "failed to terminate local Whisper worker");
      surfacedError = new Error(`${error.message}; failed to terminate local Whisper worker: ${normalized.message}`);
    }
    this.settlePrepare(worker, generation, surfacedError);
    if (sessionFailure) {
      const session = this.activeSession;
      this.activeSession = undefined;
      session?.fail(
        sessionFailure.code,
        surfacedError === error ? sessionFailure.message : surfacedError.message,
      );
    }
    return surfacedError;
  }

  private handleSessionPostFailure(worker: WorkerLike, generation: number, error: unknown): Error {
    const failure = normalizeError(error, "local Whisper worker communication failed");
    return this.invalidateWorker(
      worker,
      generation,
      failure,
      { code: "INTERNAL", message: failure.message },
    );
  }

  private settlePrepare(worker: WorkerLike, generation: number, error?: Error): void {
    const pending = this.pendingPrepare;
    if (!pending || pending.worker !== worker || pending.generation !== generation) return;
    this.pendingPrepare = undefined;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private clearInferenceWatchdog(): void {
    if (!this.inferenceWatchdog) return;
    clearTimeout(this.inferenceWatchdog.timer);
    this.inferenceWatchdog = undefined;
  }

  private isCurrentWorker(worker: WorkerLike, generation: number): boolean {
    return !this.disposed && this.worker === worker && this.workerGeneration === generation;
  }

  private assertAvailable() {
    if (this.disposed) throw new Error("engine is disposed");
  }
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./worker/localWhisper.worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(typeof error === "string" && error ? error : fallback);
}
