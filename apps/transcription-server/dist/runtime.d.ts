import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import type { NativeBackend } from "@voice/streaming-protocol";
export interface VadUpdate {
    speechStarted: boolean;
    speechEnded: boolean;
    maxDuration: boolean;
}
export interface DecodeResult {
    text: string;
    language: string;
    languageProbability: number;
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
    readonly backend: NativeBackend;
    /** Increments only when weights are loaded, never on open(). */
    readonly loadCount: number;
    ready(): Promise<void>;
    open(request: SessionRequest): Promise<StreamingRuntimeSession>;
}
