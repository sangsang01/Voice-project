import type { EngineInspection, SessionRequest, TranscriptionEngine, TranscriptionSession } from "@voice/transcription-contracts";
import type { MainToWorker, WorkerEvent } from "./worker/protocol.js";
export interface WorkerLike {
    onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: MainToWorker, transfer?: Transferable[]): void;
    terminate(): void;
}
export interface LocalWhisperEngineOptions {
    inferenceTimeoutMs?: number;
    maxBufferedFrames?: number;
    onProgress?: (progress: number) => void;
    workerFactory?: () => WorkerLike;
}
export declare class LocalWhisperEngine implements TranscriptionEngine {
    private readonly options;
    private worker;
    private prepared;
    private disposed;
    private requestId;
    private workerGeneration;
    private preparing;
    private pendingPrepare;
    private inferenceWatchdog;
    private activeSession;
    constructor(options?: LocalWhisperEngineOptions);
    inspect(): Promise<EngineInspection>;
    prepare(request: SessionRequest): Promise<void>;
    open(request: SessionRequest): Promise<TranscriptionSession>;
    dispose(): Promise<void>;
    private startWorker;
    private handleWorkerMessage;
    private startInferenceWatchdog;
    private finishInferenceWatchdog;
    private handleInferenceTimeout;
    private invalidateWorker;
    private settlePrepare;
    private clearInferenceWatchdog;
    private isCurrentWorker;
    private assertAvailable;
}
