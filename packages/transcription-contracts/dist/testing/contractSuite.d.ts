import type { TranscriptionEngine } from "../engine.js";
import type { PcmFrame, SessionRequest } from "../types.js";
export interface EngineContractFixture {
    request: SessionRequest;
    frame: PcmFrame;
}
export declare function describeEngineContract(name: string, createEngine: () => TranscriptionEngine, fixture: EngineContractFixture): void;
