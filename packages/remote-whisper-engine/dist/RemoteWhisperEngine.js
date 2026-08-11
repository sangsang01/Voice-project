import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";
import { encodePcmMessage, parseJsonMessage, validateClientControl, validateServerMessage, } from "@voice/streaming-protocol";
import { defaultSocketFactory } from "./socket.js";
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const PROTOCOL = "voice-transcription.v1";
class RemoteSession {
    request;
    sendControl;
    sendFrame;
    onTerminal;
    listeners = new Set();
    pendingEvents = [];
    remoteEventSequence = -1;
    syntheticEventSequence = -2;
    terminal = false;
    closing = false;
    stopping;
    resolveStop;
    subscribed = false;
    constructor(request, sendControl, sendFrame, onTerminal) {
        this.request = request;
        this.sendControl = sendControl;
        this.sendFrame = sendFrame;
        this.onTerminal = onTerminal;
    }
    startListening() {
        this.emit({ type: "state", sessionId: this.request.sessionId, sequence: -1, state: "listening" });
        this.syntheticEventSequence = -1;
    }
    push(frame) {
        if (this.terminal || this.closing)
            return { accepted: false, reason: "backpressure" };
        const valid = validatePcmFrame(frame);
        return this.sendFrame(valid) ? { accepted: true } : { accepted: false, reason: "backpressure" };
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
        try {
            this.sendControl({ type: "session.stop", sessionId: this.request.sessionId });
        }
        catch {
            this.fail("UNAVAILABLE", "remote transcription connection is unavailable");
        }
        return this.stopping;
    }
    async cancel() {
        if (this.terminal)
            return;
        this.closing = true;
        this.terminal = true;
        let failure;
        try {
            this.sendControl({ type: "session.cancel", sessionId: this.request.sessionId });
        }
        catch (error) {
            failure = normalizeError(error, "failed to cancel remote transcription session");
        }
        finally {
            this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), state: "stopped" });
            this.resolveStop?.();
            this.onTerminal(this);
        }
        if (failure)
            throw failure;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (!this.subscribed) {
            this.subscribed = true;
            for (const event of this.pendingEvents.splice(0))
                this.notify(listener, event);
        }
        return () => this.listeners.delete(listener);
    }
    receive(event) {
        if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.remoteEventSequence)
            return;
        this.remoteEventSequence = event.sequence;
        if (event.type === "state" && event.state === "stopped") {
            this.terminal = true;
            this.resolveStop?.();
        }
        this.emit(event);
        if (this.terminal)
            this.onTerminal(this);
    }
    fail(code, message) {
        if (this.terminal)
            return;
        this.closing = true;
        this.terminal = true;
        this.emit({ type: "error", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), code, fatal: true, message });
        this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.nextSyntheticSequence(), state: "stopped" });
        this.resolveStop?.();
        this.onTerminal(this);
    }
    get sessionId() {
        return this.request.sessionId;
    }
    get isTerminal() {
        return this.terminal;
    }
    emit(event) {
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
            // The engine contract has no listener-error channel; lifecycle delivery must continue.
        }
    }
    nextSyntheticSequence() {
        this.syntheticEventSequence = Math.max(this.syntheticEventSequence, this.remoteEventSequence) + 1;
        return this.syntheticEventSequence;
    }
}
export class RemoteWhisperEngine {
    options;
    socket;
    preparedSessionId;
    disposed = false;
    preparing;
    preparingSessionId;
    pendingOpen;
    activeSession;
    socketCloseRequested = false;
    handleOpen = () => undefined;
    handleMessage = (event) => this.handleSocketMessage(event);
    handleClose = () => this.handleSocketClose();
    handleError = () => this.handleSocketClose();
    constructor(options) {
        this.options = options;
    }
    async inspect() {
        if (this.disposed)
            return { available: false, reason: "disposed" };
        return inspectEndpoint(this.options.endpoint);
    }
    async prepare(request) {
        this.assertAvailable();
        const valid = validateSessionRequest(request);
        this.assertNoOpeningOrActiveSession();
        const inspection = await this.inspect();
        if (!inspection.available)
            throw new Error(inspection.reason ?? "remote transcription endpoint is unavailable");
        this.assertNoOpeningOrActiveSession();
        if (this.preparedSessionId === valid.sessionId && this.socket)
            return;
        if (this.preparing) {
            if (this.preparingSessionId === valid.sessionId)
                return this.preparing;
            throw new Error("cannot prepare a different remote Whisper session while preparation is in progress");
        }
        const preparing = this.openSocket(valid);
        this.preparing = preparing;
        this.preparingSessionId = valid.sessionId;
        try {
            await preparing;
        }
        finally {
            if (this.preparing === preparing) {
                this.preparing = undefined;
                this.preparingSessionId = undefined;
            }
        }
    }
    async open(request) {
        this.assertAvailable();
        const valid = validateSessionRequest(request);
        if (!this.socket || this.preparedSessionId !== valid.sessionId) {
            throw new Error("engine must be prepared before opening a session");
        }
        if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
            throw new Error("an active remote Whisper session already exists");
        }
        const session = new RemoteSession(valid, (message) => this.sendControl(message), (frame) => this.sendFrame(frame), (terminalSession) => {
            if (this.activeSession === terminalSession)
                this.activeSession = undefined;
        });
        let pendingOpen;
        const opening = new Promise((resolve, reject) => {
            pendingOpen = { request: valid, session, resolve, reject };
        });
        this.pendingOpen = pendingOpen;
        try {
            await this.waitForOpenSocket();
            this.sendControl({ type: "session.start", protocol: 1, request: valid });
        }
        catch (error) {
            const failure = normalizeError(error, "failed to open remote transcription session");
            if (this.pendingOpen === pendingOpen)
                this.pendingOpen = undefined;
            pendingOpen.reject(failure);
            void opening.catch(() => undefined);
            throw failure;
        }
        return opening;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.preparedSessionId = undefined;
        this.preparing = undefined;
        this.preparingSessionId = undefined;
        const pending = this.pendingOpen;
        this.pendingOpen = undefined;
        pending?.reject(new Error("engine is disposed"));
        try {
            await this.activeSession?.cancel();
        }
        catch {
            // Closing the socket below is authoritative during disposal.
        }
        this.activeSession = undefined;
        this.closeSocket();
    }
    async openSocket(request) {
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
        }
        catch (error) {
            cleanupSocket(socket, this.handleMessage, this.handleClose, this.handleError, this.handleOpen);
            throw error;
        }
    }
    async endpointWithToken() {
        const url = new URL(this.options.endpoint);
        const token = await this.options.tokenProvider?.();
        if (token)
            url.searchParams.set("access_token", token);
        return url.toString();
    }
    async waitForOpenSocket() {
        const socket = this.socket;
        if (!socket)
            throw new Error("remote socket is not prepared");
        if (socket.readyState === SOCKET_OPEN)
            return;
        if (socket.readyState !== SOCKET_CONNECTING)
            throw new Error("remote socket is not open");
        await new Promise((resolve, reject) => {
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
    sendControl(message) {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN)
            throw new Error("remote socket is not open");
        socket.send(JSON.stringify(validateClientControl(message)));
    }
    sendFrame(frame) {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN)
            return false;
        try {
            socket.send(encodePcmMessage(frame));
            return true;
        }
        catch {
            return false;
        }
    }
    handleSocketMessage(event) {
        try {
            if (typeof event.data !== "string")
                throw new TypeError("server message must be JSON text");
            const message = validateServerMessage(parseJsonMessage(event.data));
            if (message.type === "session.accepted") {
                const pending = this.pendingOpen;
                if (!pending || pending.request.sessionId !== message.sessionId)
                    return;
                this.pendingOpen = undefined;
                this.activeSession = pending.session;
                pending.session.startListening();
                pending.resolve(pending.session);
                return;
            }
            if (message.type === "engine.event") {
                this.activeSession?.receive(message.event);
            }
        }
        catch (error) {
            this.handleProtocolFailure(normalizeError(error, "invalid remote transcription message"));
        }
    }
    handleSocketClose() {
        this.preparedSessionId = undefined;
        const pending = this.pendingOpen;
        this.pendingOpen = undefined;
        pending?.reject(new Error("remote transcription connection closed"));
        if (!this.disposed && !this.socketCloseRequested) {
            this.failActiveSession("UNAVAILABLE", "remote transcription connection is unavailable");
        }
    }
    failActiveSession(code, message) {
        const session = this.activeSession;
        this.activeSession = undefined;
        session?.fail(code, message);
    }
    handleProtocolFailure(error) {
        const pending = this.pendingOpen;
        this.pendingOpen = undefined;
        pending?.reject(error);
        this.failActiveSession("INTERNAL", error.message);
        this.preparedSessionId = undefined;
        this.closeSocket();
    }
    closeSocket() {
        const socket = this.socket;
        if (!socket)
            return;
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
    assertAvailable() {
        if (this.disposed)
            throw new Error("engine is disposed");
    }
    assertNoOpeningOrActiveSession() {
        if (this.pendingOpen || (this.activeSession && !this.activeSession.isTerminal)) {
            throw new Error("cannot prepare while a remote Whisper session is opening or active");
        }
    }
}
function cleanupSocket(socket, handleMessage, handleClose, handleError, handleOpen) {
    socket.removeEventListener("message", handleMessage);
    socket.removeEventListener("close", handleClose);
    socket.removeEventListener("error", handleError);
    socket.removeEventListener("open", handleOpen);
    if (socket.readyState !== SOCKET_CLOSING && socket.readyState !== SOCKET_CLOSED) {
        socket.close(1000, "remote whisper engine disposed");
    }
}
function inspectEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        return { available: false, reason: "remote endpoint URL is invalid" };
    }
    if (url.protocol === "wss:")
        return { available: true };
    if (url.protocol === "ws:" && isLoopbackHost(url.hostname))
        return { available: true };
    return { available: false, reason: "remote endpoint must use wss unless it targets a loopback host" };
}
function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}
function normalizeError(error, fallback) {
    return error instanceof Error ? error : new Error(typeof error === "string" && error ? error : fallback);
}
