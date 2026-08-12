import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import {
  encodePcmMessage,
  parseJsonMessage,
  validateServerMessage,
  type ServerMessage,
} from "@voice/streaming-protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createTranscriptionGateway } from "../src/gateway.js";
import type { DecodeResult, StreamingRuntime, StreamingRuntimeSession, VadUpdate } from "../src/runtime.js";

const PROTOCOL = "voice-transcription.v1";
const ALLOWED_ORIGIN = "http://localhost:5173";

interface Harness {
  server: Server;
  url: string;
  runtime: StreamingRuntime;
  opened: SessionRequest[];
  closedSessions: number;
  pushFrames: PcmFrame[];
  authenticateCalls: Array<string | undefined>;
  closeGateway: () => void;
}

function createFakeRuntime(tracker: {
  opened: SessionRequest[];
  closedSessions: { count: number };
  pushFrames: PcmFrame[];
}): StreamingRuntime {
  return {
    modelName: "fake-whisper-small",
    async open(request) {
      tracker.opened.push(request);
      const session: StreamingRuntimeSession = {
        push(frame) {
          tracker.pushFrames.push(frame);
          return { speechStarted: false, speechEnded: false } satisfies VadUpdate;
        },
        async decode(): Promise<DecodeResult> {
          return { text: "ignored", language: "en", startMs: 0, endMs: 20 };
        },
        async close() {
          tracker.closedSessions.count += 1;
        },
      };
      return session;
    },
  };
}

async function startHarness(options?: {
  capacity?: number;
  allowedOrigins?: string[];
  authenticate?: (token: string | undefined) => { accountId: string };
}): Promise<Harness> {
  const opened: SessionRequest[] = [];
  const closedSessions = { count: 0 };
  const pushFrames: PcmFrame[] = [];
  const authenticateCalls: Array<string | undefined> = [];
  const runtime = createFakeRuntime({ opened, closedSessions, pushFrames });
  const server = createServer();
  const closeGateway = createTranscriptionGateway({
    server,
    runtime,
    capacity: options?.capacity ?? 2,
    allowedOrigins: options?.allowedOrigins ?? [ALLOWED_ORIGIN],
    authenticate:
      options?.authenticate ??
      ((token) => {
        authenticateCalls.push(token);
        if (token === undefined || token.length === 0) {
          throw new Error("missing access token");
        }
        return { accountId: `account-${token}` };
      }),
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");

  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
    runtime,
    opened,
    get closedSessions() {
      return closedSessions.count;
    },
    pushFrames,
    authenticateCalls,
    closeGateway,
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.closeGateway();
  harness.server.close();
  await once(harness.server, "close");
}

function connect(
  harness: Harness,
  options?: { origin?: string | undefined; token?: string | undefined; protocols?: string | string[] },
): WebSocket {
  const url = new URL(harness.url);
  if (options && "token" in options) {
    if (options.token !== undefined) url.searchParams.set("access_token", options.token);
  } else {
    url.searchParams.set("access_token", "test-token");
  }
  return new WebSocket(url, options?.protocols ?? PROTOCOL, {
    origin: "origin" in (options ?? {}) ? options?.origin : ALLOWED_ORIGIN,
  });
}

async function waitOpen(socket: WebSocket): Promise<void> {
  ensureSocketQueue(socket);
  if (socket.readyState === WebSocket.OPEN) return;
  await once(socket, "open");
}

const socketQueues = new WeakMap<WebSocket, {
  messages: ServerMessage[];
  waiters: Array<{
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  }>;
  listening: boolean;
}>();

function ensureSocketQueue(socket: WebSocket) {
  let queue = socketQueues.get(socket);
  if (queue) return queue;

  queue = { messages: [], waiters: [], listening: true };
  socketQueues.set(socket, queue);

  socket.on("message", (data: WebSocket.RawData) => {
    try {
      if (typeof data !== "string" && !(data instanceof Buffer)) {
        const waiter = queue!.waiters.shift();
        waiter?.reject(new TypeError("expected text server message"));
        return;
      }
      const text = typeof data === "string" ? data : data.toString("utf8");
      const message = validateServerMessage(parseJsonMessage(text));
      const waiter = queue!.waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue!.messages.push(message);
    } catch (error) {
      const waiter = queue!.waiters.shift();
      waiter?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  socket.on("close", (code, reason) => {
    const pending = queue!.waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(new Error(`socket closed before message: ${code} ${reason.toString("utf8")}`));
    }
  });

  socket.on("error", (error) => {
    const pending = queue!.waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(error);
    }
  });

  return queue;
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  const queue = ensureSocketQueue(socket);
  const queued = queue.messages.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    queue.waiters.push({ resolve, reject });
  });
}

function waitClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve({ code: socket.closeCode ?? 0, reason: "" });
      return;
    }
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", reject);
  });
}

