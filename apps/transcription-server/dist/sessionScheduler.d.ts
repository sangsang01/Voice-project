import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import type { StreamingRuntimeSession } from "./runtime.js";
export interface SessionSchedulerOptions {
    request: SessionRequest;
    runtime: StreamingRuntimeSession;
    emit(event: EngineEvent): void;
    /** Reserved for a later task's metrics/timestamping; unused by this scheduler. */
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    decodeIntervalMs?: number;
    maxWindowMs?: number;
    overlapMs?: number;
}
/**
 * Drives rolling provisional/final transcript revisions for one session from
 * VAD boundary updates. Pure with respect to I/O: audio arrives via push(),
 * decodes are delegated to the injected runtime, and timing is delegated to
 * the injected clock/timer so tests can control both deterministically.
 */
export declare class SessionScheduler {
    private readonly request;
    private readonly runtime;
    private readonly emitEvent;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly decodeIntervalMs;
    private readonly maxWindowMs;
    private readonly overlapMs;
    private sequence;
    private ordinal;
    private nextRevision;
    private lastText;
    private speaking;
    private decoding;
    private tickPending;
    private finalRequested;
    private cancelled;
    private stopped;
    private tickTimer;
    private frames;
    private resolveStop;
    private stoppingPromise;
    constructor(options: SessionSchedulerOptions);
    push(frame: PcmFrame): void;
    stop(): Promise<void>;
    cancel(): Promise<void>;
    private appendFrame;
    private currentWindow;
    private scheduleTick;
    private clearTick;
    private onTick;
    private requestFinal;
    private runProvisionalDecode;
    private runFinalDecode;
    private afterDecodeSettled;
    private maybeResolveStop;
    private finishUtterance;
    private emitSegment;
}
