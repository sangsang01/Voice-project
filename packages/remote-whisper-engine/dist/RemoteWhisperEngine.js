import { encodePcmMessage, assertLoopbackWebSocketUrl, parseJsonMessage, validateServerMessage, } from "@voice/streaming-protocol";
import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";
import { browserSocketFactory } from "./socket.js";
const SUBPROTOCOL = "voice-transcription.v1";
const DEFAULT_MAX_UNACKNOWLEDGED_FRAMES = 250;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const terminalPush = { accepted: false, reason: "backpressure" };
function unavailableError() {
    return new Error("local Whisper server is unavailable");
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
class RemoteSession {
    request;
    socket;
    listeners = new Set();
    pendingEvents = [];
    subscribed = false;
    terminal = false;
    closing = false;
    controlSent = false;
    stopping;
    resolveStop;
    lastSequence = -1;
    constructor(request, socket) {
        this.request = request;
        this.socket = socket;
    }
    get sessionId() {
        return this.request.sessionId;
    }
    get isTerminal() {
        return this.terminal;
    }
    push(frame) {
        if (this.terminal || this.closing || this.socket.readyState !== SOCKET_OPEN)
            return terminalPush;
        try {
            this.socket.send(encodePcmMessage(validatePcmFrame(frame)));
        }
        catch {
            return terminalPush;
        }
        return { accepted: true };
    }
    stop() {
        if (this.stopping)
            return this.stopping;
        if (this.terminal)
            return Promise.resolve();
        this.closing = true;
        this.stopping = new Promise((resolve) => {
            this.resolveStop = resolve;
        });
        this.sendControl("session.stop");
        return this.stopping;
    }
    cancel() {
        if (this.terminal)
            return this.stopping ?? Promise.resolve();
        this.closing = true;
        if (!this.stopping) {
            this.stopping = new Promise((resolve) => {
                this.resolveStop = resolve;
            });
        }
        this.sendControl("session.cancel");
        return this.stopping;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (!this.subscribed) {
            this.subscribed = true;
            for (const event of this.pendingEvents.splice(0))
                this.notify(listener, event);
        }
        return () => {
            this.listeners.delete(listener);
        };
    }
    receive(event) {
        if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.lastSequence)
            return;
        this.lastSequence = event.sequence;
        if (event.type === "state" && event.state === "stopped") {
            this.terminal = true;
            this.emit(event);
            this.resolveStop?.();
            return;
        }
        this.emit(event);
    }
    handleDisconnect() {
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
    sendControl(type) {
        if (this.controlSent)
            return;
        this.controlSent = true;
        if (this.socket.readyState !== SOCKET_OPEN)
            return;
        this.socket.send(JSON.stringify({ type, sessionId: this.request.sessionId }));
    }
    nextSequence() {
        this.lastSequence += 1;
        return this.lastSequence;
    }
    emit(event) {
        this.lastSequence = Math.max(this.lastSequence, event.sequence);
        if (!this.subscribed) {
            this.pendingEvents.push(event);
            return;
        }
        for (const listener of this.listeners)
            this.notify(listener, event);
    }
    notify(listener, event) {
        try {
            listener(event);
        }
        catch {
            // Listener failures are isolated so socket teardown can still complete.
        }
    }
}
export class RemoteWhisperEngine {
    endpoint;
    socketFactory;
    maxUnacknowledgedFrames;
    socket;
    prepared = false;
    disposed = false;
    preparing;
    prepareResolve;
    prepareReject;
    pendingOpen;
    activeSession;
    didCloseSocket = false;
    constructor(options) {
        this.endpoint = options.endpoint;
        this.socketFactory = options.socketFactory ?? browserSocketFactory;
        this.maxUnacknowledgedFrames = options.maxUnacknowledgedFrames ?? DEFAULT_MAX_UNACKNOWLEDGED_FRAMES;
    }
    async inspect() {
        try {
            assertLoopbackWebSocketUrl(this.endpoint);
            return { available: true };
        }
        catch (error) {
            return { available: false, reason: asError(error).message };
        }
    }
    async prepare(request) {
        this.assertNotDisposed();
        validateSessionRequest(request);
        if (this.prepared && this.socket)
            return;
        if (this.preparing)
            return this.preparing;
        this.didCloseSocket = false;
        const socket = this.socketFactory(this.endpoint, [SUBPROTOCOL]);
        socket.binaryType = "arraybuffer";
        this.socket = socket;
        this.preparing = new Promise((resolve, reject) => {
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
            if (!this.prepared)
                this.settlePrepare(unavailableError());
        });
        socket.addEventListener("close", () => this.handleSocketClose(socket));
        socket.addEventListener("message", (event) => this.handleMessage(socket, event));
        try {
            await this.preparing;
        }
        finally {
            if (this.preparing)
                this.preparing = undefined;
        }
    }
    async open(request) {
        this.assertNotDisposed();
        const valid = validateSessionRequest(request);
        if (!this.prepared || !this.socket)
            throw new Error("engine must be prepared before opening a session");
        if (this.activeSession && !this.activeSession.isTerminal) {
            throw new Error("an active remote Whisper session already exists");
        }
        const socket = this.socket;
        const accepted = new Promise((resolve, reject) => {
            this.pendingOpen = { request: valid, resolve, reject };
        });
        socket.send(JSON.stringify({ type: "session.start", protocol: 1, request: valid }));
        return accepted;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.prepared = false;
        const session = this.activeSession;
        const closing = session?.cancel();
        this.closeSocketOnce();
        try {
            await closing;
        }
        catch {
            // Socket close is authoritative even if cancel send failed.
        }
        this.activeSession = undefined;
        this.pendingOpen?.reject(new Error("engine is disposed"));
        this.pendingOpen = undefined;
        this.settlePrepare(new Error("engine is disposed"));
    }
    handleMessage(socket, event) {
        if (this.socket !== socket)
            return;
        const data = event.data;
        if (typeof data !== "string")
            return;
        let message;
        try {
            message = validateServerMessage(parseJsonMessage(data));
        }
        catch {
            this.pendingOpen?.reject(new Error("invalid server message"));
            this.pendingOpen = undefined;
            this.activeSession?.handleDisconnect();
            return;
        }
        if (message.type === "session.accepted") {
            const pending = this.pendingOpen;
            if (!pending || message.sessionId !== pending.request.sessionId || !this.socket)
                return;
            const session = new RemoteSession(pending.request, this.socket);
            this.activeSession = session;
            this.pendingOpen = undefined;
            pending.resolve(session);
            return;
        }
        if (message.type === "audio.ack") {
            return;
        }
        if (message.type === "engine.event" && message.event.sessionId === this.activeSession?.sessionId) {
            this.activeSession.receive(message.event);
        }
    }
    handleSocketClose(socket) {
        if (this.socket !== socket && this.socket !== undefined)
            return;
        const wasPrepared = this.prepared;
        this.didCloseSocket = true;
        this.prepared = false;
        if (this.socket === socket)
            this.socket = undefined;
        if (!wasPrepared)
            this.settlePrepare(unavailableError());
        this.pendingOpen?.reject(unavailableError());
        this.pendingOpen = undefined;
        this.activeSession?.handleDisconnect();
    }
    closeSocketOnce() {
        if (this.didCloseSocket)
            return;
        const socket = this.socket;
        if (socket && socket.readyState !== SOCKET_CLOSED) {
            socket.close();
            return;
        }
        this.didCloseSocket = true;
    }
    settlePrepare(error) {
        const resolve = this.prepareResolve;
        const reject = this.prepareReject;
        this.prepareResolve = undefined;
        this.prepareReject = undefined;
        if (error)
            reject?.(error);
        else
            resolve?.();
    }
    assertNotDisposed() {
        if (this.disposed)
            throw new Error("engine is disposed");
    }
}
