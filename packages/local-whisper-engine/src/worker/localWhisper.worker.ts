import type { EngineEvent, PcmFrame, SessionRequest, TranscriptSegment } from "@voice/transcription-contracts";

import { LOCAL_MODEL } from "../modelManifest.js";
import type { InferenceDevice, MainToWorker, WorkerEvent } from "./protocol.js";

export interface WhisperRuntime {
  load(
    options: { device: InferenceDevice; onProgress(progress: number): void },
    signal: AbortSignal,
  ): Promise<void>;
  transcribe(
    samples: Float32Array,
    signal: AbortSignal,
    language: string,
  ): Promise<{ text: string; startMs: number; endMs: number }>;
  dispose(): Promise<void>;
}

interface WorkerControllerOptions {
  now?: () => number;
  maxBufferedFrames?: number;
  windowFrames?: number;
  transcribeTimeoutMs?: number;
}

interface ActiveSession {
  request: SessionRequest;
  frames: PcmFrame[];
  abort: AbortController;
  sequence: number;
  revision: number;
  slowWindows: number;
  terminal: boolean;
}

type EventWithoutEnvelope = EngineEvent extends infer Event
  ? Event extends EngineEvent
    ? Omit<Event, "sessionId" | "sequence">
    : never
  : never;

const FRAME_MS = 20;

class TranscribeTimeoutError extends Error {}

