import type { TranscriptionEngine } from "../engine.js";
import type { PcmFrame, SessionRequest } from "../types.js";
export interface EngineContractFixture {
    request: SessionRequest;
    frame: PcmFrame;
    /** Frames to push before stop(). Engines that segment on voice activity
     *  need enough audio to form an utterance; one frame is not enough. */
    framesBeforeStop?: number;
}
export declare function describeEngineContract(name: string, createEngine: () => TranscriptionEngine, fixture: EngineContractFixture): void;
