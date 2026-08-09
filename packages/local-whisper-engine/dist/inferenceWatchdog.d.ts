/**
 * Gives CPU-only WASM generous headroom while retaining a finite hard ceiling
 * for a genuinely blocked whisper_full() call.
 */
export declare function inferenceWatchdogBudgetMs(audioDurationMs: number): number;
