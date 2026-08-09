import { type WhisperRuntime } from "./bridgeRuntime.js";
import type { MainToWorker, WorkerEvent } from "./protocol.js";
import { type VadGateConfig } from "./vadGate.js";
export type { WhisperRuntime } from "./bridgeRuntime.js";
interface WorkerControllerOptions {
    /** ~60s of audio at 20ms per frame. */
    maxBufferedFrames?: number;
    vad?: Partial<VadGateConfig>;
    transcribeTimeoutMs?: number;
    /** Injectable monotonic clock for deterministic controller tests. */
    now?: () => number;
}
export declare function createWorkerController(runtime: WhisperRuntime, post: (event: WorkerEvent) => void, options?: WorkerControllerOptions): {
    handle(message: MainToWorker): Promise<void>;
    dispose(): Promise<void>;
};
