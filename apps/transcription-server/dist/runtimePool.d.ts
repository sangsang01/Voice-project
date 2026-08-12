import type { SessionRequest } from "@voice/transcription-contracts";
import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";
import type { StreamingRuntime, StreamingRuntimeSession } from "./runtime.js";
export interface RuntimePoolOptions {
    createHandle: () => NativeRuntimeHandle;
    capacity: number;
    modelName: string;
    decodeTimeoutMs?: number;
}
export interface RuntimePoolShutdownOptions {
    drainTimeoutMs?: number;
}
/**
 * Fixed pool of warm native whisper handles. Each open() leases one handle as a
 * StreamingRuntimeSession; healthy releases are reset and reused, while failed
 * or timed-out handles are closed and replaced before the slot is readmitted.
 */
export declare class RuntimePool implements StreamingRuntime {
    readonly modelName: string;
    private readonly createHandle;
    private readonly capacity;
    private readonly decodeTimeoutMs;
    private readonly idle;
    private readonly leased;
    private admitting;
    private shuttingDown;
    private closedHandles;
    private drainWaiters;
    private constructor();
    static create(options: RuntimePoolOptions): Promise<RuntimePool>;
    stopAdmission(): void;
    open(_request: SessionRequest): Promise<StreamingRuntimeSession>;
    shutdown(options?: RuntimePoolShutdownOptions): Promise<void>;
    private releaseHandle;
    private waitForDrain;
    private notifyDrainWaiters;
    private closeAllHandles;
    private closeHandleOnce;
}
