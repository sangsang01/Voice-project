import { describeEngineContract, makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import { LocalWhisperEngine, type WorkerLike } from "../src/LocalWhisperEngine.js";
import { createWorkerController, type WhisperRuntime } from "../src/worker/localWhisper.worker.js";
import type { MainToWorker, WorkerEvent } from "../src/worker/protocol.js";
import { VAD_DEFAULTS } from "../src/worker/vadGate.js";

class RuntimeWorker implements WorkerLike {
  public onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public terminated = false;
  private readonly controller;

  public constructor(runtime: WhisperRuntime) {
    this.controller = createWorkerController(runtime, (event) => this.onmessage?.({ data: event } as MessageEvent<WorkerEvent>));
  }

  public postMessage(message: MainToWorker): void {
    void this.controller.handle(message);
  }

  public terminate(): void {
    this.terminated = true;
    void this.controller.dispose();
  }
}

function runtime(): WhisperRuntime {
  return {
    load: async ({ onProgress }) => onProgress(1),
    vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
    transcribe: async () => ({ text: "hello", language: "en", languageProbability: 1 }),
    dispose: async () => undefined,
  };
}

// This engine only emits a segment once enough speech-classified audio has
// crossed VAD_DEFAULTS.minSpeechMs -- one 20ms frame can't even fill a single
// 512-sample Silero window. Push comfortably more than minSpeechMs worth of
// frames (double it, for margin around window quantization) so the generic
// lifecycle test's "push, then stop" still yields exactly one utterance.
const framesBeforeStop = Math.ceil((VAD_DEFAULTS.minSpeechMs * 2) / 20);

describeEngineContract("local whisper", () => new LocalWhisperEngine({ workerFactory: () => new RuntimeWorker(runtime()) }), {
  request: makeSessionRequest(["en-US"]),
  frame: makePcmFrame(0),
  framesBeforeStop,
});

// Worker-controller-specific behavior (VAD-driven utterance boundaries, buffer
// backpressure, fatal-error propagation) has its own dedicated coverage in
// test/workerController.test.ts, written against the new VAD-gated session
// loop. The fixed-window-batching tests that used to live here (device
// selection, windowFrames-based draining, per-window revisions, transcribe
// timeouts) tested the old fixed-window runtime this file
// replaced and no longer apply -- there is no more "window", no per-window
// revision bump, and no transcribeTimeoutMs option.
