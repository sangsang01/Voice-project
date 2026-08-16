import type { EngineEvent, EngineState, ErrorCode, PcmFrame, SessionRequest, TranscriptSegment } from "@voice/transcription-contracts";

import { mapDetectedLanguage } from "./languageMap.js";
import type { StreamingRuntimeSession } from "./runtime.js";

const SAMPLE_RATE_HZ = 16_000;
const FRAME_DURATION_MS = 20;

export interface SessionSchedulerOptions {
  request: SessionRequest;
  runtime: StreamingRuntimeSession;
  emit(event: EngineEvent): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  decodeIntervalMs?: number;
  maxWindowMs?: number;
  overlapMs?: number;
}

interface BufferedFrame {
  startMs: number;
  samples: Int16Array;
}

interface LiveUtterance {
  startMs: number;
  ordinal: number;
  revision: number;
  finalQueued: boolean;
}

interface FrozenFinal {
  samples: Int16Array;
  startMs: number;
  endMs: number;
  ordinal: number;
  id: string;
  revision: number;
}

type EventWithoutEnvelope = EngineEvent extends infer Event
  ? Event extends EngineEvent
    ? Omit<Event, "sessionId" | "sequence">
    : never
  : never;

export class SessionScheduler {
  private readonly request: SessionRequest;
  private readonly runtime: StreamingRuntimeSession;
  private readonly emitEvent: (event: EngineEvent) => void;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly decodeIntervalMs: number;
  private readonly maxWindowMs: number;
  private readonly overlapMs: number;

  private sequence = 0;
  private nextOrdinal = 0;
  private prompt = "";
  private speaking = false;
  private terminal = false;
  private cancelled = false;
  private live: LiveUtterance | undefined;
  private pendingFinals: FrozenFinal[] = [];
  private pendingProvisional = false;
  private frames: BufferedFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private pump: Promise<void> = Promise.resolve();
  private consecutiveSlowProvisionals = 0;

  public constructor(options: SessionSchedulerOptions) {
    this.request = options.request;
    this.runtime = options.runtime;
    this.emitEvent = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.decodeIntervalMs = options.decodeIntervalMs ?? 750;
    this.maxWindowMs = options.maxWindowMs ?? 8_000;
    this.overlapMs = options.overlapMs ?? 500;
  }

  public start(): void {
    this.emitState("listening");
  }

  public push(frame: PcmFrame): void {
    if (this.terminal) return;
    this.frames.push({ startMs: frame.startMs, samples: frame.samples });
    const vad = this.runtime.push(frame);
    if (vad.speechEnded || vad.maxDuration) this.onSpeechEnded();
    if (vad.speechStarted) this.onSpeechStarted(frame.startMs);
    this.trimBuffer();
  }

  public async stop(): Promise<void> {
    if (this.terminal) return;
    this.emitState("draining");
    this.clearIntervalTimer();
    this.speaking = false;
    this.queueFrozenFinal();
    await this.pump;
    if (this.terminal) return;
    this.terminal = true;
    this.emitState("stopped");
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.cancelled = true;
    this.pendingFinals = [];
    this.pendingProvisional = false;
    this.live = undefined;
    this.frames = [];
    this.clearIntervalTimer();
    this.terminal = true;
    this.emitState("stopped");
  }

  private onSpeechStarted(startMs: number): void {
    this.speaking = true;
    this.live = {
      startMs,
      ordinal: this.nextOrdinal,
      revision: 0,
      finalQueued: false,
    };
    this.ensureTimer();
  }

  private onSpeechEnded(): void {
    this.speaking = false;
    this.clearIntervalTimer();
    this.queueFrozenFinal();
  }

  private hasUnfinalizedSpeech(): boolean {
    return this.live !== undefined && !this.live.finalQueued;
  }

  private queueFrozenFinal(): void {
    if (this.cancelled || this.terminal) return;
    if (!this.hasUnfinalizedSpeech() || !this.live) return;
    const snapshot = this.snapshotLiveFinal();
    this.live.finalQueued = true;
    this.nextOrdinal = this.live.ordinal + 1;
    this.pendingProvisional = false;
    this.pendingFinals.push(snapshot);
    this.live = undefined;
    this.kickPump();
  }

  private queueProvisional(): void {
    if (this.cancelled || this.terminal || !this.live || this.live.finalQueued) return;
    this.pendingProvisional = true;
    this.kickPump();
  }

