import { describe, expect, it } from "vitest";

import { inferenceWatchdogBudgetMs } from "../src/inferenceWatchdog.js";

describe("inferenceWatchdogBudgetMs", () => {
  it("uses a two-minute floor for short utterances with fixed decoder overhead", () => {
    expect(inferenceWatchdogBudgetMs(1_000)).toBe(120_000);
  });

  it("allows twenty times the audio duration for measured real-WASM headroom", () => {
    expect(inferenceWatchdogBudgetMs(3_500)).toBe(120_000);
    expect(inferenceWatchdogBudgetMs(25_000)).toBe(500_000);
  });

  it("caps true hangs at ten minutes", () => {
    expect(inferenceWatchdogBudgetMs(60_000)).toBe(600_000);
    expect(inferenceWatchdogBudgetMs(Number.POSITIVE_INFINITY)).toBe(600_000);
  });
});
