import type { EngineEvent, PcmFrame, SessionRequest, TranscriptSegment } from "@voice/transcription-contracts";

import { mapDetectedLanguage } from "../segmentation/languageMap.js";
import { createBridgeRuntime, type WhisperRuntime } from "./bridgeRuntime.js";
import type { MainToWorker, WorkerEvent } from "./protocol.js";
import { createVadGate, VAD_DEFAULTS, type VadGateConfig } from "./vadGate.js";

export type { WhisperRuntime } from "./bridgeRuntime.js";

interface WorkerControllerOptions {
  /** ~60s of audio at 20ms per frame. */
  maxBufferedFrames?: number;
  vad?: Partial<VadGateConfig>;
  transcribeTimeoutMs?: number;
  /** Injectable monotonic clock for deterministic controller tests. */
  now?: () => number;
}

interface ActiveSession {
  request: SessionRequest;
  abort: AbortController;
  sequence: number;
  ordinal: number;
  terminal: boolean;
  /** Whole-session audio, trimmed once an utterance is transcribed. */
  audio: Float32Array[];
  audioStartMs: number;
  bufferedFrames: number;
  consecutiveSlowTranscriptions: number;
  gate: ReturnType<typeof createVadGate>;
  vadCarry: Float32Array;
  windowIndex: number;
}

type EventWithoutEnvelope = EngineEvent extends infer Event
  ? Event extends EngineEvent
    ? Omit<Event, "sessionId" | "sequence">
    : never
  : never;

const FRAME_MS = 20;
const FRAME_SAMPLES = 320;
const VAD_WINDOW_SAMPLES = 512;
const SAMPLE_RATE = 16_000;

type TranscribeResult = Awaited<ReturnType<WhisperRuntime["transcribe"]>>;

/** Distinguishes a timed-out transcription from any other transcribe() rejection. */
class TranscribeTimeoutError extends Error {}

