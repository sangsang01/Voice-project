import type { InferenceDevice, MainToWorker, WorkerEvent } from "./protocol.js";
export interface WhisperRuntime {
    load(options: {
        device: InferenceDevice;
        onProgress(progress: number): void;
    }, signal: AbortSignal): Promise<void>;
    transcribe(samples: Float32Array, signal: AbortSignal): Promise<{
        text: string;
        startMs: number;
        endMs: number;
    }>;
    dispose(): Promise<void>;
}
interface WorkerControllerOptions {
    now?: () => number;
    maxBufferedFrames?: number;
    windowFrames?: number;
}
export declare function createWorkerController(runtime: WhisperRuntime, post: (event: WorkerEvent) => void, options?: WorkerControllerOptions): {
    handle(message: MainToWorker): Promise<void>;
    dispose(): Promise<void>;
};
export {};
