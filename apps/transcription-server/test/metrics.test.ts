import { describe, expect, it } from "vitest";

import { JsonLinesMetricsSink, type DecodeMetricsRecord } from "../src/metrics.js";

describe("JsonLinesMetricsSink", () => {
  it("serializes numeric timings and enums without audio or transcript content", () => {
    const lines: string[] = [];
    const sink = new JsonLinesMetricsSink((line) => lines.push(line));

    const record: DecodeMetricsRecord = {
      sessionId: "opaque-session-42",
      model: "whisper-small",
      resultKind: "provisional",
      queueDelayMs: 12.5,
      decodeDurationMs: 180,
      audioDurationMs: 750,
      realTimeFactor: 0.24,
    };

    sink.recordDecode(record);

    expect(lines).toHaveLength(1);
    const serialized = lines[0]!;
    expect(serialized.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed).toEqual({
      sessionId: "opaque-session-42",
      model: "whisper-small",
      resultKind: "provisional",
      queueDelayMs: 12.5,
      decodeDurationMs: 180,
      audioDurationMs: 750,
      realTimeFactor: 0.24,
    });

    expect(serialized).not.toMatch(/Int16Array|sample|pcm|transcript|hello|samples/i);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "audioDurationMs",
        "decodeDurationMs",
        "model",
        "queueDelayMs",
        "realTimeFactor",
        "resultKind",
        "sessionId",
      ].sort(),
    );
  });
});
