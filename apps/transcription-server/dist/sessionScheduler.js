import { mapDetectedLanguage } from "./languageMap.js";
const SAMPLE_RATE_HZ = 16_000;
const FRAME_DURATION_MS = 20;
export class SessionScheduler {
    request;
    runtime;
    emitEvent;
    now;
    setTimer;
    clearTimer;
    decodeIntervalMs;
    maxWindowMs;
    overlapMs;
    sequence = 0;
    nextOrdinal = 0;
    prompt = "";
    speaking = false;
    terminal = false;
    cancelled = false;
    live;
    pendingFinals = [];
    pendingProvisional = false;
    frames = [];
    timer;
    busy = false;
    pump = Promise.resolve();
    consecutiveSlowProvisionals = 0;
    constructor(options) {
        this.request = options.request;
        this.runtime = options.runtime;
        this.emitEvent = options.emit;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.decodeIntervalMs = options.decodeIntervalMs ?? 750;
        this.maxWindowMs = options.maxWindowMs ?? 8_000;
        this.overlapMs = options.overlapMs ?? 500;
    }
    start() {
        this.emitState("listening");
    }
    push(frame) {
        if (this.terminal)
            return;
        this.frames.push({ startMs: frame.startMs, samples: frame.samples });
        const vad = this.runtime.push(frame);
        if (vad.speechEnded || vad.maxDuration)
            this.onSpeechEnded();
        if (vad.speechStarted)
            this.onSpeechStarted(frame.startMs);
        this.trimBuffer();
    }
    async stop() {
        if (this.terminal)
            return;
        this.emitState("draining");
        this.clearIntervalTimer();
        this.speaking = false;
        this.queueFrozenFinal();
        await this.pump;
        if (this.terminal)
            return;
        this.terminal = true;
        this.emitState("stopped");
    }
    async cancel() {
        if (this.terminal)
            return;
        this.cancelled = true;
        this.pendingFinals = [];
        this.pendingProvisional = false;
        this.live = undefined;
        this.frames = [];
        this.clearIntervalTimer();
        this.terminal = true;
        this.emitState("stopped");
    }
    onSpeechStarted(startMs) {
        this.speaking = true;
        this.live = {
            startMs,
            ordinal: this.nextOrdinal,
            revision: 0,
            finalQueued: false,
        };
        this.ensureTimer();
    }
    onSpeechEnded() {
        this.speaking = false;
        this.clearIntervalTimer();
        this.queueFrozenFinal();
    }
    hasUnfinalizedSpeech() {
        return this.live !== undefined && !this.live.finalQueued;
    }
    queueFrozenFinal() {
        if (this.cancelled || this.terminal)
            return;
        if (!this.hasUnfinalizedSpeech() || !this.live)
            return;
        const snapshot = this.snapshotLiveFinal();
        this.live.finalQueued = true;
        this.nextOrdinal = this.live.ordinal + 1;
        this.pendingProvisional = false;
        this.pendingFinals.push(snapshot);
        this.live = undefined;
        this.kickPump();
    }
    queueProvisional() {
        if (this.cancelled || this.terminal || !this.live || this.live.finalQueued)
            return;
        this.pendingProvisional = true;
        this.kickPump();
    }
    snapshotLiveFinal() {
        const live = this.live;
        const endMs = this.utteranceEndMs();
        const overlapStartMs = Math.max(0, live.startMs - this.overlapMs);
        return {
            samples: this.collectSamples(overlapStartMs, endMs),
            startMs: live.startMs,
            endMs,
            ordinal: live.ordinal,
            id: `${this.request.sessionId}:${live.ordinal}`,
            revision: live.revision,
        };
    }
    ensureTimer() {
        if (this.timer !== undefined || this.terminal)
            return;
        this.scheduleTick();
    }
    scheduleTick() {
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            if (this.terminal || !this.speaking || !this.live || this.live.finalQueued)
                return;
            this.queueProvisional();
            if (this.speaking && !this.terminal)
                this.scheduleTick();
        }, this.decodeIntervalMs);
    }
    clearIntervalTimer() {
        if (this.timer === undefined)
            return;
        this.clearTimer(this.timer);
        this.timer = undefined;
    }
    kickPump() {
        this.pump = this.pump.then(() => this.drain(), () => this.drain());
    }
    async drain() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            while (!this.cancelled && !this.terminal) {
                const frozen = this.pendingFinals.shift();
                if (frozen) {
                    await this.runFrozenFinal(frozen);
                    continue;
                }
                if (this.pendingProvisional) {
                    this.pendingProvisional = false;
                    await this.runProvisional();
                    continue;
                }
                break;
            }
        }
        finally {
            this.busy = false;
        }
    }
    async runFrozenFinal(snapshot) {
        if (snapshot.samples.length === 0)
            return;
        try {
            const result = await this.runtime.decode("final", snapshot.samples, this.prompt);
            if (this.cancelled || this.terminal)
                return;
            this.emitSegment({
                id: snapshot.id,
                ordinal: snapshot.ordinal,
                revision: snapshot.revision,
                startMs: result.startMs,
                endMs: result.endMs,
                text: result.text,
                language: mapDetectedLanguage(result.language, result.languageProbability, this.request.candidateLanguages),
                isFinal: true,
            });
            this.prompt = result.text.trim();
        }
        catch (error) {
            this.emitDecodeError(error);
        }
    }
    async runProvisional() {
        const live = this.live;
        if (!live || live.finalQueued)
            return;
        const audio = this.buildProvisionalWindow();
        if (audio.length === 0)
            return;
        const ordinal = live.ordinal;
        const startedAt = this.now();
        try {
            const result = await this.runtime.decode("provisional", audio, this.prompt);
            if (this.cancelled || this.terminal)
                return;
            if (!this.live || this.live.ordinal !== ordinal || this.live.finalQueued)
                return;
            const elapsedMs = this.now() - startedAt;
            const audioDurationMs = (audio.length * 1000) / SAMPLE_RATE_HZ;
            this.noteProvisionalTiming(elapsedMs, audioDurationMs);
            this.emitSegment({
                id: `${this.request.sessionId}:${ordinal}`,
                ordinal,
                revision: this.live.revision++,
                startMs: result.startMs,
                endMs: result.endMs,
                text: result.text,
                language: { tag: "und" },
                isFinal: false,
            });
        }
        catch (error) {
            this.emitDecodeError(error);
        }
    }
    emitDecodeError(error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /timeout/i.test(message) ? "TIMEOUT" : "INTERNAL";
        this.emitEnvelope({
            type: "error",
            code,
            fatal: true,
            message,
        });
    }
    noteProvisionalTiming(elapsedMs, audioDurationMs) {
        if (elapsedMs > audioDurationMs)
            this.consecutiveSlowProvisionals += 1;
        else
            this.consecutiveSlowProvisionals = 0;
        if (this.consecutiveSlowProvisionals === 3) {
            this.emitEnvelope({
                type: "warning",
                code: "DEGRADED_PERFORMANCE",
                message: "Transcription is slower than realtime.",
            });
        }
    }
    buildProvisionalWindow() {
        if (!this.live)
            return new Int16Array(0);
        const utteranceEndMs = this.utteranceEndMs();
        const windowStartMs = Math.max(this.live.startMs, utteranceEndMs - this.maxWindowMs);
        const overlapStartMs = Math.max(0, windowStartMs - this.overlapMs);
        return this.collectSamples(overlapStartMs, utteranceEndMs);
    }
    collectSamples(fromMs, toMs) {
        const selected = this.frames.filter((frame) => frame.startMs < toMs && frame.startMs + FRAME_DURATION_MS > fromMs);
        const total = selected.reduce((sum, frame) => sum + frame.samples.length, 0);
        const audio = new Int16Array(total);
        let offset = 0;
        for (const frame of selected) {
            audio.set(frame.samples, offset);
            offset += frame.samples.length;
        }
        return audio;
    }
    trimBuffer() {
        const retainFromMs = this.speaking && this.live
            ? Math.max(0, this.live.startMs - this.overlapMs)
            : Math.max(0, this.utteranceEndMs() - this.overlapMs);
        this.frames = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > retainFromMs);
    }
    utteranceEndMs() {
        const last = this.frames.at(-1);
        return last ? last.startMs + FRAME_DURATION_MS : 0;
    }
    emitSegment(segment) {
        this.emitEnvelope({ type: "segment.upsert", segment });
    }
    emitState(state) {
        this.emitEnvelope({ type: "state", state });
    }
    emitEnvelope(event) {
        this.emitEvent({
            ...event,
            sessionId: this.request.sessionId,
            sequence: this.sequence++,
        });
    }
}
