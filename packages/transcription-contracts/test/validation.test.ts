import { describe, expect, it } from "vitest";
import { validatePcmFrame, validateSessionRequest } from "../src/validation";

const valid = {
  sessionId: "session-1",
  candidateLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
  mode: "transcribe",
  audio: {
    encoding: "pcm_s16le",
    sampleRateHz: 16000,
    channels: 1,
    frameDurationMs: 20,
  },
} as const;

describe("validateSessionRequest", () => {
  it("accepts one through four unique languages", () => {
    expect(validateSessionRequest(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, candidateLanguages: [] },
    { ...valid, candidateLanguages: ["en-US", "en-US"] },
    {
      ...valid,
      candidateLanguages: ["en-US", "vi-VN", "es-ES", "zh-CN", "fr-FR"],
    },
    { ...valid, audio: { ...valid.audio, sampleRateHz: 44100 } },
  ])("rejects invalid requests", (request) => {
    expect(() => validateSessionRequest(request)).toThrow();
  });

  it.each([
    { ...valid, sessionId: "" },
    { ...valid, sessionId: 1 },
  ])("rejects a malformed session ID", (request) => {
    expect(() => validateSessionRequest(request)).toThrow("sessionId must be a nonempty string");
  });

  it.each([
    { ...valid, candidateLanguages: "en-US" },
    { ...valid, candidateLanguages: ["en-US", 1] },
  ])("rejects malformed candidate languages", (request) => {
    expect(() => validateSessionRequest(request)).toThrow("candidateLanguages must be an array of strings");
  });

  it.each([
    { ...valid, audio: undefined },
    { ...valid, audio: { ...valid.audio, sampleRateHz: "16000" } },
  ])("rejects malformed audio", (request) => {
    expect(() => validateSessionRequest(request)).toThrow("audio must be an object with valid properties");
  });
});

describe("validatePcmFrame", () => {
  const validFrame = {
    sequence: 0,
    startMs: 0,
    samples: new Int16Array(320),
  };

  it("accepts a 320-sample PCM frame", () => {
    expect(validatePcmFrame(validFrame)).toBe(validFrame);
  });

  it.each([
    { ...validFrame, sequence: -1 },
    { ...validFrame, sequence: 0.5 },
    { ...validFrame, sequence: Number.POSITIVE_INFINITY },
    { ...validFrame, startMs: -1 },
    { ...validFrame, startMs: Number.NaN },
    { ...validFrame, samples: new Int16Array(319) },
  ])("rejects malformed frames", (frame) => {
    expect(() => validatePcmFrame(frame)).toThrow();
  });
});
