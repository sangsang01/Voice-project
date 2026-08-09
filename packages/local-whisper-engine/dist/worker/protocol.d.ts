import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";
export type MainToWorker = {
    type: "prepare";
    requestId: number;
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
} | {
    type: "prepare.error";
    requestId: number;
    message: string;
} | {
    type: "inference.started";
    sessionId: string;
    token: number;
    audioDurationMs: number;
} | {
    type: "inference.finished";
    sessionId: string;
    token: number;
} | {
    type: "credit";
    sessionId: string;
    frames: number;
} | {
    type: "event";
    event: EngineEvent;
};
