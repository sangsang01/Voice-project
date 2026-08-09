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
  const vadReset = vi.fn();
  return {
    transcribeCalls: [] as Float32Array[],
    vadReset,
    runtime: {
      load: async ({ onProgress }) => onProgress(1),
      vadReset,
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
  it("resets native VAD before opening and after a silence-finalized utterance", async () => {
    const { post } = collect();
    const calls: string[] = [];
    const { runtime, vadReset } = fakeRuntime({
      vadProbs: (samples) => {
        calls.push("vad");
        return new Float32Array(Math.floor(samples.length / 512)).fill(calls.filter((call) => call === "vad").length <= 10 ? 0.9 : 0.1);
      },
      transcribe: async () => {
        calls.push("transcribe");
        return { text: "utterance", language: "en", languageProbability: 1 };
      },
    });
    vadReset.mockImplementation(() => calls.push("reset"));
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(vadReset).toHaveBeenCalledTimes(2);
    expect(calls[0]).toBe("reset");
    const transcribeIndex = calls.indexOf("transcribe");
    expect(calls[transcribeIndex - 1]).toBe("reset");
  });

  it("resets once for cancel, stop, and a replacement session", async () => {
    const { post } = collect();
    const { runtime, vadReset } = fakeRuntime({
      vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(0.05),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    await controller.handle({ type: "cancel", sessionId: SESSION });
    await controller.handle({ type: "open", request: { ...request, sessionId: "session-2" } });
    await controller.handle({ type: "stop", sessionId: "session-2" });
    await controller.handle({ type: "open", request: { ...request, sessionId: "session-3" } });
    await controller.handle({ type: "open", request: { ...request, sessionId: "session-4" } });

    expect(vadReset).toHaveBeenCalledTimes(6);
  });

  it("fails the matching session when native VAD reset throws", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({ vadReset: () => { throw new Error("VAD reset exploded"); } } as Partial<WhisperRuntime>);
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });

    expect(engineEvents(events)).toEqual([
      expect.objectContaining({ type: "error", sessionId: SESSION, code: "INTERNAL", fatal: true, message: "VAD reset exploded" }),
      expect.objectContaining({ type: "state", sessionId: SESSION, state: "stopped" }),
    ]);
  });

  it("fails instead of transcribing when native VAD reset throws at an utterance boundary", async () => {
    const { post, events } = collect();
    let resets = 0;
    const transcribe = vi.fn(async () => ({ text: "must not run", language: "en", languageProbability: 1 }));
    const { runtime } = fakeRuntime({
      vadReset: () => {
        resets += 1;
        if (resets === 2) throw new Error("boundary reset exploded");
      },
      transcribe,
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(transcribe).not.toHaveBeenCalled();
    expect(engineEvents(events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", sessionId: SESSION, code: "INTERNAL", fatal: true, message: "boundary reset exploded" }),
      expect.objectContaining({ type: "state", sessionId: SESSION, state: "stopped" }),
    ]));
  });

  it("waits for max-duration forward padding and keeps samples aligned with overlapping timestamps", async () => {
    const { post, events } = collect();
    const transcriptions: Float32Array[] = [];
    const order: string[] = [];
    const vadReset = vi.fn(() => order.push("reset"));
    const runtime = {
      load: async ({ onProgress }: { onProgress(n: number): void }) => onProgress(1),
      vadReset,
      vadProbs: (samples: Float32Array) => {
        order.push("vad");
        return new Float32Array(Math.floor(samples.length / 512)).fill(0.9);
      },
      transcribe: async (samples: Float32Array) => {
        order.push("transcribe");
        transcriptions.push(samples);
        return { text: "utterance", language: "en", languageProbability: 1 };
      },
      dispose: async () => undefined,
    } as WhisperRuntime;
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 2_600; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).flatMap((event) => event.type === "segment.upsert" ? [event.segment] : []);
    expect(segments).toHaveLength(2);
    expect(transcriptions).toHaveLength(2);
    expect(segments.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
      { startMs: 0, endMs: 25_124 },
      { startMs: 24_924, endMs: 50_148 },
    ]);
    for (let index = 0; index < segments.length; index += 1) {
      expect(transcriptions[index]!.length).toBe((segments[index]!.endMs - segments[index]!.startMs) * 16);
    }
    expect(segments[0]!.endMs - segments[1]!.startMs).toBe(2 * VAD_DEFAULTS.speechPadMs);
    expect(vadReset).toHaveBeenCalledTimes(3); // open plus two finalized max-duration boundaries
    const firstTranscribe = order.indexOf("transcribe");
    expect(order[firstTranscribe - 1]).toBe("reset");
    expect(order.slice(firstTranscribe + 1)).toContain("vad");

    const creditedFrames = events.reduce((total, event) => event.type === "credit" ? total + event.frames : total, 0);
    expect(creditedFrames).toBe(2_497);
  });

  it("clamps a pending max-duration flush to audio actually available when stopped before forward padding", async () => {
    const { post, events } = collect();
    const transcribe = vi.fn(async (samples: Float32Array) => ({ text: String(samples.length), language: "en", languageProbability: 1 }));
    const { runtime, vadReset } = fakeRuntime({
      vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
      transcribe,
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 1_252; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    expect(transcribe).not.toHaveBeenCalled();
    await controller.handle({ type: "stop", sessionId: SESSION });

    const segments = engineEvents(events).flatMap((event) => event.type === "segment.upsert" ? [event.segment] : []);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 25_040 });
    expect(transcribe.mock.calls[0]![0].length).toBe(25_040 * 16);
    expect(vadReset).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "immediate silence", tailFrames: 0 },
    { label: "a sub-minimum speech tail", tailFrames: 8 },
  ])("does not transcribe an overlap-only continuation after max duration followed by $label", async ({ tailFrames }) => {
    const { post, events } = collect();
    let probability = 0.9;
    const transcribe = vi.fn(async () => ({ text: "utterance", language: "en", languageProbability: 1 }));
    const { runtime } = fakeRuntime({
      vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(probability),
      transcribe,
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 1_252 + tailFrames; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    probability = 0.05;
    for (let index = 1_252 + tailFrames; index < 1_252 + tailFrames + 40; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(engineEvents(events).filter((event) => event.type === "segment.upsert")).toHaveLength(1);
  });

  it("keeps idle silence bounded so speech resumes after more than the buffer cap", async () => {
    const { post, events } = collect();
    let probability = 0.05;
    const transcribe = vi.fn(async () => ({ text: "after silence", language: "en", languageProbability: 1 }));
    const { runtime } = fakeRuntime({
      vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(probability),
      transcribe,
    });
    const controller = createWorkerController(runtime, post);
    // A multiple of eight 320-sample frames lands exactly on a 512-sample VAD
    // boundary, making the expected 100ms pre-roll unambiguous.
    const silenceFrames = 3_104;

    await controller.handle({ type: "open", request });
    for (let index = 0; index < silenceFrames; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const creditsBeforeSpeech = events.reduce((total, event) => event.type === "credit" ? total + event.frames : total, 0);
    const maximumIdleFrames = Math.ceil((VAD_DEFAULTS.speechPadMs + VAD_DEFAULTS.windowMs) / 20);
    expect(creditsBeforeSpeech).toBeGreaterThanOrEqual(silenceFrames - maximumIdleFrames);
    expect(engineEvents(events).filter((event) => event.type === "warning" && event.code === "AUDIO_GAP")).toHaveLength(0);

    probability = 0.9;
    for (let index = silenceFrames; index < silenceFrames + 20; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    probability = 0.05;
    for (let index = silenceFrames + 20; index < silenceFrames + 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(transcribe).toHaveBeenCalledOnce();
    const segment = engineEvents(events).find((event) => event.type === "segment.upsert");
    expect(segment).toMatchObject({ type: "segment.upsert", segment: { text: "after silence" } });
    if (segment?.type !== "segment.upsert") throw new Error("expected a segment");
    expect(segment.segment.startMs).toBe((silenceFrames * 20) - VAD_DEFAULTS.speechPadMs);
    expect(transcribe.mock.calls[0]![0].length).toBe((segment.segment.endMs - segment.segment.startMs) * 16);

    await controller.handle({ type: "stop", sessionId: SESSION });
    const totalCredits = events.reduce((total, event) => event.type === "credit" ? total + event.frames : total, 0);
    expect(totalCredits).toBe(silenceFrames + 60);
  });

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
      vadReset: () => undefined,
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
    expect(events.reduce((total, event) => event.type === "credit" ? total + event.frames : total, 0)).toBe(30);
  });

  it.each([
    { label: "silence-only", probability: 0.05 },
    { label: "sub-minimum speech", probability: 0.9 },
  ])("releases buffered frames exactly once when stopping $label audio", async ({ probability }) => {
    const { post, events } = collect();
    const { runtime, vadReset } = fakeRuntime({
      vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(probability),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "open", request });
    for (let index = 0; index < 10; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    await controller.handle({ type: "stop", sessionId: SESSION });

    const credits = events.filter((event) => event.type === "credit");
    expect(credits.reduce((total, event) => total + event.frames, 0)).toBe(10);
    expect(credits.every((event) => event.sessionId === SESSION && event.frames > 0)).toBe(true);
    expect(vadReset).toHaveBeenCalledTimes(2);
    expect(engineEvents(events).at(-1)).toMatchObject({ type: "state", state: "stopped" });
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

  it("brackets successful synchronous inference with lifecycle messages", async () => {
    const { post, events } = collect();
    let transcribedSampleCount = 0;
    const { runtime } = fakeRuntime({
      transcribe: async (samples) => {
        transcribedSampleCount = samples.length;
        return { text: "hello world", language: "en", languageProbability: 1 };
      },
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(events.filter((event) => event.type.startsWith("inference."))).toEqual([
      { type: "inference.started", sessionId: SESSION, token: 1, audioDurationMs: transcribedSampleCount / 16 },
      { type: "inference.finished", sessionId: SESSION, token: 1 },
    ]);
  });

  it("reports inference completion before a synchronous runtime failure", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: () => { throw new Error("bridge exploded"); },
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const lifecycle = events.filter((event) => event.type.startsWith("inference."));
    expect(lifecycle).toEqual([
      { type: "inference.started", sessionId: SESSION, token: 1, audioDurationMs: expect.any(Number) },
      { type: "inference.finished", sessionId: SESSION, token: 1 },
    ]);
    expect(events.indexOf(lifecycle[1]!)).toBeLessThan(events.findIndex(
      (event) => event.type === "event" && event.event.type === "error",
    ));
  });
});
