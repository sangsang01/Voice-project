import type { EngineEvent, EngineState } from "../events.js";
import type {
  EngineEventListener,
  EngineInspection,
  PushResult,
  TranscriptionEngine,
  TranscriptionSession,
} from "../engine.js";
import type { PcmFrame, SessionRequest } from "../types.js";
import { validatePcmFrame, validateSessionRequest } from "../validation.js";

type EventWithoutSession<E extends EngineEvent = EngineEvent> = E extends EngineEvent
  ? Omit<E, "sessionId" | "sequence">
  : never;

export function makeSessionRequest(candidateLanguages: readonly [string, ...string[]]): SessionRequest {
  return {
    sessionId: "fake-transcription-session",
    candidateLanguages,
    mode: "transcribe",
    audio: {
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
      channels: 1,
      frameDurationMs: 20,
    },
  };
}

export function makePcmFrame(sequence: number): PcmFrame {
  return {
    sequence,
    startMs: sequence * 20,
    samples: new Int16Array(320),
  };
}

class FakeTranscriptionSession implements TranscriptionSession {
  private readonly listeners = new Set<EngineEventListener>();
  private listeningEmitted = false;
  private terminal = false;
  private sequence = 0;
  private lastFrame: PcmFrame | undefined;

  public constructor(private readonly request: SessionRequest) {}

  public push(frame: PcmFrame): PushResult {
    if (this.terminal) {
      return { accepted: false, reason: "backpressure" };
    }

    this.lastFrame = validatePcmFrame(frame);
    return { accepted: true };
  }

  public async stop(): Promise<void> {
    if (this.terminal) {
      return;
    }

    this.terminal = true;
    this.emitState("draining");
    this.emit({
      type: "segment.upsert",
      segment: {
        id: `${this.request.sessionId}:final`,
        ordinal: 0,
        revision: 1,
        startMs: this.lastFrame?.startMs ?? 0,
        endMs: this.lastFrame ? this.lastFrame.startMs + 20 : 0,
        text: "",
        language: { tag: this.request.candidateLanguages[0] },
        isFinal: true,
      },
    });
    this.emitState("stopped");
  }

  public async cancel(): Promise<void> {
    if (this.terminal) {
      return;
    }

    this.terminal = true;
    this.emitState("stopped");
  }

  public subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    if (!this.listeningEmitted && !this.terminal) {
      this.listeningEmitted = true;
      this.emitState("listening");
    }

    return () => this.listeners.delete(listener);
  }

  private emitState(state: EngineState) {
    this.emit({ type: "state", state });
  }

  private emit(event: EventWithoutSession) {
    const enrichedEvent = {
      ...event,
      sessionId: this.request.sessionId,
      sequence: this.sequence++,
    } as EngineEvent;

    for (const listener of this.listeners) {
      listener(enrichedEvent);
    }
  }
}

export class FakeTranscriptionEngine implements TranscriptionEngine {
  private readonly preparedSessionIds = new Set<string>();
  private disposed = false;

  public async inspect(): Promise<EngineInspection> {
    return { available: !this.disposed, ...(this.disposed ? { reason: "disposed" } : {}) };
  }

  public async prepare(request: SessionRequest): Promise<void> {
    this.assertNotDisposed();
    this.preparedSessionIds.add(validateSessionRequest(request).sessionId);
  }

  public async open(request: SessionRequest): Promise<TranscriptionSession> {
    this.assertNotDisposed();
    const validatedRequest = validateSessionRequest(request);
    if (!this.preparedSessionIds.has(validatedRequest.sessionId)) {
      throw new Error("session must be prepared before opening");
    }

    return new FakeTranscriptionSession(validatedRequest);
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }

  private assertNotDisposed() {
    if (this.disposed) {
      throw new Error("engine is disposed");
    }
  }
}