  private snapshotLiveFinal(): FrozenFinal {
    const live = this.live!;
    const endMs = this.utteranceEndMs();
    const overlapStartMs = Math.max(0, live.startMs - this.overlapMs);
    return {
      samples: this.collectSamples(overlapStartMs, endMs),
      startMs: live.startMs,
      endMs,
      ordinal: live.ordinal,
      id: `${this.request.sessionId}:${live.ordinal}`,
      revision: live.revision,
    };
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.terminal) return;
    this.scheduleTick();
  }

  private scheduleTick(): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.terminal || !this.speaking || !this.live || this.live.finalQueued) return;
      this.queueProvisional();
      if (this.speaking && !this.terminal) this.scheduleTick();
    }, this.decodeIntervalMs);
  }

  private clearIntervalTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private kickPump(): void {
    this.pump = this.pump.then(
      () => this.drain(),
      () => this.drain(),
    );
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.cancelled && !this.terminal) {
        const frozen = this.pendingFinals.shift();
        if (frozen) {
          await this.runFrozenFinal(frozen);
          continue;
        }
        if (this.pendingProvisional) {
          this.pendingProvisional = false;
          await this.runProvisional();
          continue;
        }
        break;
      }
    } finally {
      this.busy = false;
    }
  }

  private async runFrozenFinal(snapshot: FrozenFinal): Promise<void> {
    if (snapshot.samples.length === 0) return;
    try {
      const result = await this.runtime.decode("final", snapshot.samples, this.prompt);
      if (this.cancelled || this.terminal) return;
      this.emitSegment({
        id: snapshot.id,
        ordinal: snapshot.ordinal,
        revision: snapshot.revision,
        startMs: result.startMs,
        endMs: result.endMs,
        text: result.text,
        language: mapDetectedLanguage(result.language, result.languageProbability, this.request.candidateLanguages),
        isFinal: true,
      });
      this.prompt = result.text.trim();
    } catch (error) {
      this.emitDecodeError(error);
    }
  }

  private async runProvisional(): Promise<void> {
    const live = this.live;
    if (!live || live.finalQueued) return;
    const audio = this.buildProvisionalWindow();
    if (audio.length === 0) return;
    const ordinal = live.ordinal;
    const startedAt = this.now();
    try {
      const result = await this.runtime.decode("provisional", audio, this.prompt);
      if (this.cancelled || this.terminal) return;
      if (!this.live || this.live.ordinal !== ordinal || this.live.finalQueued) return;
      const elapsedMs = this.now() - startedAt;
      const audioDurationMs = (audio.length * 1000) / SAMPLE_RATE_HZ;
      this.noteProvisionalTiming(elapsedMs, audioDurationMs);
      this.emitSegment({
        id: `${this.request.sessionId}:${ordinal}`,
        ordinal,
        revision: this.live.revision++,
        startMs: result.startMs,
        endMs: result.endMs,
        text: result.text,
        language: { tag: "und" },
        isFinal: false,
      });
    } catch (error) {
      this.emitDecodeError(error);
    }
  }

  private emitDecodeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code: ErrorCode = /timeout/i.test(message) ? "TIMEOUT" : "INTERNAL";
    this.emitEnvelope({
      type: "error",
      code,
      fatal: true,
      message,
    });
  }

  private noteProvisionalTiming(elapsedMs: number, audioDurationMs: number): void {
    if (elapsedMs > audioDurationMs) this.consecutiveSlowProvisionals += 1;
    else this.consecutiveSlowProvisionals = 0;
    if (this.consecutiveSlowProvisionals === 3) {
      this.emitEnvelope({
        type: "warning",
        code: "DEGRADED_PERFORMANCE",
        message: "Transcription is slower than realtime.",
      });
    }
  }

  private buildProvisionalWindow(): Int16Array {
    if (!this.live) return new Int16Array(0);
    const utteranceEndMs = this.utteranceEndMs();
    const windowStartMs = Math.max(this.live.startMs, utteranceEndMs - this.maxWindowMs);
    const overlapStartMs = Math.max(0, windowStartMs - this.overlapMs);
    return this.collectSamples(overlapStartMs, utteranceEndMs);
  }

  private collectSamples(fromMs: number, toMs: number): Int16Array {
    const selected = this.frames.filter((frame) => frame.startMs < toMs && frame.startMs + FRAME_DURATION_MS > fromMs);
    const total = selected.reduce((sum, frame) => sum + frame.samples.length, 0);
    const audio = new Int16Array(total);
    let offset = 0;
    for (const frame of selected) {
      audio.set(frame.samples, offset);
      offset += frame.samples.length;
    }
    return audio;
  }

  private trimBuffer(): void {
    const retainFromMs = this.speaking && this.live
      ? Math.max(0, this.live.startMs - this.overlapMs)
      : Math.max(0, this.utteranceEndMs() - this.overlapMs);
    this.frames = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > retainFromMs);
  }

  private utteranceEndMs(): number {
    const last = this.frames.at(-1);
    return last ? last.startMs + FRAME_DURATION_MS : 0;
  }

  private emitSegment(segment: TranscriptSegment): void {
    this.emitEnvelope({ type: "segment.upsert", segment });
  }

  private emitState(state: EngineState): void {
    this.emitEnvelope({ type: "state", state });
  }

  private emitEnvelope(event: EventWithoutEnvelope): void {
    this.emitEvent({
      ...event,
      sessionId: this.request.sessionId,
      sequence: this.sequence++,
    } as EngineEvent);
  }
}
