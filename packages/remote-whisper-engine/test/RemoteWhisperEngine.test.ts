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
});
