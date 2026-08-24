import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DecodeResult, StreamingRuntimeSession, VadUpdate } from "../src/runtime.js";
import { SessionScheduler } from "../src/sessionScheduler.js";

const request: SessionRequest = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
};

const DECODE_INTERVAL_MS = 400;
const FIRST_DECODE_DELAY_MS = 200;
const PROVISIONAL_CAP_MS = 3_000;
const OVERLAP_MS = 500;

class FakeRuntimeSession implements StreamingRuntimeSession {
  public decodes: Array<{ kind: "provisional" | "final"; samples: number }> = [];
  public nextVad: VadUpdate = { speechStarted: false, speechEnded: false, maxDuration: false };
  public decodeImpl?: () => Promise<DecodeResult>;

  public push(): VadUpdate {
    return this.nextVad;
  }

  public async decode(kind: "provisional" | "final", audio: Int16Array): Promise<DecodeResult> {
    this.decodes.push({ kind, samples: audio.length });
    if (this.decodeImpl) return this.decodeImpl();
    return {
      text: kind === "final" ? "hello how are you" : "hello",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    };
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function frame(sequence: number): PcmFrame {
  return {
    sequence,
    startMs: sequence * 20,
    samples: Int16Array.from({ length: 320 }, () => 1000),
  };
}

function createHarness() {
  const runtime = new FakeRuntimeSession();
  const events: EngineEvent[] = [];
  const scheduler = new SessionScheduler({
    request,
    runtime,
    emit: (event) => events.push(event),
  });
  return { runtime, events, scheduler };
}

function beginSpeech(runtime: FakeRuntimeSession, scheduler: SessionScheduler, sequence: number): number {
  runtime.nextVad = { speechStarted: true, speechEnded: false, maxDuration: false };
  scheduler.push(frame(sequence));
  runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: false };
  return sequence + 1;
}

function pushSpeaking(runtime: FakeRuntimeSession, scheduler: SessionScheduler, from: number, count: number): number {
  runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: false };
  for (let index = 0; index < count; index += 1) {
    scheduler.push(frame(from + index));
  }
  return from + count;
}

