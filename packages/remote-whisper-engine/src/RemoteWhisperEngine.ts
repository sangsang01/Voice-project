import {
  encodePcmMessage,
  assertLoopbackWebSocketUrl,
  parseJsonMessage,
  validateServerMessage,
} from "@voice/streaming-protocol";
import type {
  EngineEvent,
  EngineEventListener,
  EngineInspection,
  ErrorCode,
  PcmFrame,
  PushResult,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";
import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";

import { browserSocketFactory, type SocketFactory, type SocketLike } from "./socket.js";

const SUBPROTOCOL = "voice-transcription.v1";
const DEFAULT_MAX_UNACKNOWLEDGED_FRAMES = 250;
const MAX_SOCKET_BUFFERED_AMOUNT = 1_048_576;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export interface RemoteWhisperEngineOptions {
  endpoint: string;
  socketFactory?: SocketFactory;
  maxUnacknowledgedFrames?: number;
}

const terminalPush: PushResult = { accepted: false, reason: "backpressure" };

function unavailableError(): Error {
  return new Error("local Whisper server is unavailable");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class RemoteSession implements TranscriptionSession {
  private readonly listeners = new Set<EngineEventListener>();
  private readonly pendingEvents: EngineEvent[] = [];
  private subscribed = false;
  private terminal = false;
  private closing = false;
  private controlSent = false;
  private stopping: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
  private lastSequence = -1;
  private highestSentSequence = -1;
  private readonly outstanding = new Set<number>();

  public constructor(
    private readonly request: SessionRequest,
    private readonly socket: SocketLike,
    private readonly maxUnacknowledgedFrames: number,
  ) {}

  public get sessionId(): string {
    return this.request.sessionId;
  }

  public get isTerminal(): boolean {
    return this.terminal;
  }

  public push(frame: PcmFrame): PushResult {
    if (this.terminal || this.closing || this.socket.readyState !== SOCKET_OPEN) return terminalPush;
    if (this.outstanding.size >= this.maxUnacknowledgedFrames) return terminalPush;
    if (this.socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT) return terminalPush;
    try {
      const valid = validatePcmFrame(frame);
      this.socket.send(encodePcmMessage(valid));
      this.outstanding.add(valid.sequence);
      if (valid.sequence > this.highestSentSequence) this.highestSentSequence = valid.sequence;
    } catch {
      return terminalPush;
    }
    return { accepted: true };
  }

  public applyAck(throughSequence: number): boolean {
    if (this.terminal) return true;
    if (throughSequence > this.highestSentSequence) return false;
    for (const sequence of [...this.outstanding]) {
      if (sequence <= throughSequence) this.outstanding.delete(sequence);
    }
    return true;
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.terminal) return Promise.resolve();
    this.closing = true;
    this.stopping = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.sendControl("session.stop");
    return this.stopping;
  }

  public cancel(): Promise<void> {
    if (this.terminal) return this.stopping ?? Promise.resolve();
    this.closing = true;
    if (!this.stopping) {
      this.stopping = new Promise((resolve) => {
        this.resolveStop = resolve;
      });
    }
    this.sendControl("session.cancel");
    return this.stopping;
  }

  public subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      for (const event of this.pendingEvents.splice(0)) this.notify(listener, event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public receive(event: EngineEvent): void {
    if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    if (event.type === "error" && event.fatal) {
      this.closing = true;
      this.terminal = true;
      this.emit(event);
      this.emit({
        type: "state",
        sessionId: this.request.sessionId,
        sequence: this.nextSequence(),
        state: "stopped",
      });
      this.resolveStop?.();
      return;
    }
    if (event.type === "state" && event.state === "stopped") {
      this.terminal = true;
      this.emit(event);
      this.resolveStop?.();
      return;
    }
    this.emit(event);
  }

  public fail(code: ErrorCode, message: string): void {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    this.emit({
      type: "error",
      sessionId: this.request.sessionId,
      sequence: this.nextSequence(),
      code,
      fatal: true,
      message,
    });
    this.emit({
      type: "state",
      sessionId: this.request.sessionId,
      sequence: this.nextSequence(),
      state: "stopped",
    });
    this.resolveStop?.();
  }

  public handleDisconnect(): void {
    if (this.terminal) {
      this.resolveStop?.();
      return;
    }
    const unexpected = !this.closing;
    this.closing = true;
    this.terminal = true;
    if (unexpected) {
      this.emit({
        type: "error",
        sessionId: this.request.sessionId,
        sequence: this.nextSequence(),
        code: "UNAVAILABLE",
        fatal: true,
        message: unavailableError().message,
      });
    }
    this.emit({
      type: "state",
      sessionId: this.request.sessionId,
      sequence: this.nextSequence(),
      state: "stopped",
    });
    this.resolveStop?.();
  }

  private sendControl(type: "session.stop" | "session.cancel"): void {
    if (this.controlSent && type !== "session.cancel") return;
    this.controlSent = true;
    if (this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify({ type, sessionId: this.request.sessionId }));
  }

  private nextSequence(): number {
    this.lastSequence += 1;
    return this.lastSequence;
  }

  private emit(event: EngineEvent): void {
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
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
      // Listener failures are isolated so socket teardown can still complete.
    }
  }
}

interface PendingOpen {
  request: SessionRequest;
  resolve(session: TranscriptionSession): void;
  reject(error: Error): void;
}

export class RemoteWhisperEngine implements TranscriptionEngine {
  private readonly endpoint: string;
  private readonly socketFactory: SocketFactory;
  private readonly maxUnacknowledgedFrames: number;
  private socket: SocketLike | undefined;
  private prepared = false;
  private disposed = false;
  private preparing: Promise<void> | undefined;
  private prepareResolve: (() => void) | undefined;
  private prepareReject: ((error: Error) => void) | undefined;
  private pendingOpen: PendingOpen | undefined;
  private preAcceptEvents: EngineEvent[] = [];
  private activeSession: RemoteSession | undefined;
  private didCloseSocket = false;

  public constructor(options: RemoteWhisperEngineOptions) {
    this.endpoint = options.endpoint;
    this.socketFactory = options.socketFactory ?? browserSocketFactory;
    this.maxUnacknowledgedFrames = options.maxUnacknowledgedFrames ?? DEFAULT_MAX_UNACKNOWLEDGED_FRAMES;
  }

  public async inspect(): Promise<EngineInspection> {
    try {
      assertLoopbackWebSocketUrl(this.endpoint);
      return { available: true };
    } catch (error) {
      return { available: false, reason: asError(error).message };
    }
  }

  public async prepare(request: SessionRequest): Promise<void> {
    this.assertNotDisposed();
    assertLoopbackWebSocketUrl(this.endpoint);
    validateSessionRequest(request);
    if (this.prepared && this.socket) return;
    if (this.preparing) return this.preparing;

    this.abandonSocket();
    this.didCloseSocket = false;
    const socket = this.socketFactory(this.endpoint, [SUBPROTOCOL]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    this.preparing = new Promise<void>((resolve, reject) => {
      this.prepareResolve = resolve;
      this.prepareReject = reject;
    });

    socket.addEventListener("open", () => {
      if (this.disposed || this.socket !== socket) {
        this.settlePrepare(unavailableError());
        return;
      }
      this.prepared = true;
      this.settlePrepare();
    });
    socket.addEventListener("error", () => {
      if (!this.prepared) this.settlePrepare(unavailableError());
    });
    socket.addEventListener("close", () => this.handleSocketClose(socket));
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));

    try {
      await this.preparing;
    } finally {
      if (this.preparing) this.preparing = undefined;
    }
  }

  public async open(request: SessionRequest): Promise<TranscriptionSession> {
    this.assertNotDisposed();
    const valid = validateSessionRequest(request);
    if (!this.prepared || !this.socket) throw new Error("engine must be prepared before opening a session");
    if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
      throw new Error("an active remote Whisper session already exists");
    }

    const socket = this.socket;
    const accepted = new Promise<TranscriptionSession>((resolve, reject) => {
      this.pendingOpen = { request: valid, resolve, reject };
    });
    try {
      socket.send(JSON.stringify({ type: "session.start", protocol: 1, request: valid }));
    } catch (error) {
      this.rejectOpen(asError(error));
    }
    return accepted;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.prepared = false;
    const session = this.activeSession;
    const closing = session?.cancel();
    this.closeSocketOnce();
    try {
      await closing;
    } catch {
      // Socket close is authoritative even if cancel send failed.
    }
    this.activeSession = undefined;
    this.rejectOpen(new Error("engine is disposed"));
    this.settlePrepare(new Error("engine is disposed"));
  }

  private handleMessage(socket: SocketLike, event: MessageEvent<string | ArrayBuffer>): void {
    if (this.socket !== socket) return;
    const data = event.data;
    if (typeof data !== "string") return;

    let message;
    try {
      message = validateServerMessage(parseJsonMessage(data));
    } catch {
      this.failProtocol();
      return;
    }

    if (message.type === "session.accepted") {
      const pending = this.pendingOpen;
      if (!pending || message.sessionId !== pending.request.sessionId || !this.socket) return;
      const session = new RemoteSession(pending.request, this.socket, this.maxUnacknowledgedFrames);
      this.activeSession = session;
      this.pendingOpen = undefined;
      for (const queued of this.preAcceptEvents.splice(0)) session.receive(queued);
      pending.resolve(session);
      return;
    }

    if (message.type === "audio.ack") {
      const session = this.activeSession;
      if (!session || message.sessionId !== session.sessionId) return;
      if (!session.applyAck(message.throughSequence)) this.failProtocol();
      return;
    }

    if (message.type === "engine.event") this.handleEngineEvent(message.event);
  }

  private handleEngineEvent(event: EngineEvent): void {
    const pending = this.pendingOpen;
    if (pending && event.sessionId === pending.request.sessionId) {
      if (event.type === "error" && event.fatal) {
        this.rejectOpen(new Error(`${event.code}: ${event.message}`));
        return;
      }
      this.preAcceptEvents.push(event);
      return;
    }

    if (event.sessionId === this.activeSession?.sessionId) {
      this.activeSession.receive(event);
      if (this.activeSession.isTerminal) this.releasePreparedConnection();
    }
  }

  private releasePreparedConnection(): void {
    this.prepared = false;
    this.closeSocketOnce();
  }

  private failProtocol(): void {
    this.rejectOpen(new Error("UNSUPPORTED: invalid server message"));
    this.activeSession?.fail("UNSUPPORTED", "invalid server message");
    this.closeSocketOnce();
  }

  private rejectOpen(error: Error): void {
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    this.preAcceptEvents = [];
    pending?.reject(error);
  }

  private handleSocketClose(socket: SocketLike): void {
    if (this.socket !== socket) return;
    const wasPrepared = this.prepared;
    this.didCloseSocket = true;
    this.prepared = false;
    this.socket = undefined;
    if (!wasPrepared) this.settlePrepare(unavailableError());
    this.rejectOpen(unavailableError());
    this.activeSession?.handleDisconnect();
  }

  private abandonSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== SOCKET_CLOSED) socket.close();
  }

  private closeSocketOnce(): void {
    if (this.didCloseSocket) return;
    const socket = this.socket;
    if (socket && socket.readyState !== SOCKET_CLOSED) {
      socket.close();
      return;
    }
    this.didCloseSocket = true;
  }

  private settlePrepare(error?: Error): void {
    const resolve = this.prepareResolve;
    const reject = this.prepareReject;
    this.prepareResolve = undefined;
    this.prepareReject = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("engine is disposed");
  }
}
