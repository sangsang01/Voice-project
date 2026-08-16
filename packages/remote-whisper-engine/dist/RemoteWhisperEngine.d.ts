import type { EngineInspection, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { type SocketFactory } from "./socket.js";
export interface RemoteWhisperEngineOptions {
    endpoint: string;
    socketFactory?: SocketFactory;
    maxUnacknowledgedFrames?: number;
}
export declare class RemoteWhisperEngine implements TranscriptionEngine {
    private readonly endpoint;
    private readonly socketFactory;
    private readonly maxUnacknowledgedFrames;
    private socket;
    private prepared;
    private disposed;
    private preparing;
    private prepareResolve;
    private prepareReject;
    private pendingOpen;
    private activeSession;
    private didCloseSocket;
    constructor(options: RemoteWhisperEngineOptions);
    inspect(): Promise<EngineInspection>;
    prepare(request: SessionRequest): Promise<void>;
    open(request: SessionRequest): Promise<TranscriptionSession>;
    dispose(): Promise<void>;
    private handleMessage;
    private handleSocketClose;
    private closeSocketOnce;
    private settlePrepare;
    private assertNotDisposed;
}
