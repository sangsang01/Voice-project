import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";
export interface VadUpdate {
    speechStarted: boolean;
    speechEnded: boolean;
}
export interface DecodeResult {
    text: string;
    language: string;
    startMs: number;
    endMs: number;
}
export interface StreamingRuntimeSession {
    push(frame: PcmFrame): VadUpdate;
    decode(kind: "provisional" | "final", audio: Int16Array, prompt: string): Promise<DecodeResult>;
    close(): Promise<void>;
}
export interface StreamingRuntime {
    readonly modelName: string;
    open(request: SessionRequest): Promise<StreamingRuntimeSession>;
}
