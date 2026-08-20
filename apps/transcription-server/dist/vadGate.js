export const VAD_DEFAULTS = {
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 500,
    maxSpeechMs: 25_000,
    speechPadMs: 100,
    windowMs: 32,
};
const IDLE = { type: "idle" };
const SPEAKING = { type: "speaking" };
/**
 * Turns a stream of Silero speech probabilities into utterance boundaries.
 * Deliberately pure -- no audio, no timers, no WASM -- so every transition is
 * unit-testable from synthetic probability sequences.
 */
export function createVadGate(overrides = {}) {
    const config = { ...VAD_DEFAULTS, ...overrides };
    let speaking = false;
    let onsetMs; // first speech window of the current run
    let speechMs = 0; // speech accumulated since onset
    let silenceMs = 0; // trailing silence since the last speech window
    let lastVoiceEndMs = 0; // end of the most recent speech window
    const reset = () => {
        speaking = false;
        onsetMs = undefined;
        speechMs = 0;
        silenceMs = 0;
        lastVoiceEndMs = 0;
    };
    const utterance = (endMs, reason) => ({
        type: "flush",
        startMs: Math.max(0, (onsetMs ?? 0) - config.speechPadMs),
        endMs: endMs + config.speechPadMs,
        reason,
    });
    const qualifying = () => ({
        type: "idle",
        retainFromMs: Math.max(0, (onsetMs ?? 0) - config.speechPadMs),
    });
    return {
        push(probability, windowStartMs) {
            const windowEndMs = windowStartMs + config.windowMs;
            const isSpeech = probability >= config.threshold;
            if (isSpeech) {
                if (onsetMs === undefined)
                    onsetMs = windowStartMs;
                speechMs += config.windowMs;
                silenceMs = 0;
                lastVoiceEndMs = windowEndMs;
                if (!speaking && speechMs >= config.minSpeechMs)
                    speaking = true;
                // Guard against a monologue that never pauses: cut it loose and keep
                // listening, starting the next utterance where this one ended.
                if (speaking && windowEndMs - (onsetMs ?? 0) >= config.maxSpeechMs) {
                    const decision = utterance(windowEndMs, "max-duration");
                    speaking = false;
                    onsetMs = windowEndMs;
                    speechMs = 0;
                    silenceMs = 0;
                    lastVoiceEndMs = windowEndMs;
                    return decision;
                }
                return speaking ? SPEAKING : qualifying();
            }
            // Below threshold.
            if (!speaking) {
                // A run too short to qualify never happened.
                onsetMs = undefined;
                speechMs = 0;
                return IDLE;
            }
            silenceMs += config.windowMs;
            if (silenceMs < config.minSilenceMs)
                return SPEAKING;
            const decision = utterance(lastVoiceEndMs, "silence");
            reset();
            return decision;
        },
        flushPending(nowMs) {
            // nowMs is deliberately ignored: the utterance ends at the last VOICED
            // window, not at whenever the caller happened to call stop(), so
            // trailing silence between the last speech and the stop is never sent
            // to Whisper. Kept in the signature -- a later task already calls it.
            void nowMs;
            if (!speaking) {
                reset();
                return IDLE;
            }
            const decision = utterance(lastVoiceEndMs, "silence");
            reset();
            return decision;
        },
        reset,
    };
}
