export interface TranscribeResult {
    text: string;
    language: string;
    languageProbability: number;
}
/**
 * The seam the worker controller is tested against. Unit tests substitute a
 * fake, so none of them need a WASM toolchain.
 */
export interface WhisperRuntime {
    load(options: {
        onProgress(fraction: number): void;
    }, signal: AbortSignal): Promise<void>;
    /** One probability per 512-sample window; Silero state persists across calls. */
    vadProbs(samples: Float32Array): Float32Array;
    /** Starts a new utterance with a clean Silero recurrent state. */
    vadReset(): void;
    transcribe(samples: Float32Array, signal: AbortSignal): Promise<TranscribeResult>;
    dispose(): Promise<void>;
}
export declare function createBridgeRuntime(): WhisperRuntime;
