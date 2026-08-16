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
    ordinal = 0;
    revision = 0;
    prompt = "";
    speaking = false;
    speechSeen = false;
    currentFinalized = false;
    finalOutstanding = false;
    terminal = false;
    cancelled = false;
    utteranceStartMs = 0;
    frames = [];
    timer;
    busy = false;
    queued;
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
        if (vad.speechStarted)
            this.onSpeechStarted(frame.startMs);
        if (vad.speechEnded || vad.maxDuration)
            this.onSpeechEnded();
    }
    async stop() {
        if (this.terminal)
            return;
        this.emitState("draining");
        this.clearIntervalTimer();
        this.speaking = false;
        if (this.hasUnfinalizedSpeech())
            this.queueDecode("final");
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
        this.queued = undefined;
        this.frames = [];
        this.clearIntervalTimer();
        this.terminal = true;
        this.emitState("stopped");
    }
    onSpeechStarted(startMs) {
        this.speaking = true;
        this.speechSeen = true;
        this.currentFinalized = false;
        this.finalOutstanding = false;
        this.revision = 0;
        this.utteranceStartMs = startMs;
        this.ensureTimer();
    }
    onSpeechEnded() {
        this.speaking = false;
        this.clearIntervalTimer();
        this.queueDecode("final");
    }
    ensureTimer() {
        if (this.timer !== undefined || this.terminal)
            return;
        this.scheduleTick();
    }
    scheduleTick() {
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            if (this.terminal || !this.speaking || this.currentFinalized)
                return;
            this.queueDecode("provisional");
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
    queueDecode(kind) {
        if (this.cancelled || this.terminal)
            return;
        if (kind === "final") {
            if (this.finalOutstanding || this.currentFinalized)
                return;
            this.finalOutstanding = true;
            this.queued = "final";
        }
        else if (this.queued !== "final") {
            this.queued = "provisional";
        }
        this.pump = this.pump.then(() => this.drain());
    }
    async drain() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            while (this.queued && !this.cancelled && !this.terminal) {
                const kind = this.queued;
                this.queued = undefined;
                if (this.currentFinalized)
                    continue;
                await this.runDecode(kind);
            }
        }
        finally {
            this.busy = false;
        }
    }
    async runDecode(kind) {
        const audio = this.buildWindow();
        if (audio.length === 0)
            return;
        const startedAt = this.now();
        const result = await this.runtime.decode(kind, audio, this.prompt);
        if (this.cancelled || this.terminal)
            return;
        if (kind === "provisional" && (this.queued === "final" || this.currentFinalized))
            return;
        const elapsedMs = this.now() - startedAt;
        const audioDurationMs = (audio.length * 1000) / SAMPLE_RATE_HZ;
        if (kind === "provisional")
            this.noteProvisionalTiming(elapsedMs, audioDurationMs);
        const isFinal = kind === "final";
        const segment = {
            id: `${this.request.sessionId}:${this.ordinal}`,
            ordinal: this.ordinal,
            revision: this.revision++,
            startMs: result.startMs,
            endMs: result.endMs,
            text: result.text,
            language: isFinal
                ? mapDetectedLanguage(result.language, result.languageProbability, this.request.candidateLanguages)
                : { tag: "und" },
            isFinal,
        };
        this.emitEnvelope({ type: "segment.upsert", segment });
        if (isFinal) {
            this.currentFinalized = true;
            this.prompt = result.text.trim();
            this.ordinal += 1;
            this.revision = 0;
            this.trimRetainedAudio();
        }
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
    buildWindow() {
        if (this.frames.length === 0)
            return new Int16Array(0);
        const last = this.frames.at(-1);
        const utteranceEndMs = last.startMs + FRAME_DURATION_MS;
        const windowStartMs = Math.max(this.utteranceStartMs, utteranceEndMs - this.maxWindowMs);
        const overlapStartMs = Math.max(0, windowStartMs - this.overlapMs);
        const selected = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > overlapStartMs && frame.startMs < utteranceEndMs);
        const total = selected.reduce((sum, frame) => sum + frame.samples.length, 0);
        const audio = new Int16Array(total);
        let offset = 0;
        for (const frame of selected) {
            audio.set(frame.samples, offset);
            offset += frame.samples.length;
        }
        return audio;
    }
    trimRetainedAudio() {
        const retainFromMs = Math.max(0, this.utteranceEndMs() - this.overlapMs);
        this.frames = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > retainFromMs);
    }
    utteranceEndMs() {
        const last = this.frames.at(-1);
        return last ? last.startMs + FRAME_DURATION_MS : 0;
    }
    hasUnfinalizedSpeech() {
        return this.speechSeen && !this.currentFinalized && !this.finalOutstanding;
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
