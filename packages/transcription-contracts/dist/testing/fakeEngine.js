import { validatePcmFrame, validateSessionRequest } from "../validation.js";
export function makeSessionRequest(candidateLanguages) {
    return {
        sessionId: "fake-transcription-session",
        candidateLanguages,
        mode: "transcribe",
        audio: {
            encoding: "pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
            frameDurationMs: 20,
        },
    };
}
export function makePcmFrame(sequence) {
    return {
        sequence,
        startMs: sequence * 20,
        samples: new Int16Array(320),
    };
}
class FakeTranscriptionSession {
    request;
    listeners = new Set();
    listeningEmitted = false;
    terminal = false;
    sequence = 0;
    lastFrame;
    constructor(request) {
        this.request = request;
    }
    push(frame) {
        if (this.terminal) {
            return { accepted: false, reason: "backpressure" };
        }
        this.lastFrame = validatePcmFrame(frame);
        return { accepted: true };
    }
    async stop() {
        if (this.terminal) {
            return;
        }
        this.terminal = true;
        this.emitState("draining");
        this.emit({
            type: "segment.upsert",
            segment: {
                id: `${this.request.sessionId}:final`,
                ordinal: 0,
                revision: 1,
                startMs: this.lastFrame?.startMs ?? 0,
                endMs: this.lastFrame ? this.lastFrame.startMs + 20 : 0,
                text: "",
                language: { tag: this.request.candidateLanguages[0] },
                isFinal: true,
            },
        });
        this.emitState("stopped");
    }
    async cancel() {
        if (this.terminal) {
            return;
        }
        this.terminal = true;
        this.emitState("stopped");
    }
    subscribe(listener) {
        this.listeners.add(listener);
        if (!this.listeningEmitted && !this.terminal) {
            this.listeningEmitted = true;
            this.emitState("listening");
        }
        return () => this.listeners.delete(listener);
    }
    emitState(state) {
        this.emit({ type: "state", state });
    }
    emit(event) {
        const enrichedEvent = {
            ...event,
            sessionId: this.request.sessionId,
            sequence: this.sequence++,
        };
        for (const listener of this.listeners) {
            listener(enrichedEvent);
        }
    }
}
export class FakeTranscriptionEngine {
    preparedSessionIds = new Set();
    disposed = false;
    async inspect() {
        return { available: !this.disposed, ...(this.disposed ? { reason: "disposed" } : {}) };
    }
    async prepare(request) {
        this.assertNotDisposed();
        this.preparedSessionIds.add(validateSessionRequest(request).sessionId);
    }
    async open(request) {
        this.assertNotDisposed();
        const validatedRequest = validateSessionRequest(request);
        if (!this.preparedSessionIds.has(validatedRequest.sessionId)) {
            throw new Error("session must be prepared before opening");
        }
        return new FakeTranscriptionSession(validatedRequest);
    }
    async dispose() {
        this.disposed = true;
    }
    assertNotDisposed() {
        if (this.disposed) {
            throw new Error("engine is disposed");
        }
    }
}
