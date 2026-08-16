import type { NativeAddon, NativeRuntimeHandle } from "@voice/native-whisper-addon";
import type { StreamingRuntime } from "./runtime.js";
export interface NativeStreamingRuntimeOptions {
    modelPath: string;
    vadModelPath: string;
    threads: number;
    useGpu: boolean;
    decodeTimeoutMs?: number;
    loadAddon?: () => NativeAddon;
    createHandle?: () => NativeRuntimeHandle;
}
export interface NativeStreamingRuntime extends StreamingRuntime {
    close(): Promise<void>;
}
export declare function createNativeStreamingRuntime(options: NativeStreamingRuntimeOptions): NativeStreamingRuntime;
