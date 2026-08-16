import { describe, expect, it } from "vitest";
import { RemoteWhisperEngine } from "../src/index.js";
import { FakeSocket } from "./fakeSocket.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

function createOpeningFactory(sockets: FakeSocket[]) {
  return (url: string, protocols: readonly string[]) => {
    const socket = new FakeSocket(url, protocols);
    sockets.push(socket);
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string | ArrayBuffer) => {
      originalSend(data);
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as { type?: string; sessionId?: string };
      if (message.type === "session.cancel" && message.sessionId) {
        queueMicrotask(() => {
          socket.emitJson({
            type: "engine.event",
            event: {
              type: "state",
              sessionId: message.sessionId,
              sequence: 0,
              state: "stopped",
            },
          });
        });
      }
    };
    queueMicrotask(() => socket.open());
    return socket;
  };
}

describe("RemoteWhisperEngine lifecycle", () => {
  it("inspects loopback endpoints as available", async () => {
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: () => new FakeSocket("ws://127.0.0.1:8787"),
    });
    await expect(engine.inspect()).resolves.toEqual({ available: true });
  });

  it("inspects a LAN URL as unavailable", async () => {
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://192.168.1.8:8787",
      socketFactory: () => new FakeSocket("ws://192.168.1.8:8787"),
    });
    const inspection = await engine.inspect();
    expect(inspection.available).toBe(false);
    expect(inspection.reason).toMatch(/loopback/);
  });

  it("inspects wss loopback as unavailable", async () => {
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://127.0.0.1:8787",
      socketFactory: () => new FakeSocket("wss://127.0.0.1:8787"),
    });
    const inspection = await engine.inspect();
    expect(inspection.available).toBe(false);
    expect(inspection.reason).toMatch(/ws/);
  });

  it("opens a session only after session.accepted", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: createOpeningFactory(sockets),
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "small",
      backend: "cpu",
    });
    const session = await opening;
    expect(sockets[0]!.protocols).toContain("voice-transcription.v1");
    expect(sockets[0]!.sentJson()).toContainEqual({ type: "session.start", protocol: 1, request });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.cancel();
    expect(sockets[0]!.sentJson()).toContainEqual({ type: "session.cancel", sessionId: request.sessionId });
    await engine.dispose();
  });

  it("emits one fatal UNAVAILABLE and stopped when the socket closes", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "small",
      backend: "cpu",
    });
    const session = await opening;
    const events: Array<{ type: string; code?: string; state?: string }> = [];
    session.subscribe((event) => events.push(event as { type: string; code?: string; state?: string }));
    sockets[0]!.close(1006, "lost");
    expect(events.some((event) => event.type === "error" && event.code === "UNAVAILABLE")).toBe(true);
    expect(events.some((event) => event.type === "state" && event.state === "stopped")).toBe(true);
    await engine.dispose();
  });

  it("rejects open before prepare", async () => {
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: () => new FakeSocket("ws://127.0.0.1:8787"),
    });
    await expect(engine.open(request)).rejects.toThrow(/prepared/);
  });

  it("rejects open on a fatal engine event before session.accepted", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: createOpeningFactory(sockets),
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({
      type: "engine.event",
      event: {
        type: "error",
        sessionId: request.sessionId,
        sequence: 0,
        code: "RESOURCE_EXHAUSTED",
        fatal: true,
        message: "another listen is already active",
      },
    });
    await expect(opening).rejects.toThrow(/RESOURCE_EXHAUSTED/);
    await engine.dispose();
  });

  it("keeps a fatal TIMEOUT and does not overwrite it with UNAVAILABLE on close", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: createOpeningFactory(sockets),
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "small",
      backend: "cpu",
    });
    const session = await opening;
    const events: Array<{ type: string; code?: string; state?: string; fatal?: boolean }> = [];
    session.subscribe((event) => events.push(event as { type: string; code?: string; state?: string; fatal?: boolean }));
    sockets[0]!.emitJson({
      type: "engine.event",
      event: {
        type: "error",
        sessionId: request.sessionId,
        sequence: 0,
        code: "TIMEOUT",
        fatal: true,
        message: "decode timed out",
      },
    });
    sockets[0]!.close(1006, "lost");
    expect(events.some((event) => event.type === "error" && event.code === "TIMEOUT" && event.fatal === true)).toBe(true);
    expect(events.some((event) => event.type === "error" && event.code === "UNAVAILABLE")).toBe(false);
    expect(events.some((event) => event.type === "state" && event.state === "stopped")).toBe(true);
    expect(session.push({ sequence: 0, startMs: 0, samples: new Int16Array(320) })).toEqual({
      accepted: false,
      reason: "backpressure",
    });
    await engine.dispose();
  });

  it("treats malformed inbound JSON as fatal UNSUPPORTED and closes the socket", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: createOpeningFactory(sockets),
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "small",
      backend: "cpu",
    });
    const session = await opening;
    const events: Array<{ type: string; code?: string; state?: string; fatal?: boolean }> = [];
    session.subscribe((event) => events.push(event as { type: string; code?: string; state?: string; fatal?: boolean }));
    sockets[0]!.emitText("{not-json");
    expect(events.some((event) => event.type === "error" && event.code === "UNSUPPORTED" && event.fatal === true)).toBe(true);
    expect(events.some((event) => event.type === "state" && event.state === "stopped")).toBe(true);
    expect(sockets[0]!.readyState).toBe(3);
    await engine.dispose();
  });

  it("rejects prepare for a non-loopback endpoint without opening a socket", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://192.168.1.8:8787",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    await expect(engine.prepare(request)).rejects.toThrow(/loopback/);
    expect(sockets).toHaveLength(0);
  });

  it("rejects a second concurrent open before session.accepted", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: createOpeningFactory(sockets),
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    await expect(engine.open(request)).rejects.toThrow(/active/);
    sockets[0]!.emitJson({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "small",
      backend: "cpu",
    });
    await opening;
    await engine.dispose();
  });

  it("rejects prepare when the socket closes before it opens", async () => {
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        queueMicrotask(() => socket.close(1006, "refused"));
        return socket;
      },
    });
    await expect(engine.prepare(request)).rejects.toThrow(/unavailable|Whisper server/i);
  });
});
