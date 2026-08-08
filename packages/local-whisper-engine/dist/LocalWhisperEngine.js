import { validatePcmFrame, validateSessionRequest } from "@voice/transcription-contracts";
class LocalSession {
    request;
    worker;
    maxBufferedFrames;
    listeners = new Set();
    eventSequence = -1;
    terminal = false;
    closing = false;
    stopping;
    resolveStop;
    buffered = 0;
    subscribed = false;
    pendingEvents = [];
    constructor(request, worker, maxBufferedFrames) {
        this.request = request;
        this.worker = worker;
        this.maxBufferedFrames = maxBufferedFrames;
    }
    push(frame) {
        if (this.terminal || this.closing || this.buffered >= this.maxBufferedFrames)
            return { accepted: false, reason: "backpressure" };
        const valid = validatePcmFrame(frame);
        const samples = valid.samples.slice();
        this.buffered += 1;
        this.worker.postMessage({ type: "push", sessionId: this.request.sessionId, frame: { ...valid, samples } }, [samples.buffer]);
        return { accepted: true };
    }
    stop() {
        if (this.stopping)
            return this.stopping;
        if (this.terminal)
            return Promise.resolve();
        this.closing = true;
        this.stopping = new Promise((resolve) => { this.resolveStop = resolve; });
        this.worker.postMessage({ type: "stop", sessionId: this.request.sessionId });
        return this.stopping;
    }
    async cancel() {
        if (this.terminal)
            return;
        this.closing = true;
        this.terminal = true;
        this.worker.postMessage({ type: "cancel", sessionId: this.request.sessionId });
        this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, state: "stopped" });
        this.resolveStop?.();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (!this.subscribed) {
            this.subscribed = true;
            for (const event of this.pendingEvents.splice(0))
                listener(event);
        }
        return () => this.listeners.delete(listener);
    }
    receive(event) {
        if (this.terminal || event.sessionId !== this.request.sessionId || event.sequence <= this.eventSequence)
            return;
        this.eventSequence = event.sequence;
        if (event.type === "state" && event.state === "stopped") {
            this.terminal = true;
            this.resolveStop?.();
        }
        this.emit(event);
    }
    credit(frames) {
        if (!this.terminal)
            this.buffered = Math.max(0, this.buffered - frames);
    }
    fail(message) {
        if (this.terminal)
            return;
        this.closing = true;
        this.terminal = true;
        this.emit({ type: "error", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, code: "INTERNAL", fatal: true, message });
        this.emit({ type: "state", sessionId: this.request.sessionId, sequence: this.eventSequence + 1, state: "stopped" });
        this.resolveStop?.();
    }
    get isTerminal() {
        return this.terminal;
    }
    get sessionId() {
        return this.request.sessionId;
    }
    emit(event) {
        this.eventSequence = Math.max(this.eventSequence, event.sequence);
        if (!this.subscribed) {
            this.pendingEvents.push(event);
            return;
        }
        for (const listener of this.listeners)
            listener(event);
    }
}
export class LocalWhisperEngine {
    options;
    worker;
    prepared = false;
    disposed = false;
    requestId = 0;
    activeSession;
    constructor(options = {}) {
        this.options = options;
    }
    async inspect() {
        return this.disposed ? { available: false, reason: "disposed" } : { available: true };
    }
    async prepare(request) {
        this.assertAvailable();
        validateSessionRequest(request);
        if (this.prepared)
            return;
        const preferred = this.options.device ?? "webgpu";
        await this.prepareDevice(preferred, preferred === "webgpu");
        this.prepared = true;
    }
    async open(request) {
        this.assertAvailable();
        const valid = validateSessionRequest(request);
        if (!this.prepared || !this.worker)
            throw new Error("engine must be prepared before opening a session");
        if (this.activeSession && !this.activeSession.isTerminal)
            throw new Error("an active local Whisper session already exists");
        // Mirrors the worker's own default (see localWhisper.worker.ts) so the main-thread
        // flow-control cap doesn't trip before the worker's first transcription window fills.
        const session = new LocalSession(valid, this.worker, this.options.maxBufferedFrames ?? 800);
        this.activeSession = session;
        this.worker.postMessage({ type: "open", request: valid });
        return session;
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.activeSession?.cancel();
        this.worker?.postMessage({ type: "dispose" });
        this.worker?.terminate();
        this.worker = undefined;
    }
    async prepareDevice(device, canFallback) {
        this.worker?.terminate();
        const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
        this.worker = worker;
        const requestId = ++this.requestId;
        await new Promise((resolve, reject) => {
            worker.onmessage = (message) => {
                const event = message.data;
                if (event.type === "progress" && event.requestId === requestId)
                    this.options.onProgress?.(event.progress);
                if (event.type === "prepared" && event.requestId === requestId) {
                    resolve();
                }
                if (event.type === "prepare.error" && event.requestId === requestId)
                    reject(new Error(event.message));
                if (event.type === "credit" && this.activeSession?.sessionId === event.sessionId) {
                    this.activeSession.credit(event.frames);
                }
                if (event.type === "event") {
                    this.activeSession?.receive(event.event);
                    if (this.activeSession?.isTerminal)
                        this.activeSession = undefined;
                }
            };
            worker.onerror = () => {
                if (this.worker !== worker)
                    return;
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
            if (!canFallback)
                throw error;
            await this.prepareDevice("wasm", false);
        });
    }
    assertAvailable() {
        if (this.disposed)
            throw new Error("engine is disposed");
    }
}
function defaultWorkerFactory() {
    return new Worker(new URL("./worker/localWhisper.worker.js", import.meta.url), { type: "module" });
}
