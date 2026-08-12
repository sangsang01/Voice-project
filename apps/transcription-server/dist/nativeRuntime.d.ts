import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";
import type { StreamingRuntimeSession } from "./runtime.js";
export interface NativeRuntimeSessionOptions {
    handle: NativeRuntimeHandle;
    decodeTimeoutMs: number;
    /** Invoked exactly once when the lease is released. */
    release(outcome: "healthy" | "unhealthy"): Promise<void>;
}
/**
 * Adapts one leased native handle into the scheduler-facing session seam:
 * pushVad → VadGate → VadUpdate. Decode is serialized on this session and raced
 * against decodeTimeoutMs; any failure/timeout retires the handle as unhealthy.
 */
export declare function createNativeRuntimeSession(options: NativeRuntimeSessionOptions): StreamingRuntimeSession;
