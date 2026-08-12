import { decodePcmMessage, parseJsonMessage, validateClientControl, } from "@voice/streaming-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { AdmissionPool } from "./admission.js";
import { SessionScheduler } from "./sessionScheduler.js";
const PROTOCOL = "voice-transcription.v1";
const APP_CLOSE_CODE = 4000;
/** Gaps larger than this many missing frames are treated as fatal. */
const MAX_BOUNDED_SEQUENCE_GAP = 25;
export function createTranscriptionGateway(options) {
    const admission = new AdmissionPool(options.capacity);
    const allowedOrigins = new Set(options.allowedOrigins);
    const wss = new WebSocketServer({
        noServer: true,
        handleProtocols(protocols) {
            return protocols.has(PROTOCOL) ? PROTOCOL : false;
        },
    });
    const onUpgrade = (request, socket, head) => {
        void handleUpgrade(request, socket, head);
    };
    async function handleUpgrade(request, socket, head) {
        try {
            const origin = request.headers.origin;
            if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
                socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                socket.destroy();
                return;
            }
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const token = url.searchParams.get("access_token") ?? undefined;
            url.searchParams.delete("access_token");
            // Token stripped before any request logging path.
            request.url = `${url.pathname}${url.search}`;
            const principal = await options.authenticate(token);
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request, principal);
            });
        }
        catch {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
        }
    }
    wss.on("connection", (ws, _request, _principal) => {
        const connection = new GatewayConnection(ws, options.runtime, admission, options.metrics);
        connection.start();
    });
    options.server.on("upgrade", onUpgrade);
    return () => {
        options.server.off("upgrade", onUpgrade);
        for (const client of wss.clients) {
            client.close(APP_CLOSE_CODE, "gateway closed");
        }
        wss.close();
    };
}
class GatewayConnection {
    ws;
    runtime;
    admission;
    metrics;
    releaseAdmission;
    runtimeSession;
    scheduler;
    sessionId;
    eventSequence = 0;
    lastAudioSequence = -1;
    terminal = false;
    closing = false;
    constructor(ws, runtime, admission, metrics) {
        this.ws = ws;
        this.runtime = runtime;
        this.admission = admission;
        this.metrics = metrics;
    }
    start() {
        this.ws.binaryType = "arraybuffer";
        this.ws.on("message", (data, isBinary) => {
            void this.onMessage(data, isBinary);
        });
        this.ws.on("close", () => {
            void this.onSocketClosed();
        });
        this.ws.on("error", () => {
            void this.onSocketClosed();
        });
    }
    async onMessage(data, isBinary) {
        if (this.terminal || this.closing)
            return;
        try {
            if (isBinary) {
                await this.onBinary(toArrayBuffer(data));
                return;
            }
            await this.onText(rawToString(data));
        }
        catch (error) {
            await this.fail(normalizeErrorCode(error), error instanceof Error ? error.message : "invalid message");
        }
    }
    async onText(text) {
        let control;
        try {
            control = validateClientControl(parseJsonMessage(text));
        }
        catch (error) {
            await this.fail("INVALID_AUDIO", error instanceof Error ? error.message : "malformed control message");
            return;
        }
        if (!this.scheduler) {
            if (control.type !== "session.start") {
                await this.fail("UNSUPPORTED", "first message must be session.start");
                return;
            }
            await this.startSession(control.request);
            return;
        }
        if (control.type === "session.start") {
            await this.fail("UNSUPPORTED", "only one active session is allowed per socket");
            return;
        }
        if (control.sessionId !== this.sessionId) {
            await this.fail("UNSUPPORTED", "sessionId does not match the active session");
            return;
        }
        if (control.type === "session.stop") {
            await this.stopSession();
            return;
        }
        await this.cancelSession();
    }
    async onBinary(buffer) {
        if (!this.scheduler || !this.sessionId) {
            await this.fail("UNSUPPORTED", "audio received before session.start");
            return;
        }
        let frame;
        try {
            frame = decodePcmMessage(buffer);
        }
        catch (error) {
            await this.fail("INVALID_AUDIO", error instanceof Error ? error.message : "malformed PCM frame");
            return;
        }
        const expected = this.lastAudioSequence + 1;
        if (frame.sequence < expected) {
            await this.fail("INVALID_AUDIO", "PCM sequence went backwards");
            return;
        }
        if (frame.sequence > expected) {
            const missing = frame.sequence - expected;
            if (missing > MAX_BOUNDED_SEQUENCE_GAP) {
                await this.fail("INVALID_AUDIO", "PCM sequence gap exceeds bounded limit");
                return;
            }
            this.emitEngineEvent({
                type: "warning",
                sessionId: this.sessionId,
                sequence: 0,
                code: "AUDIO_GAP",
                message: `missing ${missing} audio frame(s)`,
            });
        }
        this.lastAudioSequence = frame.sequence;
        this.scheduler.push(frame);
        this.send({
            type: "audio.ack",
            sessionId: this.sessionId,
            throughSequence: frame.sequence,
        });
    }
    async startSession(request) {
        const release = this.admission.reserve();
        if (!release) {
            this.sessionId = request.sessionId;
            await this.fail("RESOURCE_EXHAUSTED", "transcription capacity exhausted", request.sessionId);
            return;
        }
        this.releaseAdmission = release;
        this.sessionId = request.sessionId;
        try {
            this.runtimeSession = await this.runtime.open(request);
        }
        catch (error) {
            this.releaseCapacity();
            await this.fail("UNAVAILABLE", error instanceof Error ? error.message : "failed to open runtime session", request.sessionId);
            return;
        }
        this.scheduler = new SessionScheduler({
            request,
            runtime: this.wrapRuntimeForMetrics(this.runtimeSession, request.sessionId),
            emit: (event) => this.emitEngineEvent(event),
        });
        this.send({
            type: "session.accepted",
            sessionId: request.sessionId,
            model: this.runtime.modelName,
        });
        this.emitEngineEvent({
            type: "state",
            sessionId: request.sessionId,
            sequence: 0,
            state: "listening",
        });
    }
    async stopSession() {
        if (!this.scheduler || !this.sessionId || !this.runtimeSession)
            return;
        this.closing = true;
        this.emitEngineEvent({
            type: "state",
            sessionId: this.sessionId,
            sequence: 0,
            state: "draining",
        });
        await this.scheduler.stop();
        await this.runtimeSession.close();
        this.runtimeSession = undefined;
        this.scheduler = undefined;
        this.emitEngineEvent({
            type: "state",
            sessionId: this.sessionId,
            sequence: 0,
            state: "stopped",
        });
        this.releaseCapacity();
        this.closeSocket();
    }
    async cancelSession() {
        if (!this.scheduler || !this.sessionId || !this.runtimeSession)
            return;
        this.closing = true;
        await this.scheduler.cancel();
        await this.runtimeSession.close();
        this.runtimeSession = undefined;
        this.scheduler = undefined;
        this.emitEngineEvent({
            type: "state",
            sessionId: this.sessionId,
            sequence: 0,
            state: "stopped",
        });
        this.releaseCapacity();
        this.closeSocket();
    }
    async fail(code, message, sessionId = this.sessionId ?? "unassigned") {
        if (this.terminal)
            return;
        this.terminal = true;
        this.closing = true;
        if (this.scheduler) {
            try {
                await this.scheduler.cancel();
            }
            catch {
                // Terminal close is authoritative.
            }
            this.scheduler = undefined;
        }
        if (this.runtimeSession) {
            try {
                await this.runtimeSession.close();
            }
            catch {
                // Terminal close is authoritative.
            }
            this.runtimeSession = undefined;
        }
        this.send({
            type: "engine.event",
            event: {
                type: "error",
                sessionId,
                sequence: this.eventSequence++,
                code,
                fatal: true,
                message,
            },
        });
        this.send({
            type: "engine.event",
            event: {
                type: "state",
                sessionId,
                sequence: this.eventSequence++,
                state: "stopped",
            },
        });
        this.releaseCapacity();
        this.closeSocket();
    }
    wrapRuntimeForMetrics(session, sessionId) {
        const metrics = this.metrics;
        const modelName = this.runtime.modelName;
        if (!metrics)
            return session;
        return {
            push: (frame) => session.push(frame),
            close: () => session.close(),
            async decode(kind, audio, prompt) {
                const queuedAt = Date.now();
                const startedAt = Date.now();
                const result = await session.decode(kind, audio, prompt);
                const decodeDurationMs = Date.now() - startedAt;
                const audioDurationMs = (audio.length / 16_000) * 1_000;
                metrics.recordDecode({
                    sessionId,
                    model: modelName,
                    resultKind: kind,
                    queueDelayMs: Math.max(0, startedAt - queuedAt),
                    decodeDurationMs,
                    audioDurationMs,
                    realTimeFactor: audioDurationMs > 0 ? decodeDurationMs / audioDurationMs : 0,
                });
                return result;
            },
        };
    }
    async onSocketClosed() {
        if (this.terminal) {
            this.releaseCapacity();
            return;
        }
        this.terminal = true;
        this.closing = true;
        if (this.scheduler) {
            try {
                await this.scheduler.cancel();
            }
            catch {
                // Socket already closed.
            }
            this.scheduler = undefined;
        }
        if (this.runtimeSession) {
            try {
                await this.runtimeSession.close();
            }
            catch {
                // Socket already closed.
            }
            this.runtimeSession = undefined;
        }
        this.releaseCapacity();
    }
    emitEngineEvent(event) {
        if (this.terminal && event.type !== "error" && !(event.type === "state" && event.state === "stopped")) {
            return;
        }
        this.send({
            type: "engine.event",
            event: { ...event, sequence: this.eventSequence++ },
        });
    }
    send(message) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify(message));
    }
    releaseCapacity() {
        const release = this.releaseAdmission;
        this.releaseAdmission = undefined;
        release?.();
    }
    closeSocket() {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close(APP_CLOSE_CODE, "session ended");
        }
    }
}
function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer)
        return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (Array.isArray(data)) {
        const combined = Buffer.concat(data);
        return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
function rawToString(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }
    if (Array.isArray(data))
        return Buffer.concat(data).toString("utf8");
    return Buffer.from(data).toString("utf8");
}
function normalizeErrorCode(error) {
    if (error instanceof RangeError)
        return "INVALID_AUDIO";
    if (error instanceof TypeError)
        return "INVALID_AUDIO";
    return "INTERNAL";
}