function upserts(events: EngineEvent[]) {
  return events.filter((event): event is Extract<EngineEvent, { type: "segment.upsert" }> => event.type === "segment.upsert");
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("SessionScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not decode before the first refresh interval", async () => {
    const { runtime, scheduler } = createHarness();
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);

    await vi.advanceTimersByTimeAsync(FIRST_DECODE_DELAY_MS - 1);
    await settle();

    expect(runtime.decodes).toHaveLength(0);
  });

  it("emits revision 0 on the first tick with a mapped language and id session:0", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    expect(upserts(events)).toEqual([
      expect.objectContaining({
        type: "segment.upsert",
        sessionId: "session-1",
        segment: expect.objectContaining({
          id: "session-1:0",
          ordinal: 0,
          revision: 0,
          isFinal: false,
          language: { tag: "en-US", confidence: 1 },
        }),
      }),
    ]);
  });

  it("emits revision 1 with the same id on the second tick", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    const segments = upserts(events);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.segment).toMatchObject({ id: "session-1:0", revision: 0, isFinal: false });
    expect(segments[1]?.segment).toMatchObject({ id: "session-1:0", revision: 1, isFinal: false });
  });

  it("coalesces ticks while decode is pending into one newest-window decode", async () => {
    const { runtime, scheduler } = createHarness();
    let resolveDecode: ((result: DecodeResult) => void) | undefined;
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        if (!resolveDecode) {
          resolveDecode = resolve;
          return;
        }
        resolve({
          text: "hello",
          language: "en",
          languageProbability: 1,
          startMs: 0,
          endMs: 800,
        });
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);

    sequence = pushSpeaking(runtime, scheduler, sequence, 20);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    sequence = pushSpeaking(runtime, scheduler, sequence, 20);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);

    const firstSamples = runtime.decodes[0]!.samples;
    resolveDecode!({
      text: "hello",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();

    expect(runtime.decodes).toHaveLength(2);
    expect(runtime.decodes[1]).toMatchObject({ kind: "provisional" });
    expect(runtime.decodes[1]!.samples).toBeGreaterThan(firstSamples);
  });

  it("emits an in-flight provisional after speech ends so captions are not delayed until the final", async () => {
    const { runtime, events, scheduler } = createHarness();
    const resolvers: Array<(result: DecodeResult) => void> = [];
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);
    expect(runtime.decodes[0]?.kind).toBe("provisional");

    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: false };
    await settle();

    expect(runtime.decodes.filter((decode) => decode.kind === "final")).toHaveLength(0);

    resolvers[0]!({
      text: "hello so far",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();

    expect(upserts(events).some((event) => event.segment.text === "hello so far" && !event.segment.isFinal)).toBe(true);
    expect(runtime.decodes.filter((decode) => decode.kind === "final")).toHaveLength(1);

    resolvers[1]!({
      text: "hello so far today",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();
    expect(upserts(events).some((event) => event.segment.text === "hello so far today" && event.segment.isFinal)).toBe(true);
  });

  it("finalizes once on speech end and ignores later provisional ticks for that id", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: false };
    await settle();

    const finals = runtime.decodes.filter((decode) => decode.kind === "final");
    expect(finals).toHaveLength(0);
    expect(upserts(events).at(-1)?.segment).toMatchObject({
      id: "session-1:0",
      isFinal: true,
      language: { tag: "en-US", confidence: 1 },
    });

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    expect(runtime.decodes.filter((decode) => decode.kind === "final")).toHaveLength(0);
    expect(upserts(events).filter((event) => event.segment.id === "session-1:0" && !event.segment.isFinal).length).toBeGreaterThan(0);
    expect(upserts(events).filter((event) => event.segment.id === "session-1:0" && event.segment.isFinal)).toHaveLength(1);
    expect(upserts(events).some((event) => event.segment.id === "session-1:0" && !event.segment.isFinal && event.segment.revision > 0 && events.indexOf(event) > events.findIndex((item) => item.type === "segment.upsert" && item.segment.isFinal))).toBe(false);
  });

  it("stop while speaking emits draining, one final, then stopped", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);

    await scheduler.stop();
    await settle();

    expect(events.map((event) => event.type === "state" ? event.state : event.type)).toEqual([
      "listening",
      "draining",
      "segment.upsert",
      "stopped",
    ]);
    expect(upserts(events)[0]?.segment.isFinal).toBe(true);
    expect(runtime.decodes).toEqual([expect.objectContaining({ kind: "final" })]);
  });

  it("cancel while speaking emits stopped and no segment", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);

    await scheduler.cancel();
    await settle();

    expect(events).toEqual([
      expect.objectContaining({ type: "state", state: "listening" }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(upserts(events)).toHaveLength(0);
    expect(runtime.decodes).toHaveLength(0);
  });

  it("maxDuration finalizes ordinal 0 and the next speech uses a new id", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: true };
    scheduler.push(frame(sequence));
    sequence += 1;
    await settle();

    expect(upserts(events).at(-1)?.segment).toMatchObject({ id: "session-1:0", ordinal: 0, isFinal: true });

    sequence = beginSpeech(runtime, scheduler, sequence);
    pushSpeaking(runtime, scheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    expect(upserts(events).at(-1)?.segment).toMatchObject({
      id: "session-1:1",
      ordinal: 1,
      revision: 0,
      isFinal: false,
    });
  });

  it("emits DEGRADED_PERFORMANCE after three consecutive slower-than-realtime provisionals", async () => {
    const { runtime, events, scheduler } = createHarness();
    let nowMs = 0;
    const slowScheduler = new SessionScheduler({
      request,
      runtime,
      emit: (event) => events.push(event),
      now: () => nowMs,
    });
    runtime.decodeImpl = async () => {
      nowMs += 10_000;
      return {
        text: "hello",
        language: "en",
        languageProbability: 1,
        startMs: 0,
        endMs: 800,
      };
    };

    slowScheduler.start();
    let sequence = beginSpeech(runtime, slowScheduler, 0);
    sequence = pushSpeaking(runtime, slowScheduler, sequence, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    sequence = pushSpeaking(runtime, slowScheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    sequence = pushSpeaking(runtime, slowScheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings).toEqual([
      expect.objectContaining({ type: "warning", code: "DEGRADED_PERFORMANCE" }),
    ]);
    expect(runtime.decodes.filter((decode) => decode.kind === "provisional")).toHaveLength(3);
  });

  it("stop during an in-flight speech-end final does not emit a second ordinal", async () => {
    const { runtime, events, scheduler } = createHarness();
    let resolveDecode: ((result: DecodeResult) => void) | undefined;
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        if (!resolveDecode) {
          resolveDecode = resolve;
          return;
        }
        resolve({
          text: "second utterance",
          language: "en",
          languageProbability: 1,
          startMs: 0,
          endMs: 800,
        });
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);

    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    await settle();
    expect(runtime.decodes).toEqual([expect.objectContaining({ kind: "final" })]);

    const stopping = scheduler.stop();
    resolveDecode!({
      text: "hello how are you",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await stopping;
    await settle();

    expect(runtime.decodes.filter((decode) => decode.kind === "final")).toHaveLength(1);
    expect(upserts(events).filter((event) => event.segment.isFinal)).toEqual([
      expect.objectContaining({
        segment: expect.objectContaining({ id: "session-1:0", ordinal: 0, isFinal: true }),
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "state", state: "stopped" });
  });

  it("stop after silence-only frames does not decode", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: false };
    for (let index = 0; index < 10; index += 1) {
      scheduler.push(frame(index));
    }

    await scheduler.stop();
    await settle();

    expect(events.map((event) => (event.type === "state" ? event.state : event.type))).toEqual([
      "listening",
      "draining",
      "stopped",
    ]);
    expect(runtime.decodes).toHaveLength(0);
    expect(upserts(events)).toHaveLength(0);
  });

  it("keeps a pending speech-end final while the next utterance emits provisionals", async () => {
    const { runtime, events, scheduler } = createHarness();
    let resolveFirst: ((result: DecodeResult) => void) | undefined;
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        if (!resolveFirst) {
          resolveFirst = resolve;
          return;
        }
        resolve({
          text: "next",
          language: "en",
          languageProbability: 1,
          startMs: 0,
          endMs: 800,
        });
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);
    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    sequence += 1;
    sequence = beginSpeech(runtime, scheduler, sequence);
    pushSpeaking(runtime, scheduler, sequence, 40);

    await settle();
    expect(runtime.decodes).toEqual([expect.objectContaining({ kind: "final" })]);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);

    resolveFirst!({
      text: "hello how are you",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();
    await settle();

    const segments = upserts(events);
    expect(segments.filter((event) => event.segment.isFinal)).toEqual([
      expect.objectContaining({
        segment: expect.objectContaining({ id: "session-1:0", ordinal: 0, isFinal: true }),
      }),
    ]);
    expect(segments.some((event) => event.segment.id === "session-1:1" && event.segment.ordinal === 1 && !event.segment.isFinal)).toBe(true);
    expect(runtime.decodes.some((decode) => decode.kind === "provisional")).toBe(true);
  });

  it("keeps a pending maxDuration final while the next utterance emits provisionals", async () => {
    const { runtime, events, scheduler } = createHarness();
    let resolveFirst: ((result: DecodeResult) => void) | undefined;
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        if (!resolveFirst) {
          resolveFirst = resolve;
          return;
        }
        resolve({
          text: "next",
          language: "en",
          languageProbability: 1,
          startMs: 0,
          endMs: 800,
        });
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);
    runtime.nextVad = { speechStarted: false, speechEnded: false, maxDuration: true };
    scheduler.push(frame(sequence));
    sequence += 1;
    sequence = beginSpeech(runtime, scheduler, sequence);
    pushSpeaking(runtime, scheduler, sequence, 40);

    await settle();
    expect(runtime.decodes).toEqual([expect.objectContaining({ kind: "final" })]);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);

    resolveFirst!({
      text: "hello how are you",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();

    const segments = upserts(events);
    expect(segments.filter((event) => event.segment.isFinal)).toEqual([
      expect.objectContaining({
        segment: expect.objectContaining({ id: "session-1:0", ordinal: 0, isFinal: true }),
      }),
    ]);
    expect(segments.some((event) => event.segment.id === "session-1:1" && !event.segment.isFinal)).toBe(true);
  });

  it("decode rejection emits a non-fatal error and does not stall stop", async () => {
    const { runtime, events, scheduler } = createHarness();
    let attempts = 0;
    runtime.decodeImpl = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return {
        text: "hello how are you",
        language: "en",
        languageProbability: 1,
        startMs: 0,
        endMs: 800,
      };
    };

    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    expect(events.some((event) => event.type === "error" && event.code === "INTERNAL" && event.fatal === false)).toBe(true);

    await scheduler.stop();
    await settle();

    expect(attempts).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: "state", state: "stopped" });
  });

  it("caps provisional windows at 3s plus overlap", async () => {
    const { runtime, scheduler } = createHarness();
    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 250);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    const provisionals = runtime.decodes.filter((decode) => decode.kind === "provisional");
    expect(provisionals).toHaveLength(1);
    const maxSamples = ((PROVISIONAL_CAP_MS + OVERLAP_MS) / 20) * 320;
    expect(provisionals[0]!.samples).toBeLessThanOrEqual(maxSamples);
    expect(provisionals[0]!.samples).toBeGreaterThan((PROVISIONAL_CAP_MS / 20) * 320);
  });

  it("decodes a live provisional before a queued previous final when the handle is free", async () => {
    const { runtime, events, scheduler } = createHarness();
    const resolvers: Array<(result: DecodeResult) => void> = [];
    runtime.decodeImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });

    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toEqual([expect.objectContaining({ kind: "provisional" })]);

    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    sequence += 1;
    sequence = beginSpeech(runtime, scheduler, sequence);
    sequence = pushSpeaking(runtime, scheduler, sequence, 40);
    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();

    resolvers[0]!({
      text: "first sentence so far",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();
    await settle();

    expect(runtime.decodes[1]).toMatchObject({ kind: "provisional" });

    resolvers[1]!({
      text: "second sentence",
      language: "en",
      languageProbability: 1,
      startMs: 800,
      endMs: 1600,
    });
    await settle();
    await settle();

    expect(
      upserts(events).some((event) => event.segment.id === "session-1:1" && event.segment.isFinal === false),
    ).toBe(true);
    expect(runtime.decodes.some((decode) => decode.kind === "final")).toBe(true);

    resolvers[2]!({
      text: "first sentence",
      language: "en",
      languageProbability: 1,
      startMs: 0,
      endMs: 800,
    });
    await settle();
    await settle();

    expect(
      upserts(events).some((event) => event.segment.id === "session-1:0" && event.segment.isFinal === true),
    ).toBe(true);
  });

  it("final decode uses the full utterance rather than the 3s provisional cap", async () => {
    const { runtime, scheduler } = createHarness();
    scheduler.start();
    let sequence = beginSpeech(runtime, scheduler, 0);
    sequence = pushSpeaking(runtime, scheduler, sequence, 999);
    runtime.nextVad = { speechStarted: false, speechEnded: true, maxDuration: false };
    scheduler.push(frame(sequence));
    await settle();

    const finals = runtime.decodes.filter((decode) => decode.kind === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.samples).toBeGreaterThan(8_000 * 16);
    expect(finals[0]!.samples).toBeGreaterThanOrEqual(20_000 * 16);
  });

  it("assigns a monotonic sequence on every engine event", async () => {
    const { runtime, events, scheduler } = createHarness();
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);
    await scheduler.stop();
    await settle();

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  });

  it("stop still completes when a provisional decode never returns", async () => {
    const { runtime, events, scheduler } = createHarness();
    runtime.decodeImpl = () => new Promise(() => undefined);
    scheduler.start();
    const next = beginSpeech(runtime, scheduler, 0);
    pushSpeaking(runtime, scheduler, next, 40);

    await vi.advanceTimersByTimeAsync(DECODE_INTERVAL_MS);
    await settle();
    expect(runtime.decodes).toHaveLength(1);

    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;

    expect(events.at(-1)).toMatchObject({ type: "state", state: "stopped" });
  });
});
