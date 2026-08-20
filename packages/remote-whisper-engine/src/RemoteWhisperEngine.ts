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
import {
  encodePcmMessage,
  parseJsonMessage,
  validateClientControl,
  validateServerMessage,
} from "@voice/streaming-protocol";

import { defaultSocketFactory, type SocketEventMap, type SocketFactory, type SocketLike } from "./socket.js";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const PROTOCOL = "voice-transcription.v1";
const MAX_BUFFERED_BYTES = 1_048_576;

export interface RemoteWhisperEngineOptions {
  endpoint: string;
  tokenProvider?: () => string | Promise<string>;
  socketFactory?: SocketFactory;
  maxUnacknowledgedFrames?: number;
}

interface PendingOpen {
  request: SessionRequest;
  session: RemoteSession;
  resolve(session: TranscriptionSession): void;
  reject(error: Error): void;
}

class RemoteSession implements TranscriptionSession {
  private readonly listeners = new Set<EngineEventListener>();
  private readonly pendingEvents: EngineEvent[] = [];
  private remoteEventSequence = -1;
  private syntheticEventSequence = -2;
  private terminal = false;
  private closing = false;
  private stopping: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
  private subscribed = false;
  private lowestUnackedSequence = 0;
  private highestSentSequence = -1;
  private readonly outstandingSequences = new Set<number>();

  public constructor(
    private readonly request: SessionRequest,
    private readonly sendControl: (message: unknown) => void,
    private readonly sendFrame: (frame: PcmFrame) => boolean,
    private readonly onTerminal: (session: RemoteSession) => void,
    private readonly maxUnacknowledgedFrames: number,
    private readonly getBufferedAmount: () => number,
  ) {}

  public startListening(): void {
    this.emit({ type: "state", sessionId: this.request.sessionId, sequence: -1, state: "listening" });
    this.syntheticEventSequence = -1;
  }

  public push(frame: PcmFrame): PushResult {
    if (this.terminal || this.closing) return { accepted: false, reason: "backpressure" };
    if (this.outstandingSequences.size >= this.maxUnacknowledgedFrames) return { accepted: false, reason: "backpressure" };
    if (this.getBufferedAmount() > MAX_BUFFERED_BYTES) return { accepted: false, reason: "backpressure" };
    const valid = validatePcmFrame(frame);
    this.highestSentSequence = Math.max(this.highestSentSequence, valid.sequence);
    this.outstandingSequences.add(valid.sequence);
    if (!this.sendFrame(valid)) {
      this.outstandingSequences.delete(valid.sequence);
      return { accepted: false, reason: "backpressure" };
    }
    return { accepted: true };
  }

  public receiveAck(throughSequence: number): void {
    if (this.terminal) return;
    if (throughSequence > this.highestSentSequence) {
      this.fail("INTERNAL", "received acknowledgement beyond the highest sent sequence");
      return;
    }
    if (throughSequence < this.lowestUnackedSequence) return;
    for (const sequence of this.outstandingSequences) {
      if (sequence <= throughSequence) this.outstandingSequences.delete(sequence);
    }
    this.lowestUnackedSequence = throughSequence + 1;
  }

  public stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.terminal) return Promise.resolve();
    this.closing = true;
    this.stopping = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    try {
      this.sendControl({ type: "session.stop", sessionId: this.request.sessionId });
    } catch {
      this.fail("UNAVAILABLE", "remote transcription connection is unavailable");
    }
    return this.stopping;
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    let failure: Error | undefined;
    try {
      this.sendControl({ type: "session.cancel", sessionId: this.request.sessionId });
    } catch (error) {
      failure = normalizeError(error, "failed to cancel remote transcription session");
    } finally {
      this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), state: "stopped" });
      this.resolveStop?.();
      this.onTerminal(this);
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
    if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.remoteEventSequence) return;
    this.remoteEventSequence = event.sequence;
    if (event.type === "state" && event.state === "stopped") {
      this.terminal = true;
      this.resolveStop?.();
    }
    this.emit(event);
    if (this.terminal) this.onTerminal(this);
  }

  public fail(code: "UNAVAILABLE" | "INTERNAL", message: string): void {
    if (this.terminal) return;
    this.closing = true;
    this.terminal = true;
    this.emit({ type: "error", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), code, fatal: true, message });
    this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), state: "stopped" });
    this.resolveStop?.();
    this.onTerminal(this);
  }

  public get sessionId(): string {
    return this.request.sessionId;
  }

  public get isTerminal(): boolean {
    return this.terminal;
  }

  private emit(event: EngineEvent): void {
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
      // The engine contract has no listener-error channel; lifecycle delivery must continue.
    }
  }

  private nextSyntheticSequence(): number {
    this.syntheticEventSequence = Math.max(this.syntheticEventSequence, this.remoteEventSequence) + 1;
    return this.syntheticEventSequence;
  }
}

