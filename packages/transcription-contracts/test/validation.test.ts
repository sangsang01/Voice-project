import { describe, expect, it } from "vitest";
import { validateSessionRequest } from "../src/validation";

const valid = {
  sessionId: "session-1",
  candidateLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

describe("validateSessionRequest", () => {
  it("accepts one through four unique languages", () => {
    expect(validateSessionRequest(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, candidateLanguages: [] },
    { ...valid, candidateLanguages: ["en-US", "en-US"] },
    { ...valid, candidateLanguages: ["en-US", "vi-VN", "es-ES", "zh-CN", "fr-FR"] },
    { ...valid, audio: { ...valid.audio, sampleRateHz: 44100 } },
  ])("rejects invalid requests", (request) => {
    expect(() => validateSessionRequest(request)).toThrow();
  });
});
