import type { EngineInspection, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import { type SocketFactory } from "./socket.js";
export interface RemoteWhisperEngineOptions {
    endpoint: string;
    tokenProvider?: () => string | Promise<string>;
    socketFactory?: SocketFactory;
    maxUnacknowledgedFrames?: number;
}
export declare class RemoteWhisperEngine implements TranscriptionEngine {
    private readonly options;
    private socket;
    private preparedSessionId;
    private disposed;
    private preparing;
    private preparingSessionId;
    private pendingOpen;
    private activeSession;
    private socketCloseRequested;
    private readonly handleOpen;
    private readonly handleMessage;
    private readonly handleClose;
    private readonly handleError;
    constructor(options: RemoteWhisperEngineOptions);
    inspect(): Promise<EngineInspection>;
    prepare(request: SessionRequest): Promise<void>;
    open(request: SessionRequest): Promise<TranscriptionSession>;
    dispose(): Promise<void>;
    private openSocket;
    private endpointWithToken;
    private waitForOpenSocket;
    private sendControl;
    private sendFrame;
    private handleSocketMessage;
    private handleSocketClose;
    private failActiveSession;
    private handleProtocolFailure;
    private closeSocket;
    private assertAvailable;
    private assertNoOpeningOrActiveSession;
}
