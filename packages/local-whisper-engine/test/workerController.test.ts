import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, PcmFrame } from "@voice/transcription-contracts";
import { createWorkerController, type WhisperRuntime } from "../src/worker/localWhisper.worker.js";
import type { WorkerEvent } from "../src/worker/protocol.js";
import { VAD_DEFAULTS } from "../src/worker/vadGate.js";

const SESSION = "session-1";
const request = {
  sessionId: SESSION,
  candidateLanguages: ["en-US", "vi-VN"] as const,
  mode: "transcribe" as const,
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 } as const,
};

function frame(sequence: number): PcmFrame {
  return { sequence, startMs: sequence * 20, samples: new Int16Array(320) };
}

/** Speech for `speechFrames`, then silence -- enough to trigger exactly one flush. */
function fakeRuntime(overrides: Partial<WhisperRuntime> = {}) {
  let windowsSeen = 0;
  const speechWindows = Math.ceil((VAD_DEFAULTS.minSpeechMs + 100) / VAD_DEFAULTS.windowMs);
  return {
    transcribeCalls: [] as Float32Array[],
    runtime: {
      load: async ({ onProgress }) => onProgress(1),
      vadProbs: (samples: Float32Array) => {
        const count = Math.floor(samples.length / 512);
        const probs = new Float32Array(count);
        for (let index = 0; index < count; index += 1) {
          probs[index] = windowsSeen++ < speechWindows ? 0.9 : 0.1;
        }
        return probs;
      },
      transcribe: async () => ({ text: "hello world", language: "en", languageProbability: 1 }),
      dispose: async () => undefined,
      ...overrides,
    } as WhisperRuntime,
  };
}

function collect() {
  const events: WorkerEvent[] = [];
  return { events, post: (event: WorkerEvent) => events.push(event) };
}

const engineEvents = (events: WorkerEvent[]): EngineEvent[] =>
  events.flatMap((event) => (event.type === "event" ? [event.event] : []));

function performanceRuntime(elapsedMs: readonly number[], clock: { value: number }) {
  let windowsSeen = 0;
  let transcriptions = 0;
  const { runtime } = fakeRuntime({
    vadProbs: (samples: Float32Array) => {
      const probs = new Float32Array(Math.floor(samples.length / 512));
      for (let index = 0; index < probs.length; index += 1) {
        // 8 speech windows satisfy minSpeechMs; 16 silence windows flush the utterance.
        probs[index] = windowsSeen++ % 24 < 8 ? 0.9 : 0.1;
      }
      return probs;
    },
    transcribe: async () => {
      clock.value += elapsedMs[transcriptions++] ?? 0;
      return { text: "utterance", language: "en", languageProbability: 1 };
    },
  });
  return runtime;
}

async function pushUtterances(
  controller: ReturnType<typeof createWorkerController>,
  utterances: number,
) {
  // Every 40 frames supplies 25 VAD windows, enough to flush one 24-window utterance.
  for (let index = 0; index < utterances * 40; index += 1) {
    await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
  }
}

