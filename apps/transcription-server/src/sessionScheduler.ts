import type { EngineEvent, EngineState, PcmFrame, SessionRequest, TranscriptSegment } from "@voice/transcription-contracts";

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
  private ordinal = 0;
  private revision = 0;
  private prompt = "";
  private speaking = false;
  private speechSeen = false;
  private currentFinalized = false;
  private finalOutstanding = false;
  private terminal = false;
  private cancelled = false;
  private utteranceStartMs = 0;
  private frames: BufferedFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private queued: "provisional" | "final" | undefined;
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
    if (vad.speechStarted) this.onSpeechStarted(frame.startMs);
    if (vad.speechEnded || vad.maxDuration) this.onSpeechEnded();
  }

  public async stop(): Promise<void> {
    if (this.terminal) return;
    this.emitState("draining");
    this.clearIntervalTimer();
    this.speaking = false;
    if (this.hasUnfinalizedSpeech()) this.queueDecode("final");
    await this.pump;
    if (this.terminal) return;
    this.terminal = true;
    this.emitState("stopped");
  }

  public async cancel(): Promise<void> {
    if (this.terminal) return;
    this.cancelled = true;
    this.queued = undefined;
    this.frames = [];
    this.clearIntervalTimer();
    this.terminal = true;
    this.emitState("stopped");
  }

  private onSpeechStarted(startMs: number): void {
    this.speaking = true;
    this.speechSeen = true;
    this.currentFinalized = false;
    this.finalOutstanding = false;
    this.revision = 0;
    this.utteranceStartMs = startMs;
    this.ensureTimer();
  }

  private onSpeechEnded(): void {
    this.speaking = false;
    this.clearIntervalTimer();
    this.queueDecode("final");
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.terminal) return;
    this.scheduleTick();
  }

  private scheduleTick(): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.terminal || !this.speaking || this.currentFinalized) return;
      this.queueDecode("provisional");
      if (this.speaking && !this.terminal) this.scheduleTick();
    }, this.decodeIntervalMs);
  }

  private clearIntervalTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private queueDecode(kind: "provisional" | "final"): void {
    if (this.cancelled || this.terminal) return;
    if (kind === "final") {
      if (this.finalOutstanding || this.currentFinalized) return;
      this.finalOutstanding = true;
      this.queued = "final";
    } else if (this.queued !== "final") {
      this.queued = "provisional";
    }
    this.pump = this.pump.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queued && !this.cancelled && !this.terminal) {
        const kind = this.queued;
        this.queued = undefined;
        if (this.currentFinalized) continue;
        await this.runDecode(kind);
      }
    } finally {
      this.busy = false;
    }
  }

  private async runDecode(kind: "provisional" | "final"): Promise<void> {
    const audio = this.buildWindow();
    if (audio.length === 0) return;
    const startedAt = this.now();
    const result = await this.runtime.decode(kind, audio, this.prompt);
    if (this.cancelled || this.terminal) return;
    if (kind === "provisional" && (this.queued === "final" || this.currentFinalized)) return;

    const elapsedMs = this.now() - startedAt;
    const audioDurationMs = (audio.length * 1000) / SAMPLE_RATE_HZ;
    if (kind === "provisional") this.noteProvisionalTiming(elapsedMs, audioDurationMs);

    const isFinal = kind === "final";
    const segment: TranscriptSegment = {
      id: `${this.request.sessionId}:${this.ordinal}`,
      ordinal: this.ordinal,
      revision: this.revision++,
      startMs: result.startMs,
      endMs: result.endMs,
      text: result.text,
      language: isFinal
        ? mapDetectedLanguage(result.language, result.languageProbability, this.request.candidateLanguages)
        : { tag: "und" },
      isFinal,
    };
    this.emitEnvelope({ type: "segment.upsert", segment });
    if (isFinal) {
      this.currentFinalized = true;
      this.prompt = result.text.trim();
      this.ordinal += 1;
      this.revision = 0;
      this.trimRetainedAudio();
    }
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

  private buildWindow(): Int16Array {
    if (this.frames.length === 0) return new Int16Array(0);
    const last = this.frames.at(-1)!;
    const utteranceEndMs = last.startMs + FRAME_DURATION_MS;
    const windowStartMs = Math.max(this.utteranceStartMs, utteranceEndMs - this.maxWindowMs);
    const overlapStartMs = Math.max(0, windowStartMs - this.overlapMs);
    const selected = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > overlapStartMs && frame.startMs < utteranceEndMs);
    const total = selected.reduce((sum, frame) => sum + frame.samples.length, 0);
    const audio = new Int16Array(total);
    let offset = 0;
    for (const frame of selected) {
      audio.set(frame.samples, offset);
      offset += frame.samples.length;
    }
    return audio;
  }

  private trimRetainedAudio(): void {
    const retainFromMs = Math.max(0, this.utteranceEndMs() - this.overlapMs);
    this.frames = this.frames.filter((frame) => frame.startMs + FRAME_DURATION_MS > retainFromMs);
  }

  private utteranceEndMs(): number {
    const last = this.frames.at(-1);
    return last ? last.startMs + FRAME_DURATION_MS : 0;
  }

  private hasUnfinalizedSpeech(): boolean {
    return this.speechSeen && !this.currentFinalized && !this.finalOutstanding;
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
