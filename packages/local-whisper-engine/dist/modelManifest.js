/**
 * Weights are fetched once at install time into apps/web/public/models and
 * served from our own origin. Nothing here points at huggingface.co at runtime.
 * Bump cacheVersion whenever a filename changes so stale Cache API entries drop.
 */
export const LOCAL_MODEL = {
    whisper: "ggml-tiny-q5_1.bin",
    vad: "ggml-silero-v6.2.0.bin",
    basePath: "/models",
    cacheVersion: 3,
};
