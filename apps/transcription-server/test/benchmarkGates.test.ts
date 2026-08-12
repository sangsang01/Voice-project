import { describe, expect, it } from "vitest";

import {
  compareAccuracy,
  computeRealTimeFactor,
  evaluateGates,
} from "../scripts/benchmark.mjs";

describe("benchmark gates", () => {
  it("fails when latency samples are missing (Infinity p95)", () => {
    const failures = evaluateGates({
      firstPartialP95Ms: Number.POSITIVE_INFINITY,
      refreshP95Ms: Number.POSITIVE_INFINITY,
      finalAfterSilenceP95Ms: Number.POSITIVE_INFINITY,
      realTimeFactor: Number.POSITIVE_INFINITY,
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(/firstPartialP95Ms/);
    expect(failures.join("\n")).toMatch(/realTimeFactor/);
  });

  it("passes a report that meets every hard gate", () => {
    const failures = evaluateGates({
      firstPartialP95Ms: 900,
      refreshP95Ms: 400,
      finalAfterSilenceP95Ms: 800,
      realTimeFactor: 0.3,
    });
    expect(failures).toEqual([]);
  });

  it("computes decoder RTF from decode durations over audio durations", () => {
    expect(
      computeRealTimeFactor([
        { decodeDurationMs: 100, audioDurationMs: 1000 },
        { decodeDurationMs: 200, audioDurationMs: 1000 },
      ]),
    ).toBe(0.15);
    expect(computeRealTimeFactor([])).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects aggregate WER regression above one absolute point", () => {
    const failures = compareAccuracy(
      { werByLanguage: { "en-US": 10, "vi-VN": 12 }, cerByLanguage: { "zh-CN": 8 } },
      { werByLanguage: { "en-US": 14, "vi-VN": 12 }, cerByLanguage: { "zh-CN": 8 } },
    );
    expect(failures.join("\n")).toMatch(/aggregate WER/);
  });
});
