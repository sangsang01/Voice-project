import type { EngineInspection, TranscriptionEngine, TranscriptionSession } from "../engine.js";
import type { PcmFrame, SessionRequest } from "../types.js";
export declare function makeSessionRequest(candidateLanguages: readonly [string, ...string[]]): SessionRequest;
export declare function makePcmFrame(sequence: number): PcmFrame;
export declare class FakeTranscriptionEngine implements TranscriptionEngine {
    private readonly preparedSessionIds;
    private disposed;
    inspect(): Promise<EngineInspection>;
    prepare(request: SessionRequest): Promise<void>;
    open(request: SessionRequest): Promise<TranscriptionSession>;
    dispose(): Promise<void>;
    private assertNotDisposed;
}
