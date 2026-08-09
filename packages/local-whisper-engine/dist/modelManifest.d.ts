/**
 * Weights are fetched once at install time into apps/web/public/models and
 * served from our own origin. Nothing here points at a third-party host at runtime.
 * Bump cacheVersion whenever a filename changes so stale Cache API entries drop.
 */
export declare const LOCAL_MODEL: {
    readonly whisper: "ggml-tiny-q5_1.bin";
    readonly vad: "ggml-silero-v6.2.0.bin";
    readonly basePath: "/models";
    readonly cacheVersion: 3;
};
