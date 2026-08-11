import { describe, expect, it } from "vitest";
import { parseJsonMessage, validateClientControl, validateServerMessage } from "../src/index.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

const segment = {
  id: "segment-1",
  ordinal: 0,
  revision: 1,
  startMs: 0,
  endMs: 20,
  text: "hello",
  language: { tag: "en-US", confidence: 0.9, provider: "test" },
  isFinal: false,
  providerMetadata: { resultId: "provider-1" },
} as const;

describe("streaming messages", () => {
  it("accepts the three client controls", () => {
    expect(validateClientControl({ type: "session.start", protocol: 1, request })).toMatchObject({
      type: "session.start",
    });
    expect(validateClientControl({ type: "session.stop", sessionId: "session-1" })).toMatchObject({
      type: "session.stop",
    });
    expect(validateClientControl({ type: "session.cancel", sessionId: "session-1" })).toMatchObject({
      type: "session.cancel",
    });
  });

  it("rejects unknown controls and invalid engine events", () => {
    expect(() => validateClientControl({ type: "session.pause" })).toThrow();
    expect(() => validateServerMessage({ type: "engine.event", event: { type: "state" } })).toThrow();
  });

  it("accepts server messages", () => {
    expect(
      validateServerMessage({ type: "session.accepted", sessionId: "session-1", model: "test-model" }),
    ).toMatchObject({ type: "session.accepted" });
    expect(
      validateServerMessage({ type: "audio.ack", sessionId: "session-1", throughSequence: 7 }),
    ).toMatchObject({ type: "audio.ack" });
    expect(
      validateServerMessage({
        type: "engine.event",
        event: { type: "state", sessionId: "session-1", sequence: 1, state: "listening" },
      }),
    ).toMatchObject({ type: "engine.event" });
  });

  it("accepts all engine event variants", () => {
    const events = [
      { type: "state", sessionId: "session-1", sequence: 1, state: "listening" },
      { type: "segment.upsert", sessionId: "session-1", sequence: 2, segment },
      { type: "segment.remove", sessionId: "session-1", sequence: 3, segmentId: "segment-1" },
      { type: "warning", sessionId: "session-1", sequence: 4.5, code: "LANGUAGE_UNCERTAIN", message: "" },
      {
        type: "error",
        sessionId: "session-1",
        sequence: 5,
        code: "TIMEOUT",
        fatal: false,
        message: "",
        providerCode: "deadline",
      },
    ] as const;

    for (const event of events) {
      expect(validateServerMessage({ type: "engine.event", event })).toEqual({
        type: "engine.event",
        event,
      });
    }
  });

  it.each([
    { type: "state", sessionId: "", sequence: 1, state: "listening" },
    { type: "segment.upsert", sessionId: "session-1", sequence: 1, segment: { ...segment, id: 1 } },
    { type: "segment.remove", sessionId: "session-1", sequence: 1 },
    { type: "warning", sessionId: "session-1", sequence: 1, code: "UNKNOWN", message: "" },
    { type: "error", sessionId: "session-1", sequence: 1, code: "TIMEOUT", message: "" },
  ])("rejects invalid engine event %#", (event) => {
    expect(() => validateServerMessage({ type: "engine.event", event })).toThrow();
  });

  it("preserves nested engine event and segment objects with extra keys", () => {
    const event = {
      type: "segment.upsert",
      sessionId: "session-1",
      sequence: 2,
      segment,
      providerEventId: "event-1",
    } as const;

    const message = validateServerMessage({ type: "engine.event", event });

    expect(message.event).toBe(event);
    if (message.event.type !== "segment.upsert") {
      throw new Error("expected segment.upsert");
    }
    const preservedEvent = message.event as typeof event;
    expect(preservedEvent.segment).toBe(segment);
    expect(preservedEvent.providerEventId).toBe("event-1");
    expect(preservedEvent.segment.providerMetadata).toEqual({ resultId: "provider-1" });
    expect(preservedEvent.segment.language.provider).toBe("test");
  });

  it("parses JSON messages and rejects top-level extra keys", () => {
    expect(parseJsonMessage('{"type":"session.stop","sessionId":"session-1"}')).toEqual({
      type: "session.stop",
      sessionId: "session-1",
    });
    expect(() => parseJsonMessage("{")).toThrow("message must be valid JSON");
    expect(() =>
      validateClientControl({ type: "session.stop", sessionId: "session-1", extra: true }),
    ).toThrow();
    expect(() =>
      validateServerMessage({
        type: "session.accepted",
        sessionId: "session-1",
        model: "test-model",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects empty session and model strings", () => {
    expect(() => validateClientControl({ type: "session.stop", sessionId: "" })).toThrow();
    expect(() => validateClientControl({ type: "session.cancel", sessionId: "" })).toThrow();
    expect(() =>
      validateServerMessage({ type: "session.accepted", sessionId: "", model: "test-model" }),
    ).toThrow();
    expect(() =>
      validateServerMessage({ type: "session.accepted", sessionId: "session-1", model: "" }),
    ).toThrow();
    expect(() =>
      validateServerMessage({ type: "audio.ack", sessionId: "", throughSequence: 0 }),
    ).toThrow();
  });

  it.each([-1, 1.5])("rejects invalid ACK sequence %s", (throughSequence) => {
    expect(() =>
      validateServerMessage({ type: "audio.ack", sessionId: "session-1", throughSequence }),
    ).toThrow();
  });
});
