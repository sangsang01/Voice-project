import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import { attachTranscriptionHandler } from "../src/websocket/transcriptionHandler";
import { SessionRegistry } from "../src/websocket/sessionLimits";
import { createFakeProviderSessionFactory, FakeSocket } from "./helpers/fakeEngine";

const startMessage = JSON.stringify({
  type: "session.start",
  request: {
    sessionId: "session-1",
    candidateLanguages: ["vi-VN", "en-US"],
    mode: "transcribe",
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
  },
});

function pcmFrame(fill: number): Buffer {
  const buffer = Buffer.alloc(640);
  buffer.fill(fill);
  return buffer;
}

function setup() {
  const socket = new FakeSocket();
  const registry = new SessionRegistry(20);
  const { factory, sessions, emit } = createFakeProviderSessionFactory();
  const handler = attachTranscriptionHandler({
    socket,
    limits: DEFAULT_LIMITS,
    registry,
    createProviderSession: factory,
  });
  return { socket, registry, sessions, emit, handler };
}

describe("attachTranscriptionHandler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates a provider session from a valid session.start", () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    expect(sessions).toHaveLength(1);
  });

  it("forwards binary PCM frames to the provider in order", () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    socket.receive(pcmFrame(1), true);
    socket.receive(pcmFrame(2), true);

    expect(sessions[0]!.writes.map((frame) => frame.sequence)).toEqual([1, 2]);
  });

  it("relays normalized provider events to the socket as JSON", () => {
    const { socket, emit } = setup();
    socket.receive(startMessage, false);
    emit({ type: "state", sessionId: "session-1", sequence: 1, state: "listening" });

    expect(socket.sent).toEqual([JSON.stringify({ type: "state", sessionId: "session-1", sequence: 1, state: "listening" })]);
  });

  it("session.stop drains the provider and closes normally", async () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    socket.receive(JSON.stringify({ type: "session.stop" }), false);
    await vi.waitFor(() => expect(sessions[0]!.stopCalls).toBe(1));

    expect(sessions[0]!.cancelCalls).toBe(0);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1000);
  });

  it("session.cancel cancels the provider immediately and closes", async () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    socket.receive(JSON.stringify({ type: "session.cancel" }), false);
    await vi.waitFor(() => expect(sessions[0]!.cancelCalls).toBe(1));

    expect(sessions[0]!.stopCalls).toBe(0);
    expect(socket.closed).toBe(true);
  });

  it("client disconnect cancels the provider", async () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    socket.disconnect();
    await vi.waitFor(() => expect(sessions[0]!.cancelCalls).toBe(1));
  });

  it("idle timeout cancels the provider and closes after 30 seconds of inactivity", async () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.idleTimeoutMs);

    expect(sessions[0]!.cancelCalls).toBe(1);
    expect(socket.closed).toBe(true);
  });

  it("hard timeout cancels the provider after ten minutes even with activity", async () => {
    const { socket, sessions } = setup();
    socket.receive(startMessage, false);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.hardTimeoutMs / 2);
    socket.receive(pcmFrame(1), true);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.hardTimeoutMs / 2);

    expect(sessions[0]!.cancelCalls).toBe(1);
  });

  it("a protocol failure closes with the mapped close code and never creates a provider session", () => {
    const { socket, sessions } = setup();
    socket.receive("{not json", false);

    expect(sessions).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1008);
  });

  it("an oversized frame closes with 1009", () => {
    const { socket } = setup();
    socket.receive(startMessage, false);
    socket.receive(Buffer.alloc(1280), true);

    expect(socket.closeCode).toBe(1009);
  });

  it("a fatal provider error closes the socket with 1011", async () => {
    const { socket, emit } = setup();
    socket.receive(startMessage, false);
    emit({
      type: "error",
      sessionId: "session-1",
      sequence: 1,
      code: "UNAVAILABLE",
      fatal: true,
      message: "Cloud transcription provider error",
    });
    await vi.waitFor(() => expect(socket.closed).toBe(true));

    expect(socket.closeCode).toBe(1011);
  });

  it("rejects a new session once the server is at capacity", () => {
    const socket = new FakeSocket();
    const registry = new SessionRegistry(0);
    const { factory, sessions } = createFakeProviderSessionFactory();
    attachTranscriptionHandler({ socket, limits: DEFAULT_LIMITS, registry, createProviderSession: factory });

    socket.receive(startMessage, false);

    expect(sessions).toHaveLength(0);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1013);
  });

  it("server shutdown cancels an active session via the returned finalize handle", async () => {
    const { socket, sessions, handler } = setup();
    socket.receive(startMessage, false);
    await handler.finalize("server-shutdown");

    expect(sessions[0]!.cancelCalls).toBe(1);
    expect(socket.closeCode).toBe(1011);
  });
});