describe("worker controller", () => {
  it("emits one final segment per detected utterance", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime();
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    // 60 frames = 1200ms: past minSpeech, then past minSilence.
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      segment: { text: "hello world", isFinal: true, ordinal: 0, language: { tag: "en-US" } },
    });
  });

  it("gives each utterance its own id and ordinal", async () => {
    const { post, events } = collect();
    let window = 0;
    const runtime = {
      load: async ({ onProgress }: { onProgress(n: number): void }) => onProgress(1),
      vadProbs: (samples: Float32Array) => {
        const count = Math.floor(samples.length / 512);
        const probs = new Float32Array(count);
        // 20 windows speech, 20 silence, repeating -- two full utterances.
        for (let index = 0; index < count; index += 1) probs[index] = window++ % 40 < 20 ? 0.9 : 0.1;
        return probs;
      },
      transcribe: async () => ({ text: "utterance", language: "en", languageProbability: 1 }),
      dispose: async () => undefined,
    } as WhisperRuntime;

    const controller = createWorkerController(runtime, post);
    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 140; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const ids = segments.map((event) => (event.type === "segment.upsert" ? event.segment.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
    expect(segments.every((event) => event.type === "segment.upsert" && event.segment.isFinal)).toBe(true);
  });

  it("labels und when whisper hears a language the user did not select", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: async () => ({ text: "guten tag", language: "de", languageProbability: 1 }),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments[0]).toMatchObject({ segment: { language: { tag: "und" } } });
  });

  it("transcribes speech still in flight when the session stops", async () => {
    const { post, events } = collect();
    const transcribe = vi.fn(async () => ({ text: "trailing", language: "en", languageProbability: 1 }));
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
      transcribe,
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 30; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    await controller.handle({ type: "stop", sessionId: SESSION });

    expect(transcribe).toHaveBeenCalled();
    const states = engineEvents(events).filter((event) => event.type === "state");
    expect(states.at(-1)).toMatchObject({ state: "stopped" });
  });

  it("emits no segment for silence alone", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.05),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 100; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(engineEvents(events).filter((event) => event.type === "segment.upsert")).toHaveLength(0);
  });

  it("warns and drops audio once the buffer cap is exceeded", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
    });
    const controller = createWorkerController(runtime, post, { maxBufferedFrames: 10 });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 40; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const warnings = engineEvents(events).filter((event) => event.type === "warning");
    expect(warnings.some((event) => event.type === "warning" && event.code === "AUDIO_GAP")).toBe(true);
  });

  it("reports a failed transcription as a fatal error", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: async () => { throw new Error("bridge exploded"); },
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const errors = engineEvents(events).filter((event) => event.type === "error");
    expect(errors[0]).toMatchObject({ code: "INTERNAL", fatal: true });
  });

  it("warns once for sustained slow transcription and still emits every segment", async () => {
    const { post, events } = collect();
    const clock = { value: 0 };
    const controller = createWorkerController(performanceRuntime([1_000, 1_000, 1_000, 1_000], clock), post, {
      now: () => clock.value,
    });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    await pushUtterances(controller, 4);

    const warnings = engineEvents(events).filter((event) => event.type === "warning");
    expect(warnings.filter((event) => event.type === "warning" && event.code === "DEGRADED_PERFORMANCE")).toHaveLength(1);
    expect(engineEvents(events).filter((event) => event.type === "segment.upsert")).toHaveLength(4);
  });

  it("does not warn when nonzero transcriptions are faster than their audio", async () => {
    const { post, events } = collect();
    const clock = { value: 0 };
    // The first utterance is 356ms; subsequent utterances are 456ms.
    const controller = createWorkerController(performanceRuntime([300, 400, 400, 400], clock), post, {
      now: () => clock.value,
    });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    await pushUtterances(controller, 4);

    expect(engineEvents(events).filter((event) => event.type === "warning" && event.code === "DEGRADED_PERFORMANCE")).toHaveLength(0);
  });

  it("treats transcription matching audio duration as realtime", async () => {
    const { post, events } = collect();
    const clock = { value: 0 };
    // Equality is not slower-than: the first utterance is 356ms, then 456ms each.
    const controller = createWorkerController(performanceRuntime([356, 456, 456, 456], clock), post, {
      now: () => clock.value,
    });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    await pushUtterances(controller, 4);

    expect(engineEvents(events).filter((event) => event.type === "warning" && event.code === "DEGRADED_PERFORMANCE")).toHaveLength(0);
  });

  it("does not warn until three new consecutive slow transcriptions", async () => {
    const { post, events } = collect();
    const clock = { value: 0 };
    const controller = createWorkerController(performanceRuntime([1_000, 1_000, 0, 1_000], clock), post, {
      now: () => clock.value,
    });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    await pushUtterances(controller, 4);

    expect(engineEvents(events).filter((event) => event.type === "warning" && event.code === "DEGRADED_PERFORMANCE")).toHaveLength(0);
  });

  it("rearms after a fast transcription and continues emitting segments", async () => {
    const { post, events } = collect();
    const clock = { value: 0 };
    const controller = createWorkerController(performanceRuntime([1_000, 1_000, 1_000, 0, 1_000, 1_000, 1_000], clock), post, {
      now: () => clock.value,
    });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    await pushUtterances(controller, 7);

    expect(engineEvents(events).filter((event) => event.type === "warning" && event.code === "DEGRADED_PERFORMANCE")).toHaveLength(2);
    expect(engineEvents(events).filter((event) => event.type === "segment.upsert")).toHaveLength(7);
  });

  it("times out a hung transcription as a fatal error, exactly once", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: () => new Promise(() => { /* never resolves, simulating a hung whisper_full() call */ }),
    });
    const controller = createWorkerController(runtime, post, { transcribeTimeoutMs: 50 });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const errors = engineEvents(events).filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "TIMEOUT", fatal: true });
    const states = engineEvents(events).filter((event) => event.type === "state");
    expect(states.at(-1)).toMatchObject({ state: "stopped" });
  });

  it("does not spuriously time out after a fast transcription already completed", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime();
    const controller = createWorkerController(runtime, post, { transcribeTimeoutMs: 50 });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    // Sit past the timeout window: a leaked timer would have its best chance to fire here.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments).toHaveLength(1);
    expect(engineEvents(events).filter((event) => event.type === "error")).toHaveLength(0);
  });
});
