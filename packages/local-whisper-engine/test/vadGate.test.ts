import { describe, expect, it } from "vitest";

import { createVadGate, VAD_DEFAULTS, type VadDecision } from "../src/worker/vadGate.js";

const WINDOW = VAD_DEFAULTS.windowMs; // 32ms per Silero window

/** Feeds `count` windows at `probability`, returning every decision produced. */
function feed(gate: ReturnType<typeof createVadGate>, probability: number, count: number, startWindow = 0) {
  const decisions: VadDecision[] = [];
  for (let index = 0; index < count; index += 1) {
    decisions.push(gate.push(probability, (startWindow + index) * WINDOW));
  }
  return decisions;
}

const windowsFor = (ms: number) => Math.ceil(ms / WINDOW);

describe("createVadGate", () => {
  it("stays idle through silence", () => {
    const gate = createVadGate();
    const decisions = feed(gate, 0.1, 50);
    expect(decisions.every((decision) => decision.type === "idle")).toBe(true);
  });

  it("ignores a blip shorter than minSpeechMs", () => {
    const gate = createVadGate();
    // 250ms minimum; 4 windows is 128ms, well under it.
    const speech = feed(gate, 0.9, 4);
    expect(speech.every((decision) => decision.type === "idle")).toBe(true);

    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 2, 4);
    expect(silence.some((decision) => decision.type === "flush")).toBe(false);
  });

  it("enters speaking once minSpeechMs of speech accumulates", () => {
    const gate = createVadGate();
    const decisions = feed(gate, 0.9, windowsFor(VAD_DEFAULTS.minSpeechMs) + 1);
    expect(decisions.at(-1)).toEqual({ type: "speaking" });
  });

  it("flushes after minSilenceMs of trailing silence", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);

    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, speechWindows);
    const flush = silence.find((decision) => decision.type === "flush");

    expect(flush).toBeDefined();
    expect(flush).toMatchObject({ reason: "silence" });
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeGreaterThanOrEqual(0);
    expect(flush.endMs).toBeGreaterThan(flush.startMs);
  });

  it("pads the utterance so word edges are not clipped", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    // Speech starts at window 10, so the raw onset is 10 * 32 = 320ms.
    feed(gate, 0.1, 10);
    feed(gate, 0.9, speechWindows, 10);
    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, 10 + speechWindows);

    const flush = silence.find((decision) => decision.type === "flush");
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeLessThanOrEqual(320);
    expect(flush.startMs).toBeGreaterThanOrEqual(320 - VAD_DEFAULTS.speechPadMs - WINDOW);
  });

  it("never emits a negative start when speech begins immediately", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);
    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, speechWindows);

    const flush = silence.find((decision) => decision.type === "flush");
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeGreaterThanOrEqual(0);
  });

  it("force-flushes an unbroken monologue at maxSpeechMs and keeps listening", () => {
    const gate = createVadGate();
    const total = windowsFor(VAD_DEFAULTS.maxSpeechMs) + windowsFor(VAD_DEFAULTS.minSpeechMs) + 1;
    const decisions = feed(gate, 0.9, total);

    const flush = decisions.find((decision) => decision.type === "flush");
    expect(flush).toMatchObject({ reason: "max-duration" });
    // Still mid-speech, so it must resume speaking rather than dropping to idle.
    expect(decisions.at(-1)).toEqual({ type: "speaking" });
  });

  it("does not flush an overlap-only continuation when silence starts immediately after a max split", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.maxSpeechMs);
    const speech = feed(gate, 0.9, speechWindows);
    expect(speech.filter((decision) => decision.type === "flush")).toHaveLength(1);

    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, speechWindows);

    expect(silence.every((decision) => decision.type === "idle")).toBe(true);
  });

  it("drops a post-max speech tail shorter than minSpeechMs", () => {
    const gate = createVadGate();
    const firstSpeechWindows = windowsFor(VAD_DEFAULTS.maxSpeechMs);
    feed(gate, 0.9, firstSpeechWindows);
    const shortTailWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) - 2;
    const tail = feed(gate, 0.9, shortTailWindows, firstSpeechWindows);
    expect(tail.every((decision) => decision.type === "idle")).toBe(true);

    const silence = feed(
      gate,
      0.1,
      windowsFor(VAD_DEFAULTS.minSilenceMs) + 1,
      firstSpeechWindows + shortTailWindows,
    );

    expect(silence.every((decision) => decision.type === "idle")).toBe(true);
  });

  it("separates two utterances split by a pause", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    const silenceWindows = windowsFor(VAD_DEFAULTS.minSilenceMs) + 1;

    let cursor = 0;
    const all: VadDecision[] = [];
    for (let round = 0; round < 2; round += 1) {
      all.push(...feed(gate, 0.9, speechWindows, cursor));
      cursor += speechWindows;
      all.push(...feed(gate, 0.1, silenceWindows, cursor));
      cursor += silenceWindows;
    }

    const flushes = all.filter((decision) => decision.type === "flush");
    expect(flushes).toHaveLength(2);
    if (flushes[0]?.type !== "flush" || flushes[1]?.type !== "flush") throw new Error("expected two flushes");
    expect(flushes[1].startMs).toBeGreaterThan(flushes[0].endMs);
  });

  it("flushes in-flight speech when the session stops", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);

    const decision = gate.flushPending(speechWindows * WINDOW);
    expect(decision).toMatchObject({ type: "flush", reason: "silence" });
  });

  it("has nothing to flush when stopped while idle", () => {
    const gate = createVadGate();
    feed(gate, 0.1, 10);
    expect(gate.flushPending(10 * WINDOW)).toEqual({ type: "idle" });
  });

  it("forgets all state on reset", () => {
    const gate = createVadGate();
    feed(gate, 0.9, windowsFor(VAD_DEFAULTS.minSpeechMs) + 2);
    gate.reset();
    expect(gate.flushPending(5000)).toEqual({ type: "idle" });
  });

  it("ends a stop-triggered flush at the last voiced window, not at nowMs", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);
    const lastVoiceEndMs = speechWindows * WINDOW;

    // Trailing silence stays under minSilenceMs, so push() never flushes on its own.
    const silenceWindows = windowsFor(VAD_DEFAULTS.minSilenceMs) - 2;
    const silence = feed(gate, 0.1, silenceWindows, speechWindows);
    expect(silence.every((decision) => decision.type !== "flush")).toBe(true);

    // Stop is called well after the last voiced window.
    const nowMs = lastVoiceEndMs + silenceWindows * WINDOW + 10_000;
    const decision = gate.flushPending(nowMs);

    expect(decision).toMatchObject({ type: "flush", reason: "silence" });
    if (decision.type !== "flush") throw new Error("expected a flush");
    // The flush must end at the last voiced window plus the pad -- NOT at
    // nowMs -- otherwise trailing silence leaks into the transcribed audio.
    expect(decision.endMs).toBe(lastVoiceEndMs + VAD_DEFAULTS.speechPadMs);
  });

  it("chains a second max-duration flush when the monologue keeps going", () => {
    const gate = createVadGate();
    const total = windowsFor(2 * VAD_DEFAULTS.maxSpeechMs) + windowsFor(VAD_DEFAULTS.minSpeechMs) + 1;
    const decisions = feed(gate, 0.9, total);

    const flushes = decisions.filter((decision) => decision.type === "flush");
    expect(flushes).toHaveLength(2);
    const [first, second] = flushes;
    if (first?.type !== "flush" || second?.type !== "flush") throw new Error("expected two flushes");
    expect(first.reason).toBe("max-duration");
    expect(second.reason).toBe("max-duration");
    expect(second.startMs).toBeGreaterThan(first.startMs);
    expect(second.endMs).toBeGreaterThan(first.endMs);

    // Still mid-speech after the second cut, so the gate keeps listening
    // instead of stalling after the first chained utterance.
    expect(decisions.at(-1)).toEqual({ type: "speaking" });
  });
});