export function createWorkerController(
  runtime: WhisperRuntime,
  post: (event: WorkerEvent) => void,
  options: WorkerControllerOptions = {},
) {
  const maxBufferedFrames = options.maxBufferedFrames ?? 3000;
  const transcribeTimeoutMs = options.transcribeTimeoutMs ?? 30_000;
  const now = options.now ?? (() => performance.now());
  let loadAbort = new AbortController();
  let active: ActiveSession | undefined;
  let commandQueue = Promise.resolve();

  /**
   * Races runtime.transcribe() against transcribeTimeoutMs. The WASM build has no GPU
   * acceleration, so a pathologically slow or hung whisper_full() call is plausible, and
   * without this the session would hang forever with no error and no "stopped" state.
   * The timer is cleared on BOTH settle paths so a late-firing timer can never reject an
   * already-resolved promise, and so it does not keep the event loop alive.
   */
  const runTranscribe = (session: ActiveSession, samples: Float32Array): Promise<TranscribeResult> => {
    return new Promise<TranscribeResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TranscribeTimeoutError("Local transcription timed out")), transcribeTimeoutMs);
      runtime.transcribe(samples, session.abort.signal).then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  };

  const emit = (session: ActiveSession, event: EventWithoutEnvelope) => {
    post({
      type: "event",
      event: { ...event, sessionId: session.request.sessionId, sequence: session.sequence++ } as EngineEvent,
    });
  };

  const emitState = (session: ActiveSession, state: "listening" | "draining" | "stopped") =>
    emit(session, { type: "state", state });

  /** int16 frame -> normalised float32, the format both whisper and Silero want. */
  const toFloat = (frame: PcmFrame): Float32Array => {
    const out = new Float32Array(frame.samples.length);
    for (let index = 0; index < frame.samples.length; index += 1) {
      out[index] = frame.samples[index]! / 0x8000;
    }
    return out;
  };

  const concat = (chunks: readonly Float32Array[]): Float32Array => {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };

  /** Slices the session buffer for [startMs, endMs), clamped to what we still hold. */
  const sliceAudio = (session: ActiveSession, startMs: number, endMs: number): Float32Array => {
    const all = concat(session.audio);
    const from = Math.max(0, Math.floor(((startMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    const to = Math.min(all.length, Math.ceil(((endMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    return from >= to ? new Float32Array(0) : all.slice(from, to);
  };

  /** Drops audio older than the flushed utterance so memory stays bounded. */
  const trimAudio = (session: ActiveSession, upToMs: number) => {
    const all = concat(session.audio);
    const cut = Math.max(0, Math.floor(((upToMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    if (cut <= 0) return;
    const remaining = all.slice(Math.min(cut, all.length));
    session.audio = remaining.length > 0 ? [remaining] : [];
    session.audioStartMs = upToMs;
    const releasedFrames = Math.floor(cut / FRAME_SAMPLES);
    if (releasedFrames > 0) {
      session.bufferedFrames = Math.max(0, session.bufferedFrames - releasedFrames);
      post({ type: "credit", sessionId: session.request.sessionId, frames: releasedFrames });
    }
  };

  const transcribeUtterance = async (session: ActiveSession, startMs: number, endMs: number) => {
    const samples = sliceAudio(session, startMs, endMs);
    if (samples.length === 0 || session.terminal) return;

    const startedAt = now();
    try {
      const result = await runTranscribe(session, samples);
      if (session.terminal || session.abort.signal.aborted) return;

      const elapsedMs = now() - startedAt;
      const audioDurationMs = endMs - startMs;
      session.consecutiveSlowTranscriptions = elapsedMs > audioDurationMs
        ? session.consecutiveSlowTranscriptions + 1
        : 0;
      if (session.consecutiveSlowTranscriptions === 3) {
        emit(session, {
          type: "warning",
          code: "DEGRADED_PERFORMANCE",
          message: "Local transcription is slower than realtime.",
        });
      }

      const text = result.text.trim();
      if (text.length > 0) {
        const ordinal = session.ordinal++;
        const segment: TranscriptSegment = {
          id: `${session.request.sessionId}:${ordinal}`,
          ordinal,
          revision: 1,
          startMs,
          endMs,
          text,
          language: mapDetectedLanguage(result.language, result.languageProbability, session.request.candidateLanguages),
          isFinal: true,
        };
        emit(session, { type: "segment.upsert", segment });
      }
    } catch (error) {
      if (session.terminal || session.abort.signal.aborted) return;
      session.terminal = true;
      session.abort.abort();
      emit(session, {
        type: "error",
        code: error instanceof TranscribeTimeoutError ? "TIMEOUT" : "INTERNAL",
        fatal: true,
        message: error instanceof Error ? error.message : "Local transcription failed",
      });
      emitState(session, "stopped");
      return;
    }
    trimAudio(session, endMs);
  };

  /**
   * Silero consumes fixed 512-sample windows, but microphone frames are 320
   * samples, so whatever does not fill a window is carried into the next push.
   */
  const runVad = async (session: ActiveSession, chunk: Float32Array) => {
    const merged = concat([session.vadCarry, chunk]);
    const windowCount = Math.floor(merged.length / VAD_WINDOW_SAMPLES);
    if (windowCount === 0) {
      session.vadCarry = merged;
      return;
    }

    const consumed = windowCount * VAD_WINDOW_SAMPLES;
    session.vadCarry = merged.slice(consumed);

    const probs = runtime.vadProbs(merged.slice(0, consumed));
    for (let index = 0; index < probs.length; index += 1) {
      const windowStartMs = (session.windowIndex++ * VAD_WINDOW_SAMPLES * 1000) / SAMPLE_RATE;
      const decision = session.gate.push(probs[index]!, windowStartMs);
      if (decision.type === "flush") {
        await transcribeUtterance(session, decision.startMs, decision.endMs);
      }
    }
  };

  const handleMessage = async (message: MainToWorker): Promise<void> => {
    switch (message.type) {
      case "prepare": {
        loadAbort.abort();
        loadAbort = new AbortController();
        try {
          await runtime.load({ onProgress: (progress) => post({ type: "progress", requestId: message.requestId, progress }) }, loadAbort.signal);
          post({ type: "prepared", requestId: message.requestId });
        } catch (error) {
          if (!loadAbort.signal.aborted) {
            post({ type: "prepare.error", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return;
      }

      case "open": {
        active?.abort.abort();
        active = {
          request: message.request,
          abort: new AbortController(),
          sequence: 0,
          ordinal: 0,
          terminal: false,
          audio: [],
          audioStartMs: 0,
          bufferedFrames: 0,
          consecutiveSlowTranscriptions: 0,
          gate: createVadGate({ ...VAD_DEFAULTS, ...options.vad }),
          vadCarry: new Float32Array(0),
          windowIndex: 0,
        };
        emitState(active, "listening");
        return;
      }

      case "push": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        if (active.bufferedFrames >= maxBufferedFrames) {
          emit(active, { type: "warning", code: "AUDIO_GAP", message: "Local audio buffer is full." });
          return;
        }
        const chunk = toFloat(message.frame);
        active.audio.push(chunk);
        active.bufferedFrames += 1;
        await runVad(active, chunk);
        return;
      }

      case "stop": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        emitState(active, "draining");
        const nowMs = active.audioStartMs + (active.bufferedFrames * FRAME_MS);
        const decision = active.gate.flushPending(nowMs);
        if (decision.type === "flush") {
          await transcribeUtterance(active, decision.startMs, decision.endMs);
        }
        if (!active.terminal) {
          active.terminal = true;
          emitState(active, "stopped");
        }
        return;
      }

      case "cancel": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        active.terminal = true;
        active.abort.abort();
        active.audio = [];
        active.gate.reset();
        emitState(active, "stopped");
        return;
      }

      case "dispose":
        loadAbort.abort();
        active?.abort.abort();
        if (active) active.terminal = true;
        await runtime.dispose();
    }
  };

  return {
    handle(message: MainToWorker): Promise<void> {
      const result = commandQueue.then(() => handleMessage(message));
      commandQueue = result.catch(() => undefined);
      return result;
    },
    async dispose(): Promise<void> {
      loadAbort.abort();
      active?.abort.abort();
      if (active) active.terminal = true;
      await runtime.dispose();
    },
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const workerScope = globalThis as unknown as {
    postMessage(event: WorkerEvent): void;
    onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  };
  const controller = createWorkerController(createBridgeRuntime(), (event) => workerScope.postMessage(event));
  workerScope.onmessage = (event: MessageEvent<MainToWorker>) => { void controller.handle(event.data); };
}
