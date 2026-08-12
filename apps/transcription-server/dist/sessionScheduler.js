import { mapDetectedLanguage } from "./languageMap.js";
const DEFAULT_DECODE_INTERVAL_MS = 750;
const DEFAULT_MAX_WINDOW_MS = 8_000;
const DEFAULT_OVERLAP_MS = 500;
/**
 * Drives rolling provisional/final transcript revisions for one session from
 * VAD boundary updates. Pure with respect to I/O: audio arrives via push(),
 * decodes are delegated to the injected runtime, and timing is delegated to
 * the injected clock/timer so tests can control both deterministically.
 */
export class SessionScheduler {
    request;
    runtime;
    emitEvent;
    setTimer;
    clearTimer;
    decodeIntervalMs;
    maxWindowMs;
    overlapMs;
    sequence = 0;
    ordinal = 0;
    nextRevision = 0;
    lastText = "";
    speaking = false;
    decoding = false;
    tickPending = false;
    finalRequested = false;
    cancelled = false;
    stopped = false;
    tickTimer;
    frames = [];
    resolveStop;
    stoppingPromise;
    constructor(options) {
        this.request = options.request;
        this.runtime = options.runtime;
        this.emitEvent = options.emit;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.decodeIntervalMs = options.decodeIntervalMs ?? DEFAULT_DECODE_INTERVAL_MS;
        this.maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
        this.overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
    }
    push(frame) {
        if (this.cancelled || this.stopped)
            return;
        this.appendFrame(frame);
        const update = this.runtime.push(frame);
        if (update.speechStarted && !this.speaking) {
            this.speaking = true;
            this.scheduleTick();
        }
        if (update.speechEnded && this.speaking) {
            this.speaking = false;
            this.clearTick();
            this.requestFinal();
        }
    }
    stop() {
        if (this.stoppingPromise)
            return this.stoppingPromise;
        this.stopped = true;
        this.clearTick();
        this.stoppingPromise = new Promise((resolve) => {
            this.resolveStop = resolve;
        });
        if (this.speaking || this.frames.length > 0) {
            this.speaking = false;
            this.requestFinal();
        }
        this.maybeResolveStop();
        return this.stoppingPromise;
    }
    cancel() {
        if (this.stoppingPromise)
            return this.stoppingPromise;
        this.cancelled = true;
        this.stopped = true;
        this.speaking = false;
        this.finalRequested = false;
        this.tickPending = false;
        this.clearTick();
        this.stoppingPromise = new Promise((resolve) => {
            this.resolveStop = resolve;
        });
        this.maybeResolveStop();
        return this.stoppingPromise;
    }
    appendFrame(frame) {
        this.frames.push(frame);
        const frameDurationMs = this.request.audio.frameDurationMs;
        const newestEndMs = frame.startMs + frameDurationMs;
        const retainFromMs = Math.max(0, newestEndMs - this.maxWindowMs);
        while (this.frames.length > 0 && this.frames[0].startMs + frameDurationMs <= retainFromMs) {
            this.frames.shift();
        }
    }
    currentWindow() {
        const total = this.frames.reduce((sum, frame) => sum + frame.samples.length, 0);
        const audio = new Int16Array(total);
        let offset = 0;
        for (const frame of this.frames) {
            audio.set(frame.samples, offset);
            offset += frame.samples.length;
        }
        return audio;
    }
    scheduleTick() {
        this.tickTimer = this.setTimer(() => this.onTick(), this.decodeIntervalMs);
    }
    clearTick() {
        if (this.tickTimer !== undefined) {
            this.clearTimer(this.tickTimer);
            this.tickTimer = undefined;
        }
    }
    onTick() {
        this.tickTimer = undefined;
        if (this.cancelled || this.stopped || !this.speaking)
            return;
        if (this.decoding) {
            this.tickPending = true;
        }
        else {
            void this.runProvisionalDecode();
        }
        this.scheduleTick();
    }
    requestFinal() {
        if (this.decoding) {
            this.finalRequested = true;
            this.tickPending = false;
            return;
        }
        void this.runFinalDecode();
    }
    async runProvisionalDecode() {
        this.decoding = true;
        const audio = this.currentWindow();
        try {
            const result = await this.runtime.decode("provisional", audio, this.lastText);
            if (!this.cancelled)
                this.emitSegment(result, false);
        }
        catch {
            // Decode failures surface as engine warnings/errors from the gateway, not here.
        }
        finally {
            this.afterDecodeSettled();
        }
    }
    async runFinalDecode() {
        this.decoding = true;
        const audio = this.currentWindow();
        try {
            const result = await this.runtime.decode("final", audio, this.lastText);
            if (!this.cancelled) {
                this.emitSegment(result, true);
                this.finishUtterance();
            }
        }
        catch {
            // Decode failures surface as engine warnings/errors from the gateway, not here.
        }
        finally {
            this.afterDecodeSettled();
        }
    }
    afterDecodeSettled() {
        this.decoding = false;
        if (this.cancelled) {
            this.maybeResolveStop();
            return;
        }
        if (this.finalRequested) {
            this.finalRequested = false;
            this.tickPending = false;
            void this.runFinalDecode();
            return;
        }
        if (this.tickPending) {
            this.tickPending = false;
            void this.runProvisionalDecode();
            return;
        }
        this.maybeResolveStop();
    }
    maybeResolveStop() {
        if (this.stopped && !this.decoding && this.resolveStop) {
            const resolve = this.resolveStop;
            this.resolveStop = undefined;
            resolve();
        }
    }
    finishUtterance() {
        this.ordinal += 1;
        this.nextRevision = 0;
        this.lastText = "";
        // Keep a trailing overlap window rather than clearing outright, so a
        // fast-following utterance still has lead-in context for its onset.
        const frameDurationMs = this.request.audio.frameDurationMs;
        const newestEndMs = this.frames.at(-1) ? this.frames.at(-1).startMs + frameDurationMs : 0;
        const retainFromMs = Math.max(0, newestEndMs - this.overlapMs);
        this.frames = this.frames.filter((frame) => frame.startMs + frameDurationMs > retainFromMs);
    }
    emitSegment(result, isFinal) {
        const revision = this.nextRevision;
        this.nextRevision += 1;
        this.lastText = result.text;
        const language = isFinal
            ? mapDetectedLanguage(result.language, 1, this.request.candidateLanguages)
            : { tag: "und" };
        this.emitEvent({
            type: "segment.upsert",
            sessionId: this.request.sessionId,
            sequence: this.sequence++,
            segment: {
                id: `${this.request.sessionId}:${this.ordinal}`,
                ordinal: this.ordinal,
                revision,
                startMs: result.startMs,
                endMs: result.endMs,
                text: result.text,
                language,
                isFinal,
            },
        });
    }
}
