import { encodePcmMessage, assertLoopbackWebSocketUrl, parseJsonMessage, validateServerMessage, } from "@voice/streaming-protocol";
import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";
import { browserSocketFactory } from "./socket.js";
const SUBPROTOCOL = "voice-transcription.v1";
const DEFAULT_MAX_UNACKNOWLEDGED_FRAMES = 250;
const MAX_SOCKET_BUFFERED_AMOUNT = 1_048_576;
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
    maxUnacknowledgedFrames;
    listeners = new Set();
    pendingEvents = [];
    subscribed = false;
    terminal = false;
    closing = false;
    controlSent = false;
    stopping;
    resolveStop;
    lastSequence = -1;
    highestSentSequence = -1;
    outstanding = new Set();
    constructor(request, socket, maxUnacknowledgedFrames) {
        this.request = request;
        this.socket = socket;
        this.maxUnacknowledgedFrames = maxUnacknowledgedFrames;
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
        if (this.outstanding.size >= this.maxUnacknowledgedFrames)
            return terminalPush;
        if (this.socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT)
            return terminalPush;
        try {
            const valid = validatePcmFrame(frame);
            this.socket.send(encodePcmMessage(valid));
            this.outstanding.add(valid.sequence);
            if (valid.sequence > this.highestSentSequence)
                this.highestSentSequence = valid.sequence;
        }
        catch {
            return terminalPush;
        }
        return { accepted: true };
    }
    applyAck(throughSequence) {
        if (this.terminal)
            return true;
        if (throughSequence > this.highestSentSequence)
            return false;
        for (const sequence of [...this.outstanding]) {
            if (sequence <= throughSequence)
                this.outstanding.delete(sequence);
        }
        return true;
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
    fail(code, message) {
        if (this.terminal)
            return;
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
    preAcceptEvents = [];
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
        assertLoopbackWebSocketUrl(this.endpoint);
        validateSessionRequest(request);
        if (this.prepared && this.socket)
            return;
        if (this.preparing)
            return this.preparing;
        this.abandonSocket();
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
        if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
            throw new Error("an active remote Whisper session already exists");
        }
        const socket = this.socket;
        const accepted = new Promise((resolve, reject) => {
            this.pendingOpen = { request: valid, resolve, reject };
        });
        try {
            socket.send(JSON.stringify({ type: "session.start", protocol: 1, request: valid }));
        }
        catch (error) {
            this.rejectOpen(asError(error));
        }
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
        this.rejectOpen(new Error("engine is disposed"));
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
            this.failProtocol();
            return;
        }
        if (message.type === "session.accepted") {
            const pending = this.pendingOpen;
            if (!pending || message.sessionId !== pending.request.sessionId || !this.socket)
                return;
            const session = new RemoteSession(pending.request, this.socket, this.maxUnacknowledgedFrames);
            this.activeSession = session;
            this.pendingOpen = undefined;
            for (const queued of this.preAcceptEvents.splice(0))
                session.receive(queued);
            pending.resolve(session);
            return;
        }
        if (message.type === "audio.ack") {
            const session = this.activeSession;
            if (!session || message.sessionId !== session.sessionId)
                return;
            if (!session.applyAck(message.throughSequence))
                this.failProtocol();
            return;
        }
        if (message.type === "engine.event")
            this.handleEngineEvent(message.event);
    }
    handleEngineEvent(event) {
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
            if (this.activeSession.isTerminal)
                this.releasePreparedConnection();
        }
    }
    releasePreparedConnection() {
        this.prepared = false;
        this.closeSocketOnce();
    }
    failProtocol() {
        this.rejectOpen(new Error("UNSUPPORTED: invalid server message"));
        this.activeSession?.fail("UNSUPPORTED", "invalid server message");
        this.closeSocketOnce();
    }
    rejectOpen(error) {
        const pending = this.pendingOpen;
        this.pendingOpen = undefined;
        this.preAcceptEvents = [];
        pending?.reject(error);
    }
    handleSocketClose(socket) {
        if (this.socket !== socket)
            return;
        const wasPrepared = this.prepared;
        this.didCloseSocket = true;
        this.prepared = false;
        this.socket = undefined;
        if (!wasPrepared)
            this.settlePrepare(unavailableError());
        this.rejectOpen(unavailableError());
        this.activeSession?.handleDisconnect();
    }
    abandonSocket() {
        const socket = this.socket;
        this.socket = undefined;
        if (socket && socket.readyState !== SOCKET_CLOSED)
            socket.close();
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
