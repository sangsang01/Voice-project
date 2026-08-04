import { describe, expect, it } from "vitest";
import { normalizeGoogleError, normalizeGoogleResult } from "../src/normalizeResult";
import type { GoogleStreamingRecognitionResult } from "../src/providerTypes";

const baseContext = {
  sessionId: "session-1",
  sequence: 7,
  ordinal: 4,
  revision: 2,
  startMs: 1200,
  selectedLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
} as const;

describe("normalizeGoogleResult", () => {
  it("returns null for an empty transcript", () => {
    const result: GoogleStreamingRecognitionResult = { alternatives: [{ transcript: "   " }] };
    expect(normalizeGoogleResult(result, baseContext)).toBeNull();
  });

  it("normalizes an interim result at index 4 with stable id google-4", () => {
    const result: GoogleStreamingRecognitionResult = {
      alternatives: [{ transcript: "Xin chào", confidence: 0.91 }],
      isFinal: true,
      languageCode: "vi-VN",
      resultEndTime: { seconds: 2, nanos: 400_000_000 },
    };

    expect(normalizeGoogleResult(result, baseContext)).toEqual({
      type: "segment.upsert",
      sessionId: "session-1",
      sequence: 7,
      segment: {
        id: "google-4",
        ordinal: 4,
        revision: 2,
        startMs: 1200,
        endMs: 2400,
        text: "Xin chào",
        language: { tag: "vi-VN", confidence: 0.91 },
        isFinal: true,
      },
    });
  });

  it("keeps the same id and bumps the revision when the caller revises the same result", () => {
    const provisional = normalizeGoogleResult(
      { alternatives: [{ transcript: "Xin", confidence: 0.4 }], isFinal: false, languageCode: "vi-VN" },
      { ...baseContext, revision: 1 },
    );
    const revised = normalizeGoogleResult(
      { alternatives: [{ transcript: "Xin chào", confidence: 0.91 }], isFinal: true, languageCode: "vi-VN" },
      { ...baseContext, revision: 2 },
    );

    expect(provisional?.type).toBe("segment.upsert");
    expect(revised?.type).toBe("segment.upsert");
    if (provisional?.type !== "segment.upsert" || revised?.type !== "segment.upsert") throw new Error("unreachable");
    expect(provisional.segment.id).toBe(revised.segment.id);
    expect(revised.segment.revision).toBeGreaterThan(provisional.segment.revision);
    expect(provisional.segment.isFinal).toBe(false);
    expect(revised.segment.isFinal).toBe(true);
  });

  it("marks the segment final only when Google reports isFinal", () => {
    const result: GoogleStreamingRecognitionResult = {
      alternatives: [{ transcript: "final text" }],
      isFinal: true,
      languageCode: "en-US",
    };
    const event = normalizeGoogleResult(result, baseContext);
    if (event?.type !== "segment.upsert") throw new Error("unreachable");
    expect(event.segment.isFinal).toBe(true);
  });

  it("labels a language outside the selected set as und", () => {
    const result: GoogleStreamingRecognitionResult = {
      alternatives: [{ transcript: "bonjour", confidence: 0.8 }],
      isFinal: true,
      languageCode: "fr-FR",
    };
    const event = normalizeGoogleResult(result, baseContext);
    if (event?.type !== "segment.upsert") throw new Error("unreachable");
    expect(event.segment.language.tag).toBe("und");
  });

  it("omits confidence when Google does not report one", () => {
    const result: GoogleStreamingRecognitionResult = {
      alternatives: [{ transcript: "no confidence here" }],
      isFinal: false,
      languageCode: "en-US",
    };
    const event = normalizeGoogleResult(result, baseContext);
    if (event?.type !== "segment.upsert") throw new Error("unreachable");
    expect(event.segment.language.confidence).toBeUndefined();
  });

  it("preserves source Unicode and punctuation, trimming only surrounding whitespace", () => {
    const result: GoogleStreamingRecognitionResult = {
      alternatives: [{ transcript: "  祝你有美好的一天。 Soy de Vietnam.  " }],
      isFinal: true,
      languageCode: "zh-CN",
    };
    const event = normalizeGoogleResult(result, baseContext);
    if (event?.type !== "segment.upsert") throw new Error("unreachable");
    expect(event.segment.text).toBe("祝你有美好的一天。 Soy de Vietnam.");
  });
});

describe("normalizeGoogleError", () => {
  const errorContext = { sessionId: "session-1", sequence: 9 };

  it.each([
    [3, "INVALID_AUDIO"],
    [4, "TIMEOUT"],
    [8, "RESOURCE_EXHAUSTED"],
    [14, "UNAVAILABLE"],
    [16, "UNAVAILABLE"],
    [2, "INTERNAL"],
  ] as const)("maps grpc code %d to %s", (code, expected) => {
    const event = normalizeGoogleError({ code, message: "internal grpc detail" }, errorContext);
    expect(event).toEqual({
      type: "error",
      sessionId: "session-1",
      sequence: 9,
      code: expected,
      fatal: true,
      message: "Cloud transcription provider error",
      providerCode: String(code),
    });
  });

  it("never leaks the raw provider error message", () => {
    const event = normalizeGoogleError({ code: 7, message: "service account key leaked here" }, errorContext);
    expect(JSON.stringify(event)).not.toContain("leaked");
  });
});