export function createWorkerController(
  runtime: WhisperRuntime,
  post: (event: WorkerEvent) => void,
  options: WorkerControllerOptions = {},
) {
  const now = options.now ?? (() => performance.now());
  // Whisper always runs its encoder over a fixed-length (~30s-padded) window, so a
  // transcribe() call costs roughly the same fixed amount regardless of how little real
  // audio it covers. Measured on whisper-small/q8: ~1.8-2.0s fixed cost per call, vs.
  // ~0.8s for whisper-tiny. A short window asks for that fixed cost too often, which is
  // slower than realtime on modest hardware and starves the queue. 400 frames (8s)
  // amortizes the larger model's fixed cost over enough audio to stay realtime.
  const windowFrames = options.windowFrames ?? 400;
  // Must comfortably exceed windowFrames: frames keep arriving in real time while one
  // window is transcribing, so the buffer needs headroom for windowFrames worth of
  // ramp-up plus the frames that land during a single (possibly slow) transcribe call.
  const maxBufferedFrames = options.maxBufferedFrames ?? 800;
  const transcribeTimeoutMs = options.transcribeTimeoutMs ?? 30_000;
  let loadAbort = new AbortController();
  let active: ActiveSession | undefined;
  let commandQueue = Promise.resolve();

  const emit = (session: ActiveSession, event: EventWithoutEnvelope) => {
    post({
      type: "event",
      event: { ...event, sessionId: session.request.sessionId, sequence: session.sequence++ } as EngineEvent,
    });
  };

  const emitState = (session: ActiveSession, state: "listening" | "draining" | "stopped") => {
    emit(session, { type: "state", state });
  };

  const convert = (frames: PcmFrame[]) => {
    const samples = new Float32Array(frames.length * 320);
    for (let index = 0; index < frames.length; index += 1) {
      const input = frames[index]!.samples;
      for (let sample = 0; sample < input.length; sample += 1) {
        samples[index * 320 + sample] = input[sample]! / 0x8000;
      }
    }
    return samples;
  };

  const runTranscribe = (session: ActiveSession, samples: Float32Array, language: string) => {
    return new Promise<{ text: string; startMs: number; endMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TranscribeTimeoutError("Local transcription timed out")), transcribeTimeoutMs);
      runtime.transcribe(samples, session.abort.signal, language).then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  };

  const transcribe = async (session: ActiveSession, frames: PcmFrame[], isFinal: boolean) => {
    if (frames.length === 0 || session.terminal) return;
    const started = now();
    let result: { text: string; startMs: number; endMs: number };
    try {
      // Whisper's `language` hint takes a bare ISO 639-1 code (e.g. "en"), not a
      // BCP-47 tag, so trim the region subtag off the primary candidate language.
      const language = session.request.candidateLanguages[0]!.split("-")[0]!.toLowerCase();
      result = await runTranscribe(session, convert(frames), language);
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
    if (session.terminal || session.abort.signal.aborted) return;
    const elapsed = now() - started;
    const duration = frames.length * FRAME_MS;
    session.slowWindows = elapsed > duration ? session.slowWindows + 1 : 0;
    if (session.slowWindows === 3) {
      emit(session, {
        type: "warning",
        code: "DEGRADED_PERFORMANCE",
        message: "Local inference is slower than realtime.",
      });
    }
    const first = frames[0]!;
    const last = frames.at(-1)!;
    const segment: TranscriptSegment = {
      id: `${session.request.sessionId}:0`,
      ordinal: 0,
      revision: ++session.revision,
      startMs: result.startMs || first.startMs,
      endMs: result.endMs || last.startMs + FRAME_MS,
      text: result.text,
      language: { tag: session.request.candidateLanguages[0] },
      isFinal,
    };
    emit(session, { type: "segment.upsert", segment });
  };

  const credit = (session: ActiveSession, frames: number) => {
    if (frames > 0) post({ type: "credit", sessionId: session.request.sessionId, frames });
  };

  const drainWindow = async (session: ActiveSession, final: boolean) => {
    if (session.frames.length === 0) return;
    const frames = final ? session.frames.splice(0) : session.frames.slice(0, windowFrames);
    await transcribe(session, frames, final);
    if (!final) {
      const consumed = Math.max(0, frames.length - 1);
      session.frames.splice(0, consumed);
      credit(session, consumed);
    } else {
      credit(session, frames.length);
    }
  };

  const handleMessage = async (message: MainToWorker): Promise<void> => {
      switch (message.type) {
        case "prepare": {
          loadAbort.abort();
          loadAbort = new AbortController();
          try {
            await runtime.load({ device: message.device, onProgress: (progress) => post({ type: "progress", requestId: message.requestId, progress }) }, loadAbort.signal);
            post({ type: "prepared", requestId: message.requestId, device: message.device });
          } catch (error) {
            if (!loadAbort.signal.aborted) {
              post({ type: "prepare.error", requestId: message.requestId, device: message.device, message: error instanceof Error ? error.message : String(error) });
            }
          }
          return;
        }
        case "open": {
          active?.abort.abort();
          active = { request: message.request, frames: [], abort: new AbortController(), sequence: 0, revision: 0, slowWindows: 0, terminal: false };
          emitState(active, "listening");
          return;
        }
        case "push": {
          if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
          if (active.frames.length >= maxBufferedFrames) {
            emit(active, { type: "warning", code: "AUDIO_GAP", message: "Local audio buffer is full." });
            return;
          }
          active.frames.push(message.frame);
          if (active.frames.length >= windowFrames) await drainWindow(active, false);
          return;
        }
        case "stop": {
          if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
          emitState(active, "draining");
          await drainWindow(active, true);
          active.terminal = true;
          emitState(active, "stopped");
          return;
        }
        case "cancel": {
          if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
          active.terminal = true;
          active.abort.abort();
          active.frames = [];
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

async function createTransformersRuntime(): Promise<WhisperRuntime> {
  type Pipeline = (
    samples: Float32Array,
    options: { num_beams: number; language: string; task: "transcribe" },
  ) => Promise<{ text: string; chunks?: Array<{ timestamp?: [number, number] }> }>;
  let pipeline: Pipeline | undefined;
  return {
    async load({ device, onProgress }, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const transformers = (await import("@huggingface/transformers")) as {
        pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Pipeline>;
      };
      pipeline = await transformers.pipeline(LOCAL_MODEL.task, LOCAL_MODEL.id, {
        revision: LOCAL_MODEL.revision,
        device,
        dtype: "q8",
        progress_callback: (progress: { progress?: number }) => onProgress(progress.progress ?? 0),
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onProgress(1);
    },
    async transcribe(samples, signal, language) {
      if (!pipeline) throw new Error("Whisper model is not loaded");
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      // num_beams: 1 -> greedy decoding (fastest). task: "transcribe" -> never translate,
      // matching this app's "keep spoken text as-is" design. language hints the decoder
      // with the user's selected primary language instead of paying for auto-detection.
      const output = await pipeline(samples, { num_beams: 1, language, task: "transcribe" });
      const timestamp = output.chunks?.[0]?.timestamp;
      return { text: output.text, startMs: (timestamp?.[0] ?? 0) * 1000, endMs: (timestamp?.[1] ?? samples.length / 16000) * 1000 };
    },
    async dispose() {
      pipeline = undefined;
    },
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const workerScope = globalThis as unknown as {
    postMessage(event: WorkerEvent): void;
    onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  };
  void createTransformersRuntime().then((runtime) => {
    const controller = createWorkerController(runtime, (event) => workerScope.postMessage(event));
    workerScope.onmessage = (event: MessageEvent<MainToWorker>) => { void controller.handle(event.data); };
  });
}
