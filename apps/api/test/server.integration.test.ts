import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_LIMITS } from "../src/config";
import { createServer, type TranscriptionServer } from "../src/server";
import { createFakeProviderSessionFactory } from "./helpers/fakeEngine";

const startMessage = {
  type: "session.start",
  request: {
    sessionId: "session-1",
    candidateLanguages: ["vi-VN", "en-US"],
    mode: "transcribe",
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
  },
};

async function startServer(allowedOrigins: string[]) {
  const { factory, sessions, emit } = createFakeProviderSessionFactory();
  const server = createServer({ createProviderSession: factory, limits: DEFAULT_LIMITS, allowedOrigins });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { server, sessions, emit, url: `ws://127.0.0.1:${port}` };
}

function connect(url: string, origin: string, tracked: WebSocket[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    tracked.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createServer (integration, injected fake provider, no network/credentials)", () => {
  let activeServer: TranscriptionServer | undefined;
  let activeSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of activeSockets) {
      if (socket.readyState !== socket.CLOSED) socket.terminate();
    }
    activeSockets = [];
    await activeServer?.close();
    activeServer = undefined;
  });

  it("accepts a session, forwards two frames in order, and relays provisional/final events, then stops", async () => {
    const { server, sessions, emit, url } = await startServer(["http://localhost:5173"]);
    activeServer = server;

    const socket = await connect(url, "http://localhost:5173", activeSockets);
    const received: any[] = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));

    socket.send(JSON.stringify(startMessage));
    await waitUntil(() => sessions.length === 1);

    socket.send(Buffer.alloc(640, 1));
    socket.send(Buffer.alloc(640, 2));
    await waitUntil(() => sessions[0]!.writes.length === 2);
    expect(sessions[0]!.writes.map((frame) => frame.sequence)).toEqual([1, 2]);

    const provisional = {
      type: "segment.upsert" as const,
      sessionId: "session-1",
      sequence: 1,
      segment: {
        id: "google-1",
        ordinal: 1,
        revision: 1,
        startMs: 0,
        endMs: 400,
        text: "Xin",
        language: { tag: "vi-VN" },
        isFinal: false,
      },
    };
    const final = { ...provisional, sequence: 2, segment: { ...provisional.segment, revision: 2, text: "Xin chào", isFinal: true } };
    emit(provisional);
    emit(final);
    await waitUntil(() => received.length === 2);
    expect(received).toEqual([provisional, final]);

    const closePromise = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify({ type: "session.stop" }));
    await waitUntil(() => sessions[0]!.stopCalls === 1);
    expect(await closePromise).toBe(1000);
  });

  it("session.cancel cancels the provider without waiting for a drain", async () => {
    const { server, sessions, url } = await startServer(["http://localhost:5173"]);
    activeServer = server;

    const socket = await connect(url, "http://localhost:5173", activeSockets);
    socket.send(JSON.stringify(startMessage));
    await waitUntil(() => sessions.length === 1);

    socket.send(JSON.stringify({ type: "session.cancel" }));
    await waitUntil(() => sessions[0]!.cancelCalls === 1);
    expect(sessions[0]!.stopCalls).toBe(0);
  });

  it("rejects a WebSocket upgrade whose Origin is not an exact allowlist match", async () => {
    const { server, url } = await startServer(["http://localhost:5173"]);
    activeServer = server;

    await expect(connect(url, "http://evil.example.com", activeSockets)).rejects.toThrow();
  });
});
