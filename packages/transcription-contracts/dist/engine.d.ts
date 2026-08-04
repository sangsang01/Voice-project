import type { EngineEvent } from "./events.js";
import type { PcmFrame, SessionRequest } from "./types.js";
export interface EngineInspection {
    available: boolean;
    reason?: string;
}
export type EngineEventListener = (event: EngineEvent) => void;
export type PushResult = {
    accepted: true;
} | {
    accepted: false;
    reason: "backpressure";
};
export interface TranscriptionSession {
    push(frame: PcmFrame): PushResult;
    stop(): Promise<void>;
    cancel(): Promise<void>;
    subscribe(listener: EngineEventListener): () => void;
}
export interface TranscriptionEngine {
    inspect(): Promise<EngineInspection>;
    prepare(request: SessionRequest): Promise<void>;
    open(request: SessionRequest): Promise<TranscriptionSession>;
    dispose(): Promise<void>;
}
