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

import type { InferenceDevice, MainToWorker, WorkerEvent } from "./worker/protocol.js";

export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MainToWorker, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface LocalWhisperEngineOptions {
  device?: InferenceDevice;
  maxBufferedFrames?: number;
  onProgress?: (progress: number) => void;
  workerFactory?: () => WorkerLike;
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
  ) {}

  public push(frame: PcmFrame): PushResult {
    if (this.terminal || this.closing || this.buffered >= this.maxBufferedFrames) return { accepted: false, reason: "backpressure" };
    const valid = validatePcmFrame(frame);
    const samples = valid.samples.slice();
    this.buffered += 1;
    this.worker.postMessage({ type: "push", sessionId: this.request.sessionId, frame: { ...valid, samples } }, [samples.buffer]);
    return { accepted: true };
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.terminal) return Promise.resolve();
    this.closing = true;
    this.stopping = new Promise((resolve) => { this.resolveStop = resolve; });
    this.worker.postMessage({ type: "stop", sessionId: this.request.sessionId });
    return this.stopping;
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    this.worker.postMessage({ type: "cancel", sessionId: this.request.sessionId });
    this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, state: "stopped" });
    this.resolveStop?.();
  }

  public subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      for (const event of this.pendingEvents.splice(0)) listener(event);
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

  public fail(message: string): void {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    this.emit({ type: "error", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, code: "INTERNAL", fatal: true, message });
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
    for (const listener of this.listeners) listener(event);
  }
}

export class LocalWhisperEngine implements TranscriptionEngine {
  private worker: WorkerLike | undefined;
  private prepared = false;
  private disposed = false;
  private requestId = 0;
  private activeSession: LocalSession | undefined;

  public constructor(private readonly options: LocalWhisperEngineOptions = {}) {}

  public async inspect(): Promise<EngineInspection> {
    return this.disposed ? { available: false, reason: "disposed" } : { available: true };
  }

  public async prepare(request: SessionRequest): Promise<void> {
    this.assertAvailable();
    validateSessionRequest(request);
    if (this.prepared) return;
    const preferred = this.options.device ?? "webgpu";
    await this.prepareDevice(preferred, preferred === "webgpu");
    this.prepared = true;
  }

  public async open(request: SessionRequest): Promise<TranscriptionSession> {
    this.assertAvailable();
    const valid = validateSessionRequest(request);
    if (!this.prepared || !this.worker) throw new Error("engine must be prepared before opening a session");
    if (this.activeSession && !this.activeSession.isTerminal) throw new Error("an active local Whisper session already exists");
    // Mirrors the worker's own default (see localWhisper.worker.ts) so the main-thread
    // flow-control cap doesn't trip before the worker's first transcription window fills.
    const session = new LocalSession(valid, this.worker, this.options.maxBufferedFrames ?? 800);
    this.activeSession = session;
    this.worker.postMessage({ type: "open", request: valid });
    return session;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeSession?.cancel();
    this.worker?.postMessage({ type: "dispose" });
    this.worker?.terminate();
    this.worker = undefined;
  }

  private async prepareDevice(device: InferenceDevice, canFallback: boolean): Promise<void> {
    this.worker?.terminate();
    const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
    this.worker = worker;
    const requestId = ++this.requestId;
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (message) => {
        const event = message.data;
        if (event.type === "progress" && event.requestId === requestId) this.options.onProgress?.(event.progress);
        if (event.type === "prepared" && event.requestId === requestId) {
          resolve();
        }
        if (event.type === "prepare.error" && event.requestId === requestId) reject(new Error(event.message));
        if (event.type === "credit" && this.activeSession?.sessionId === event.sessionId) {
          this.activeSession.credit(event.frames);
        }
        if (event.type === "event") {
          this.activeSession?.receive(event.event);
          if (this.activeSession?.isTerminal) this.activeSession = undefined;
        }
      };
      worker.onerror = () => {
        if (this.worker !== worker) return;
        const wasPrepared = this.prepared;
        this.prepared = false;
        this.worker = undefined;
        worker.terminate();
        if (!wasPrepared) {
          reject(new Error("local Whisper worker failed"));
          return;
        }
        this.activeSession?.fail("local Whisper worker failed");
        this.activeSession = undefined;
      };
      worker.postMessage({ type: "prepare", requestId, device });
    }).catch(async (error) => {
      if (!canFallback) throw error;
      await this.prepareDevice("wasm", false);
    });
  }

  private assertAvailable() {
    if (this.disposed) throw new Error("engine is disposed");
  }
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./worker/localWhisper.worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}
