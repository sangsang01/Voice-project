import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import { attachTranscriptionHandler, type TranscriptionHandler } from "../src/websocket/transcriptionHandler";
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

interface Scenario {
  name: string;
  trigger: (ctx: { socket: FakeSocket; handler: TranscriptionHandler }) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: "stop",
    trigger: async ({ socket }) => socket.receive(JSON.stringify({ type: "session.stop" }), false),
  },
  {
    name: "cancel",
    trigger: async ({ socket }) => socket.receive(JSON.stringify({ type: "session.cancel" }), false),
  },
  { name: "disconnect", trigger: async ({ socket }) => socket.disconnect() },
  {
    name: "idle-timeout",
    trigger: async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.idleTimeoutMs);
    },
  },
  {
    name: "hard-timeout",
    trigger: async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.hardTimeoutMs);
    },
  },
  { name: "protocol-error", trigger: async ({ socket }) => socket.receive(Buffer.alloc(1280), true) },
  { name: "server-shutdown", trigger: async ({ handler }) => handler.finalize("server-shutdown") },
];

describe("transcriptionHandler cleanup invariants (every terminal path)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(scenarios)(
    "$name: closes exactly once, clears timers, removes listeners, stops sending, releases the registry slot",
    async ({ trigger }) => {
      const socket = new FakeSocket();
      const registry = new SessionRegistry(20);
      const { factory, sessions, emit } = createFakeProviderSessionFactory();
      const handler = attachTranscriptionHandler({
        socket,
        limits: DEFAULT_LIMITS,
        registry,
        createProviderSession: factory,
      });

      socket.receive(startMessage, false);
      expect(registry.size).toBe(1);

      await trigger({ socket, handler });
      await vi.waitFor(() => expect(sessions[0]!.stopCalls + sessions[0]!.cancelCalls).toBeGreaterThanOrEqual(1));
      const closeCallsAfterFirst = sessions[0]!.stopCalls + sessions[0]!.cancelCalls;

      // Listeners are gone, so none of these can re-trigger provider close, and the
      // top-level `finalized` guard makes a direct re-call a no-op either way.
      await handler.finalize("cancel");
      socket.receive(JSON.stringify({ type: "session.stop" }), false);
      await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.hardTimeoutMs);

      expect(sessions[0]!.stopCalls + sessions[0]!.cancelCalls).toBe(closeCallsAfterFirst);
      expect(socket.listenerCount("message")).toBe(0);
      expect(socket.listenerCount("close")).toBe(0);
      expect(socket.listenerCount("error")).toBe(0);
      expect(registry.size).toBe(0);

      const sentBeforeLateEvent = socket.sent.length;
      emit({ type: "warning", sessionId: "session-1", sequence: 99, code: "AUDIO_GAP", message: "late event" });
      expect(socket.sent.length).toBe(sentBeforeLateEvent);
    },
  );
});
