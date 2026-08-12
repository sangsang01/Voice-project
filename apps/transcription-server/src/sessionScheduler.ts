import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";

import { mapDetectedLanguage } from "./languageMap.js";
import type { DecodeResult, StreamingRuntimeSession } from "./runtime.js";

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

const DEFAULT_DECODE_INTERVAL_MS = 750;
const DEFAULT_MAX_WINDOW_MS = 8_000;
const DEFAULT_OVERLAP_MS = 500;

/**
 * Drives rolling provisional/final transcript revisions for one session from
 * VAD boundary updates. Pure with respect to I/O: audio arrives via push(),
 * decodes are delegated to the injected runtime, and timing is delegated to
 * the injected clock/timer so tests can control both deterministically.
 */
export class SessionScheduler {
  private readonly request: SessionRequest;
  private readonly runtime: StreamingRuntimeSession;
  private readonly emitEvent: (event: EngineEvent) => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly decodeIntervalMs: number;
  private readonly maxWindowMs: number;
  private readonly overlapMs: number;

  private sequence = 0;
  private ordinal = 0;
  private nextRevision = 0;
  private lastText = "";
  private speaking = false;
  private decoding = false;
  private tickPending = false;
  private finalRequested = false;
  private cancelled = false;
  private stopped = false;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private frames: PcmFrame[] = [];
  private resolveStop: (() => void) | undefined;
  private stoppingPromise: Promise<void> | undefined;

  public constructor(options: SessionSchedulerOptions) {
    this.request = options.request;
    this.runtime = options.runtime;
    this.emitEvent = options.emit;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.decodeIntervalMs = options.decodeIntervalMs ?? DEFAULT_DECODE_INTERVAL_MS;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  }

  public push(frame: PcmFrame): void {
    if (this.cancelled || this.stopped) return;
    this.appendFrame(frame);
    const update = this.runtime.push(frame);
    if (update.speechStarted && !this.speaking) {
      this.speaking = true;
      this.scheduleTick();
    }
    if (update.speechEnded && this.speaking) {
      this.speaking = false;
      this.clearTick();
      this.requestFinal();
    }
  }

  public stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stopped = true;
    this.clearTick();
    this.stoppingPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    if (this.speaking) {
      this.speaking = false;
      this.requestFinal();
    }
    this.maybeResolveStop();
    return this.stoppingPromise;
  }

  public cancel(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.cancelled = true;
    this.stopped = true;
    this.speaking = false;
    this.finalRequested = false;
    this.tickPending = false;
    this.clearTick();
    this.stoppingPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.maybeResolveStop();
    return this.stoppingPromise;
  }

  private appendFrame(frame: PcmFrame): void {
    this.frames.push(frame);
    const frameDurationMs = this.request.audio.frameDurationMs;
    const newestEndMs = frame.startMs + frameDurationMs;
    const retainFromMs = Math.max(0, newestEndMs - this.maxWindowMs);
    while (this.frames.length > 0 && this.frames[0]!.startMs + frameDurationMs <= retainFromMs) {
      this.frames.shift();
    }
  }

  private currentWindow(): Int16Array {
    const total = this.frames.reduce((sum, frame) => sum + frame.samples.length, 0);
    const audio = new Int16Array(total);
    let offset = 0;
    for (const frame of this.frames) {
      audio.set(frame.samples, offset);
      offset += frame.samples.length;
    }
    return audio;
  }

  private scheduleTick(): void {
    this.tickTimer = this.setTimer(() => this.onTick(), this.decodeIntervalMs);
  }

  private clearTick(): void {
    if (this.tickTimer !== undefined) {
      this.clearTimer(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private onTick(): void {
    this.tickTimer = undefined;
    if (this.cancelled || this.stopped || !this.speaking) return;
    if (this.decoding) {
      this.tickPending = true;
    } else {
      void this.runProvisionalDecode();
    }
    this.scheduleTick();
  }

  private requestFinal(): void {
    if (this.decoding) {
      this.finalRequested = true;
      this.tickPending = false;
      return;
    }
    void this.runFinalDecode();
  }

  private async runProvisionalDecode(): Promise<void> {
    this.decoding = true;
    const audio = this.currentWindow();
    try {
      const result = await this.runtime.decode("provisional", audio, this.lastText);
      if (!this.cancelled) this.emitSegment(result, false);
    } catch {
      // Decode failures surface as engine warnings/errors from the gateway, not here.
    } finally {
      this.afterDecodeSettled();
    }
  }

  private async runFinalDecode(): Promise<void> {
    this.decoding = true;
    const audio = this.currentWindow();
    try {
      const result = await this.runtime.decode("final", audio, this.lastText);
      if (!this.cancelled) {
        this.emitSegment(result, true);
        this.finishUtterance();
      }
    } catch {
      // Decode failures surface as engine warnings/errors from the gateway, not here.
    } finally {
      this.afterDecodeSettled();
    }
  }

  private afterDecodeSettled(): void {
    this.decoding = false;
    if (this.cancelled) {
      this.maybeResolveStop();
      return;
    }
    if (this.finalRequested) {
      this.finalRequested = false;
      this.tickPending = false;
      void this.runFinalDecode();
      return;
    }
    if (this.tickPending) {
      this.tickPending = false;
      void this.runProvisionalDecode();
      return;
    }
    this.maybeResolveStop();
  }

  private maybeResolveStop(): void {
    if (this.stopped && !this.decoding && this.resolveStop) {
      const resolve = this.resolveStop;
      this.resolveStop = undefined;
      resolve();
    }
  }

  private finishUtterance(): void {
    this.ordinal += 1;
    this.nextRevision = 0;
    this.lastText = "";
    // Keep a trailing overlap window rather than clearing outright, so a
    // fast-following utterance still has lead-in context for its onset.
    const frameDurationMs = this.request.audio.frameDurationMs;
    const newestEndMs = this.frames.at(-1) ? this.frames.at(-1)!.startMs + frameDurationMs : 0;
    const retainFromMs = Math.max(0, newestEndMs - this.overlapMs);
    this.frames = this.frames.filter((frame) => frame.startMs + frameDurationMs > retainFromMs);
  }

  private emitSegment(result: DecodeResult, isFinal: boolean): void {
    const revision = this.nextRevision;
    this.nextRevision += 1;
    this.lastText = result.text;
    const language = isFinal
      ? mapDetectedLanguage(result.language, 1, this.request.candidateLanguages)
      : { tag: "und" as const };
    this.emitEvent({
      type: "segment.upsert",
      sessionId: this.request.sessionId,
      sequence: this.sequence++,
      segment: {
        id: `${this.request.sessionId}:${this.ordinal}`,
        ordinal: this.ordinal,
        revision,
        startMs: result.startMs,
        endMs: result.endMs,
        text: result.text,
        language,
        isFinal,
      },
    });
  }
}
