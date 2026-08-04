import { describe, expect, it } from "vitest";
import { createProtocolState, parseClientMessage, PCM_FRAME_BYTES, ProtocolError } from "../src/websocket/protocol";

const validStartMessage = JSON.stringify({
  type: "session.start",
  request: {
    sessionId: "session-1",
    candidateLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
    mode: "transcribe",
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
  },
});

function frame(byteLength: number): Buffer {
  return Buffer.alloc(byteLength);
}

describe("parseClientMessage", () => {
  it("accepts a valid session.start as the first message", () => {
    const state = createProtocolState();
    const message = parseClientMessage(state, validStartMessage, false);
    expect(message).toEqual({
      kind: "session.start",
      request: {
        sessionId: "session-1",
        candidateLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
        mode: "transcribe",
        audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
      },
    });
    expect(state.started).toBe(true);
  });

  it("accepts exactly one 640-byte PCM frame after start", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    const message = parseClientMessage(state, frame(PCM_FRAME_BYTES), true);
    expect(message.kind).toBe("audio.frame");
  });

  it("accepts session.stop, session.cancel, and session.ping after start", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    expect(parseClientMessage(state, JSON.stringify({ type: "session.stop" }), false)).toEqual({ kind: "session.stop" });
    expect(parseClientMessage(state, JSON.stringify({ type: "session.cancel" }), false)).toEqual({
      kind: "session.cancel",
    });
    expect(parseClientMessage(state, JSON.stringify({ type: "session.ping" }), false)).toEqual({
      kind: "session.ping",
    });
  });

  it("rejects audio before session.start (invalid order)", () => {
    const state = createProtocolState();
    expect(() => parseClientMessage(state, frame(PCM_FRAME_BYTES), true)).toThrow(ProtocolError);
    try {
      parseClientMessage(state, frame(PCM_FRAME_BYTES), true);
    } catch (error) {
      expect((error as ProtocolError).closeCode).toBe(1008);
    }
  });

  it("rejects a control message before session.start", () => {
    const state = createProtocolState();
    expect(() => parseClientMessage(state, JSON.stringify({ type: "session.stop" }), false)).toThrow(ProtocolError);
  });

  it("rejects malformed JSON", () => {
    const state = createProtocolState();
    expect(() => parseClientMessage(state, "{not json", false)).toThrow(ProtocolError);
  });

  it("rejects a duplicate session.start", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    expect(() => parseClientMessage(state, validStartMessage, false)).toThrow(ProtocolError);
  });

  it("rejects session.start with unsupported metadata", () => {
    const state = createProtocolState();
    const withExtra = JSON.stringify({
      type: "session.start",
      request: JSON.parse(validStartMessage).request,
      credentials: "should-not-be-here",
    });
    expect(() => parseClientMessage(state, withExtra, false)).toThrow(ProtocolError);
  });

  it("rejects a frame with an odd byte length as a policy violation (1008)", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    try {
      parseClientMessage(state, frame(PCM_FRAME_BYTES - 1), true);
      throw new Error("expected ProtocolError");
    } catch (error) {
      expect((error as ProtocolError).closeCode).toBe(1008);
    }
  });

  it("rejects an undersized frame as a policy violation (1008)", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    try {
      parseClientMessage(state, frame(320), true);
      throw new Error("expected ProtocolError");
    } catch (error) {
      expect((error as ProtocolError).closeCode).toBe(1008);
    }
  });

  it("rejects an oversized frame as message-too-big (1009)", () => {
    const state = createProtocolState();
    parseClientMessage(state, validStartMessage, false);
    try {
      parseClientMessage(state, frame(PCM_FRAME_BYTES * 2), true);
      throw new Error("expected ProtocolError");
    } catch (error) {
      expect((error as ProtocolError).closeCode).toBe(1009);
    }
  });

  it("never echoes the raw payload content in the thrown error", () => {
    const state = createProtocolState();
    const secret = "{ malformed json with secret-token-xyz";
    try {
      parseClientMessage(state, secret, false);
      throw new Error("expected ProtocolError");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-token-xyz");
    }
  });
});
