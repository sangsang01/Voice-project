const MIN_INFERENCE_WATCHDOG_MS = 120_000;
const INFERENCE_REALTIME_FACTOR = 20;
const MAX_INFERENCE_WATCHDOG_MS = 600_000;

/**
 * Gives CPU-only WASM generous headroom while retaining a finite hard ceiling
 * for a genuinely blocked whisper_full() call.
 */
export function inferenceWatchdogBudgetMs(audioDurationMs: number): number {
  if (!Number.isFinite(audioDurationMs)) return MAX_INFERENCE_WATCHDOG_MS;
  return Math.min(
    MAX_INFERENCE_WATCHDOG_MS,
    Math.max(MIN_INFERENCE_WATCHDOG_MS, Math.max(0, audioDurationMs) * INFERENCE_REALTIME_FACTOR),
  );
}
