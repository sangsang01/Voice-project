import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";
export type InferenceDevice = "webgpu" | "wasm";
export type MainToWorker = {
    type: "prepare";
    requestId: number;
    device: InferenceDevice;
} | {
    type: "open";
    request: SessionRequest;
} | {
    type: "push";
    sessionId: string;
    frame: PcmFrame;
} | {
    type: "stop";
    sessionId: string;
} | {
    type: "cancel";
    sessionId: string;
} | {
    type: "dispose";
};
export type WorkerEvent = {
    type: "progress";
    requestId: number;
    progress: number;
} | {
    type: "prepared";
    requestId: number;
    device: InferenceDevice;
} | {
    type: "prepare.error";
    requestId: number;
    device: InferenceDevice;
    message: string;
} | {
    type: "credit";
    sessionId: string;
    frames: number;
} | {
    type: "event";
    event: EngineEvent;
};