export class RemoteWhisperEngine implements TranscriptionEngine {
  private socket: SocketLike | undefined;
  private preparedSessionId: string | undefined;
  private disposed = false;
  private preparing: Promise<void> | undefined;
  private preparingSessionId: string | undefined;
  private pendingOpen: PendingOpen | undefined;
  private activeSession: RemoteSession | undefined;
  private socketCloseRequested = false;
  private readonly handleOpen = () => undefined;
  private readonly handleMessage = (event: SocketEventMap["message"]) => this.handleSocketMessage(event);
  private readonly handleClose = () => this.handleSocketClose();
  private readonly handleError = () => this.handleSocketClose();

  public constructor(private readonly options: RemoteWhisperEngineOptions) {}

  public async inspect(): Promise<EngineInspection> {
    if (this.disposed) return { available: false, reason: "disposed" };
    return inspectEndpoint(this.options.endpoint);
  }

  public async prepare(request: SessionRequest): Promise<void> {
    this.assertAvailable();
    const valid = validateSessionRequest(request);
    this.assertNoOpeningOrActiveSession();
    const inspection = await this.inspect();
    if (!inspection.available) throw new Error(inspection.reason ?? "remote transcription endpoint is unavailable");
    this.assertNoOpeningOrActiveSession();
    if (this.preparedSessionId === valid.sessionId && this.socket) return;
    if (this.preparing) {
      if (this.preparingSessionId === valid.sessionId) return this.preparing;
      throw new Error("cannot prepare a different remote Whisper session while preparation is in progress");
    }

    const preparing = this.openSocket(valid);
    this.preparing = preparing;
    this.preparingSessionId = valid.sessionId;
    try {
      await preparing;
    } finally {
      if (this.preparing === preparing) {
        this.preparing = undefined;
        this.preparingSessionId = undefined;
      }
    }
  }

  public async open(request: SessionRequest): Promise<TranscriptionSession> {
    this.assertAvailable();
    const valid = validateSessionRequest(request);
    if (!this.socket || this.preparedSessionId !== valid.sessionId) {
      throw new Error("engine must be prepared before opening a session");
    }
    if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
      throw new Error("an active remote Whisper session already exists");
    }

    const session = new RemoteSession(
      valid,
      (message) => this.sendControl(message),
      (frame) => this.sendFrame(frame),
      (terminalSession) => {
        if (this.activeSession === terminalSession) this.activeSession = undefined;
      },
      this.options.maxUnacknowledgedFrames ?? Number.POSITIVE_INFINITY,
      () => this.socket?.bufferedAmount ?? 0,
    );
    let pendingOpen: PendingOpen;
    const opening = new Promise<TranscriptionSession>((resolve, reject) => {
      pendingOpen = { request: valid, session, resolve, reject };
    });
    this.pendingOpen = pendingOpen!;

    try {
      await this.waitForOpenSocket();
      this.sendControl({ type: "session.start", protocol: 1, request: valid });
    } catch (error) {
      const failure = normalizeError(error, "failed to open remote transcription session");
      if (this.pendingOpen === pendingOpen!) this.pendingOpen = undefined;
      pendingOpen!.reject(failure);
      void opening.catch(() => undefined);
      throw failure;
    }

