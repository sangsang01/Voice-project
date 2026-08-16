import { describe, expect, it } from "vitest";

import { JsonLinesMetricsSink, recordDecode, type MetricsSink } from "../src/metrics.js";

describe("decode metrics", () => {
  it("serializes one JSON line with the opaque id and numbers, not transcript text or PCM", () => {
    const chunks: string[] = [];
    const sink: MetricsSink = new JsonLinesMetricsSink({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    const text = "hello this transcript must never appear in metrics";
    const samples = Int16Array.from({ length: 320 }, () => 42);

    sink.recordDecode({
      sessionId: "opaque-session",
      kind: "provisional",
      queueDelayMs: 4,
      decodeMs: 16,
      audioMs: 800,
      realtimeFactor: 0.02,
      model: "tiny",
    });
    recordDecode(
      {
        sessionId: "opaque-session",
        kind: "final",
        queueDelayMs: 1,
        decodeMs: 20,
        audioMs: 800,
        realtimeFactor: 0.025,
        model: "tiny",
      },
      {
        write(chunk) {
          chunks.push(chunk);
        },
      },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(chunks[1]?.endsWith("\n")).toBe(true);

    const first = JSON.parse(chunks[0]!.trim()) as Record<string, unknown>;
    expect(first).toEqual({
      sessionId: "opaque-session",
      kind: "provisional",
      queueDelayMs: 4,
      decodeMs: 16,
      audioMs: 800,
      realtimeFactor: 0.02,
      model: "tiny",
    });
    expect(chunks.join("")).toContain("opaque-session");
    expect(chunks.join("")).toContain("16");
    expect(chunks.join("")).not.toContain(text);
    expect(chunks.join("")).not.toContain(samples.toString());
    expect(first).not.toHaveProperty("text");
    expect(first).not.toHaveProperty("samples");
    expect(first).not.toHaveProperty("pcm");
  });
});
