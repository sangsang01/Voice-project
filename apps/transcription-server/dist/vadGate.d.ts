export interface VadGateConfig {
    /** Speech probability at or above which a Silero window counts as speech. */
    threshold: number;
    /** Speech shorter than this is a cough or a click, not an utterance. */
    minSpeechMs: number;
    /** Trailing silence this long means "the user stopped speaking" -- the flush trigger. */
    minSilenceMs: number;
    /** Hard ceiling, kept safely under Whisper's 30s encoder window. */
    maxSpeechMs: number;
    /** Audio kept either side of the detected speech so word edges are not clipped. */
    speechPadMs: number;
    /** Silero consumes 512 samples at 16kHz. */
    windowMs: number;
}
export declare const VAD_DEFAULTS: VadGateConfig;
export type VadDecision = {
    type: "idle";
    /** Earliest padded candidate-onset timestamp the worker must retain. */
    retainFromMs?: number;
} | {
    type: "speaking";
} | {
    type: "flush";
    startMs: number;
    endMs: number;
    reason: "silence" | "max-duration";
};
export interface VadGate {
    push(probability: number, windowStartMs: number): VadDecision;
    /** Called on stop() so a half-spoken utterance is still transcribed. */
    flushPending(nowMs: number): VadDecision;
    reset(): void;
}
/**
 * Turns a stream of Silero speech probabilities into utterance boundaries.
 * Deliberately pure -- no audio, no timers, no WASM -- so every transition is
 * unit-testable from synthetic probability sequences.
 */
export declare function createVadGate(overrides?: Partial<VadGateConfig>): VadGate;