    return opening;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.preparedSessionId = undefined;
    this.preparing = undefined;
    this.preparingSessionId = undefined;
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    pending?.reject(new Error("engine is disposed"));
    try {
      await this.activeSession?.cancel();
    } catch {
      // Closing the socket below is authoritative during disposal.
    }
    this.activeSession = undefined;
    this.closeSocket();
  }

  private async openSocket(request: SessionRequest): Promise<void> {
    this.closeSocket();
    const endpoint = await this.endpointWithToken();
    this.assertAvailable();
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(endpoint, [PROTOCOL]);
    try {
      this.assertAvailable();
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", this.handleMessage);
      socket.addEventListener("close", this.handleClose);
      socket.addEventListener("error", this.handleError);
      socket.addEventListener("open", this.handleOpen);
      this.assertAvailable();
      this.socket = socket;
      this.socketCloseRequested = false;
      this.preparedSessionId = request.sessionId;
    } catch (error) {
      cleanupSocket(socket, this.handleMessage, this.handleClose, this.handleError, this.handleOpen);
      throw error;
    }
  }

  private async endpointWithToken(): Promise<string> {
    const url = new URL(this.options.endpoint);
    const token = await this.options.tokenProvider?.();
    if (token) url.searchParams.set("access_token", token);
    return url.toString();
  }

  private async waitForOpenSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket) throw new Error("remote socket is not prepared");
    if (socket.readyState === SOCKET_OPEN) return;
    if (socket.readyState !== SOCKET_CONNECTING) throw new Error("remote socket is not open");
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("remote socket closed before opening"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onClose);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onClose);
    });
  }

  private sendControl(message: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) throw new Error("remote socket is not open");
    socket.send(JSON.stringify(validateClientControl(message)));
  }

  private sendFrame(frame: PcmFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(encodePcmMessage(frame));
      return true;
    } catch {
      return false;
    }
  }

  private handleSocketMessage(event: SocketEventMap["message"]): void {
    try {
      if (typeof event.data !== "string") throw new TypeError("server message must be JSON text");
      const message = validateServerMessage(parseJsonMessage(event.data));
      if (message.type === "session.accepted") {
        const pending = this.pendingOpen;
        if (!pending || pending.request.sessionId !== message.sessionId) return;
        this.pendingOpen = undefined;
        this.activeSession = pending.session;
        pending.session.startListening();
        pending.resolve(pending.session);
        return;
      }
      if (message.type === "engine.event") {
        this.activeSession?.receive(message.event);
        return;
      }
      if (message.type === "audio.ack") {
        if (this.activeSession?.sessionId === message.sessionId) this.activeSession.receiveAck(message.throughSequence);
      }
    } catch (error) {
      this.handleProtocolFailure(normalizeError(error, "invalid remote transcription message"));
    }
  }

  private handleSocketClose(): void {
    this.preparedSessionId = undefined;
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    pending?.reject(new Error("remote transcription connection closed"));
    if (!this.disposed && !this.socketCloseRequested) {
      this.failActiveSession("UNAVAILABLE", "remote transcription connection is unavailable");
    }
  }

  private failActiveSession(code: "UNAVAILABLE" | "INTERNAL", message: string): void {
    const session = this.activeSession;
    this.activeSession = undefined;
    session?.fail(code, message);
  }

  private handleProtocolFailure(error: Error): void {
    const pending = this.pendingOpen;
    this.pendingOpen = undefined;
    pending?.reject(error);
    this.failActiveSession("INTERNAL", error.message);
    this.preparedSessionId = undefined;
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
    socket.removeEventListener("open", this.handleOpen);
    this.socket = undefined;
    if (!this.socketCloseRequested && socket.readyState !== SOCKET_CLOSING && socket.readyState !== SOCKET_CLOSED) {
      this.socketCloseRequested = true;
      socket.close(1000, "remote whisper engine disposed");
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("engine is disposed");
  }

  private assertNoOpeningOrActiveSession(): void {
    if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
      throw new Error("cannot prepare while a remote Whisper session is opening or active");
    }
  }
}

function cleanupSocket(
  socket: SocketLike,
  handleMessage: (event: SocketEventMap["message"]) => void,
  handleClose: () => void,
  handleError: () => void,
  handleOpen: () => void,
): void {
  socket.removeEventListener("message", handleMessage);
  socket.removeEventListener("close", handleClose);
  socket.removeEventListener("error", handleError);
  socket.removeEventListener("open", handleOpen);
  if (socket.readyState !== SOCKET_CLOSING && socket.readyState !== SOCKET_CLOSED) {
    socket.close(1000, "remote whisper engine disposed");
  }
}

function inspectEndpoint(endpoint: string): EngineInspection {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { available: false, reason: "remote endpoint URL is invalid" };
  }
  if (url.protocol === "wss:") return { available: true };
  if (url.protocol === "ws:" && isLoopbackHost(url.hostname)) return { available: true };
  return { available: false, reason: "remote endpoint must use wss unless it targets a loopback host" };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(typeof error === "string" && error ? error : fallback);
}