function makeFrame(sequence: number, startMs = sequence * 20): PcmFrame {
  return { sequence, startMs, samples: new Int16Array(320) };
}

function startControl(request: SessionRequest = makeSessionRequest(["en-US"])) {
  return JSON.stringify({ type: "session.start", protocol: 1, request });
}

async function acceptedSession(
  harness: Harness,
  request: SessionRequest = makeSessionRequest(["en-US"]),
): Promise<WebSocket> {
  const socket = connect(harness);
  await waitOpen(socket);
  socket.send(startControl(request));
  const accepted = await nextMessage(socket);
  expect(accepted).toEqual({
    type: "session.accepted",
    sessionId: request.sessionId,
    model: "fake-whisper-small",
  });
  const listening = await nextMessage(socket);
  expect(listening).toMatchObject({
    type: "engine.event",
    event: { type: "state", state: "listening", sessionId: request.sessionId },
  });
  return socket;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await stopHarness(harness);
  }
});

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const created = await startHarness(options);
  harnesses.push(created);
  return created;
}

describe("createTranscriptionGateway", () => {
  it("accepts session.start after authenticating and reserving capacity", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US", "vi-VN"]);
    const socket = connect(h);
    await waitOpen(socket);
    const pending = nextMessage(socket);
    socket.send(startControl(request));
    const accepted = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out; opened=${h.opened.length}`)), 1000),
      ),
    ]);
    expect(accepted).toEqual({
      type: "session.accepted",
      sessionId: request.sessionId,
      model: "fake-whisper-small",
    });
    expect(h.authenticateCalls).toEqual(["test-token"]);
    expect(h.opened).toEqual([request]);
    socket.close();
    await waitClose(socket);
  });

  it("decodes binary PCM and emits audio.ack after the scheduler accepts it", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, request);
    const frame = makeFrame(0);

    socket.send(encodePcmMessage(frame));
    const ack = await nextMessage(socket);
    expect(ack).toEqual({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 0,
    });
    expect(h.pushFrames).toHaveLength(1);
    expect(h.pushFrames[0]!.sequence).toBe(0);
    expect(h.pushFrames[0]!.samples).toEqual(frame.samples);

    socket.close();
    await waitClose(socket);
  });

  it("rejects a second session.start while one session is active on the socket", async () => {
    const h = await harness();
    const first = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, first);

    const second = { ...makeSessionRequest(["es-ES"]), sessionId: "second-session" };
    socket.send(startControl(second));

    const errorMessage = await nextMessage(socket);
    expect(errorMessage.type).toBe("engine.event");
    if (errorMessage.type !== "engine.event") throw new Error("expected engine.event");
    expect(errorMessage.event).toMatchObject({
      type: "error",
      code: "UNSUPPORTED",
      fatal: true,
    });

    const closed = await waitClose(socket);
    expect(closed.code).toBe(4000);
  });

  it("stops a session by draining then emitting stopped and closing with 4000", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, request);

    socket.send(JSON.stringify({ type: "session.stop", sessionId: request.sessionId }));

    const events: EngineEvent[] = [];
    for (;;) {
      const message = await nextMessage(socket);
      if (message.type !== "engine.event") continue;
      events.push(message.event);
      if (message.event.type === "state" && message.event.state === "stopped") break;
    }

    expect(events.some((event) => event.type === "state" && event.state === "draining")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "state", state: "stopped" });
    expect(h.closedSessions).toBe(1);

    const closed = await waitClose(socket);
    expect(closed.code).toBe(4000);
  });

  it("cancels a session, closes the runtime, and closes with 4000", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, request);

    socket.send(JSON.stringify({ type: "session.cancel", sessionId: request.sessionId }));

    const events: EngineEvent[] = [];
    for (;;) {
      const message = await nextMessage(socket);
      if (message.type !== "engine.event") continue;
      events.push(message.event);
      if (message.event.type === "state" && message.event.state === "stopped") break;
    }

    expect(events.at(-1)).toMatchObject({ type: "state", state: "stopped" });
    expect(h.closedSessions).toBe(1);

    const closed = await waitClose(socket);
    expect(closed.code).toBe(4000);
  });

  it("terminates malformed JSON with INVALID_AUDIO and close code 4000", async () => {
    const h = await harness();
    const socket = connect(h);
    await waitOpen(socket);
    socket.send("{not-json");

    const errorMessage = await nextMessage(socket);
    expect(errorMessage).toMatchObject({
      type: "engine.event",
      event: { type: "error", code: "INVALID_AUDIO", fatal: true },
    });
    const closed = await waitClose(socket);
    expect(closed.code).toBe(4000);
  });

  it("terminates malformed 656-byte PCM with INVALID_AUDIO and close code 4000", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, request);

    const bad = new ArrayBuffer(656);
    const view = new DataView(bad);
    view.setUint8(0, 1);
    view.setUint8(1, 99); // wrong message type
    socket.send(bad);

    const errorMessage = await nextMessage(socket);
    expect(errorMessage).toMatchObject({
      type: "engine.event",
      event: { type: "error", code: "INVALID_AUDIO", fatal: true, sessionId: request.sessionId },
    });
    const closed = await waitClose(socket);
    expect(closed.code).toBe(4000);
  });

  it("emits AUDIO_GAP for a bounded sequence gap and continues acknowledging later frames", async () => {
    const h = await harness();
    const request = makeSessionRequest(["en-US"]);
    const socket = await acceptedSession(h, request);

    socket.send(encodePcmMessage(makeFrame(0)));
    expect(await nextMessage(socket)).toMatchObject({ type: "audio.ack", throughSequence: 0 });

    socket.send(encodePcmMessage(makeFrame(2)));
    const gapWarning = await nextMessage(socket);
    expect(gapWarning).toMatchObject({
      type: "engine.event",
      event: { type: "warning", code: "AUDIO_GAP", sessionId: request.sessionId },
    });
    expect(await nextMessage(socket)).toMatchObject({ type: "audio.ack", throughSequence: 2 });

    socket.send(encodePcmMessage(makeFrame(3)));
    expect(await nextMessage(socket)).toMatchObject({ type: "audio.ack", throughSequence: 3 });

    socket.close();
    await waitClose(socket);
  });

  it("rejects disallowed origins before the socket opens", async () => {
    const h = await harness();
    const socket = connect(h, { origin: "https://evil.example" });
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("unexpected-response", () => reject(new Error("origin rejected")));
        socket.once("error", () => reject(new Error("origin rejected")));
        socket.once("close", () => reject(new Error("origin rejected")));
      }),
    ).rejects.toThrow(/origin rejected/);
    expect(h.opened).toHaveLength(0);
  });

  it("rejects admission with RESOURCE_EXHAUSTED before session.accepted when at capacity", async () => {
    const h = await harness({ capacity: 1 });
    const firstRequest = makeSessionRequest(["en-US"]);
    const first = await acceptedSession(h, firstRequest);

    const secondRequest = { ...makeSessionRequest(["en-US"]), sessionId: "capacity-session" };
    const second = connect(h);
    await waitOpen(second);
    second.send(startControl(secondRequest));

    const errorMessage = await nextMessage(second);
    expect(errorMessage).toMatchObject({
      type: "engine.event",
      event: {
        type: "error",
        code: "RESOURCE_EXHAUSTED",
        fatal: true,
        sessionId: secondRequest.sessionId,
      },
    });
    expect(h.opened).toHaveLength(1);

    const closed = await waitClose(second);
    expect(closed.code).toBe(4000);

    first.close();
    await waitClose(first);
  });

  it("releases admission capacity when a session socket closes", async () => {
    const h = await harness({ capacity: 1 });
    const firstRequest = makeSessionRequest(["en-US"]);
    const first = await acceptedSession(h, firstRequest);
    first.close();
    await waitClose(first);

    // Allow close handlers to release the admission slot.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondRequest = { ...makeSessionRequest(["en-US"]), sessionId: "after-release" };
    const second = await acceptedSession(h, secondRequest);
    expect(h.opened.map((request) => request.sessionId)).toEqual([
      firstRequest.sessionId,
      secondRequest.sessionId,
    ]);
    second.close();
    await waitClose(second);
  });
});
