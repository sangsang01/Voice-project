import { describe, expect, it } from "vitest";
import {
  parseJsonMessage,
  validateClientControl,
  validateServerMessage,
} from "../src/index.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

describe("streaming messages", () => {
  it("accepts the three client controls", () => {
    expect(validateClientControl({ type: "session.start", protocol: 1, request })).toMatchObject({ type: "session.start" });
    expect(validateClientControl({ type: "session.stop", sessionId: "session-1" })).toMatchObject({ type: "session.stop" });
    expect(validateClientControl({ type: "session.cancel", sessionId: "session-1" })).toMatchObject({ type: "session.cancel" });
  });

  it("accepts session.accepted with model and backend", () => {
    expect(validateServerMessage({
      type: "session.accepted",
      sessionId: "session-1",
      model: "small",
      backend: "cpu",
    })).toMatchObject({ backend: "cpu" });
  });

  it("rejects unknown controls and incomplete engine events", () => {
    expect(() => validateClientControl({ type: "session.pause" })).toThrow();
    expect(() => validateServerMessage({ type: "engine.event", event: { type: "state" } })).toThrow();
    expect(() => validateServerMessage({
      type: "session.accepted",
      sessionId: "session-1",
      model: "small",
      backend: "tpu",
    })).toThrow();
  });

  it("parses valid JSON and rejects invalid JSON", () => {
    expect(parseJsonMessage('{"type":"session.stop"}')).toEqual({ type: "session.stop" });
    expect(() => parseJsonMessage("{")).toThrow(/valid JSON/);
  });

  it("accepts audio.ack with a nonnegative sequence", () => {
    expect(validateServerMessage({
      type: "audio.ack",
      sessionId: "session-1",
      throughSequence: 3,
    })).toMatchObject({ type: "audio.ack", throughSequence: 3 });
  });

  it("rejects invalid audio.ack payloads", () => {
    expect(() => validateServerMessage({
      type: "audio.ack",
      sessionId: "session-1",
      throughSequence: -1,
    })).toThrow();
    expect(() => validateServerMessage({
      type: "audio.ack",
      sessionId: "",
      throughSequence: 0,
    })).toThrow();
    expect(() => validateServerMessage({
      type: "audio.ack",
      sessionId: "session-1",
      throughSequence: 1.5,
    })).toThrow();
  });

  it("rejects invalid session.start and empty session ids", () => {
    expect(() => validateClientControl({ type: "session.start", protocol: 2, request })).toThrow();
    expect(() => validateClientControl({ type: "session.stop", sessionId: "" })).toThrow();
    expect(() => validateClientControl({ type: "session.cancel", sessionId: "" })).toThrow();
  });

  it("accepts a complete engine.event", () => {
    expect(validateServerMessage({
      type: "engine.event",
      event: {
        type: "state",
        sessionId: "session-1",
        sequence: 0,
        state: "listening",
      },
    })).toMatchObject({ type: "engine.event" });
  });

  it("accepts the remaining engine.event payloads", () => {
    const base = { sessionId: "session-1", sequence: 1 };
    expect(validateServerMessage({
      type: "engine.event",
      event: {
        type: "segment.upsert",
        ...base,
        segment: {
          id: "seg-1",
          ordinal: 0,
          revision: 0,
          startMs: 0,
          endMs: 400,
          text: "hello",
          language: { tag: "en-US" },
          isFinal: true,
        },
      },
    })).toMatchObject({ type: "engine.event" });
    expect(validateServerMessage({
      type: "engine.event",
      event: { type: "segment.remove", ...base, segmentId: "seg-1" },
    })).toMatchObject({ type: "engine.event" });
    expect(validateServerMessage({
      type: "engine.event",
      event: { type: "warning", ...base, code: "AUDIO_GAP", message: "gap" },
    })).toMatchObject({ type: "engine.event" });
    expect(validateServerMessage({
      type: "engine.event",
      event: { type: "error", ...base, code: "TIMEOUT", fatal: true, message: "timed out" },
    })).toMatchObject({ type: "engine.event" });
  });
});
