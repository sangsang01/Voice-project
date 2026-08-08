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

export const VAD_DEFAULTS: VadGateConfig = {
  threshold: 0.5,
  minSpeechMs: 250,
  minSilenceMs: 500,
  maxSpeechMs: 25_000,
  speechPadMs: 100,
  windowMs: 32,
};

export type VadDecision =
  | { type: "idle" }
  | { type: "speaking" }
  | { type: "flush"; startMs: number; endMs: number; reason: "silence" | "max-duration" };

export interface VadGate {
  push(probability: number, windowStartMs: number): VadDecision;
  /** Called on stop() so a half-spoken utterance is still transcribed. */
  flushPending(nowMs: number): VadDecision;
  reset(): void;
}

const IDLE: VadDecision = { type: "idle" };
const SPEAKING: VadDecision = { type: "speaking" };

/**
 * Turns a stream of Silero speech probabilities into utterance boundaries.
 * Deliberately pure -- no audio, no timers, no WASM -- so every transition is
 * unit-testable from synthetic probability sequences.
 */
export function createVadGate(overrides: Partial<VadGateConfig> = {}): VadGate {
  const config = { ...VAD_DEFAULTS, ...overrides };

  let speaking = false;
  let onsetMs: number | undefined; // first speech window of the current run
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

  const utterance = (endMs: number, reason: "silence" | "max-duration"): VadDecision => ({
    type: "flush",
    startMs: Math.max(0, (onsetMs ?? 0) - config.speechPadMs),
    endMs: endMs + config.speechPadMs,
    reason,
  });

  return {
    push(probability, windowStartMs) {
      const windowEndMs = windowStartMs + config.windowMs;
      const isSpeech = probability >= config.threshold;

      if (isSpeech) {
        if (onsetMs === undefined) onsetMs = windowStartMs;
        speechMs += config.windowMs;
        silenceMs = 0;
        lastVoiceEndMs = windowEndMs;

        if (!speaking && speechMs >= config.minSpeechMs) speaking = true;

        // Guard against a monologue that never pauses: cut it loose and keep
        // listening, starting the next utterance where this one ended.
        if (speaking && windowEndMs - (onsetMs ?? 0) >= config.maxSpeechMs) {
          const decision = utterance(windowEndMs, "max-duration");
          onsetMs = windowEndMs;
          speechMs = 0;
          silenceMs = 0;
          return decision;
        }
        return speaking ? SPEAKING : IDLE;
      }

      // Below threshold.
      if (!speaking) {
        // A run too short to qualify never happened.
        onsetMs = undefined;
        speechMs = 0;
        return IDLE;
      }

      silenceMs += config.windowMs;
      if (silenceMs < config.minSilenceMs) return SPEAKING;

      const decision = utterance(lastVoiceEndMs, "silence");
      reset();
      return decision;
    },

    flushPending(nowMs) {
      if (!speaking) {
        reset();
        return IDLE;
      }
      const decision = utterance(Math.max(lastVoiceEndMs, nowMs), "silence");
      reset();
      return decision;
    },

    reset,
  };
}
