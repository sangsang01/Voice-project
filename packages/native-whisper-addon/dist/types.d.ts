export interface NativeDecodeResult {
    text: string;
    language: string;
    languageProbability: number;
    startMs: number;
    endMs: number;
}
export interface NativeRuntimeHandle {
    pushVad(samples: Int16Array): Float32Array;
    decode(samples: Int16Array, prompt: string, language?: string): Promise<NativeDecodeResult>;
    warmup(): Promise<void>;
    reset(): void;
    close(): void;
}
export interface NativeAddon {
    createRuntime(options: {
        modelPath: string;
        vadModelPath: string;
        threads: number;
        useGpu: boolean;
    }): NativeRuntimeHandle;
}
