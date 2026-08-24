import { encodePcmMessage, validateServerMessage } from "@voice/streaming-protocol";
import type { SessionRequest } from "@voice/transcription-contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { FakeRuntime } from "../src/fakeRuntime.js";
import { createTranscriptionGateway } from "../src/gateway.js";
import type { DecodeResult, StreamingRuntimeSession, VadUpdate } from "../src/runtime.js";

const SUBPROTOCOL = "voice-transcription.v1";
const ALLOWED_ORIGIN = "http://localhost:5173";

const request: SessionRequest = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
};

interface StartedGateway {
  port: number;
  close(): Promise<void>;
}

const gateways: StartedGateway[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

function sessionStart(sessionId = request.sessionId): string {
  return JSON.stringify({
    type: "session.start",
    protocol: 1,
    request: { ...request, sessionId },
  });
}

function pcmFrame(sequence: number): ArrayBuffer {
  return encodePcmMessage({
    sequence,
    startMs: sequence * 20,
    samples: Int16Array.from({ length: 320 }, () => 1000),
  });
}

async function listen(runtime: FakeRuntime = new FakeRuntime()): Promise<StartedGateway & { runtime: FakeRuntime }> {
  const gateway = await createTranscriptionGateway({
    host: "127.0.0.1",
    port: 0,
    runtime,
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  gateways.push(gateway);
  return { ...gateway, runtime };
}

function track(socket: WebSocket): WebSocket {
  sockets.push(socket);
  return socket;
}

async function openSocket(port: number, origin = ALLOWED_ORIGIN): Promise<WebSocket> {
  const socket = track(
    new WebSocket(`ws://127.0.0.1:${port}`, SUBPROTOCOL, { origin }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
    socket.once("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade rejected: ${res.statusCode}`));
    });
  });
  return socket;
}

interface Client {
  socket: WebSocket;
  messages: unknown[];
  closeCode: Promise<number>;
}

function attachClient(socket: WebSocket): Client {
  const messages: unknown[] = [];
  const closeCode = new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    messages.push(validateServerMessage(JSON.parse(data.toString())));
  });
  return { socket, messages, closeCode };
}

async function connect(port: number): Promise<Client> {
  return attachClient(await openSocket(port));
}

async function waitFor(
  client: Client,
  predicate: (message: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = client.messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for message; saw ${JSON.stringify(client.messages)}`);
}

async function startSession(port: number, sessionId = request.sessionId): Promise<Client> {
  const client = await connect(port);
  client.socket.send(sessionStart(sessionId));
  await waitFor(client, (message) => {
    return typeof message === "object" && message !== null && (message as { type?: string }).type === "session.accepted";
  });
  return client;
}

async function expectUpgradeRejected(port: number, protocols?: string | string[]): Promise<void> {
  const socket = track(
    protocols === undefined
      ? new WebSocket(`ws://127.0.0.1:${port}`, { origin: ALLOWED_ORIGIN })
      : new WebSocket(`ws://127.0.0.1:${port}`, protocols, { origin: ALLOWED_ORIGIN }),
  );
  const outcome = await new Promise<"rejected" | "opened">((resolve) => {
    socket.once("open", () => resolve("opened"));
    socket.once("unexpected-response", () => resolve("rejected"));
    socket.once("error", () => resolve("rejected"));
  });
  expect(outcome).toBe("rejected");
}

class RejectingDecodeRuntime extends FakeRuntime {
  public override open(): Promise<StreamingRuntimeSession> {
    this.openCount += 1;
    let speechStarted = false;
    return Promise.resolve({
      push(): VadUpdate {
        if (speechStarted) return { speechStarted: false, speechEnded: false, maxDuration: false };
        speechStarted = true;
        return { speechStarted: true, speechEnded: false, maxDuration: false };
      },
      decode(): Promise<DecodeResult> {
        return Promise.reject(new Error("decode failed"));
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    });
  }
}

describe("transcription gateway", () => {
  it("accepts session.start with model and backend", async () => {
    const gateway = await listen();
    const client = await connect(gateway.port);
    client.socket.send(sessionStart());

    const accepted = await waitFor(client, (message) => {
      return typeof message === "object" && message !== null && (message as { type?: string }).type === "session.accepted";
    });
    expect(accepted).toMatchObject({
      type: "session.accepted",
      sessionId: "session-1",
      model: gateway.runtime.modelName,
      backend: gateway.runtime.backend,
    });
  });

  it("decodes a 656-byte PCM frame and answers with audio.ack", async () => {
    const gateway = await listen();
    const client = await startSession(gateway.port);
    client.socket.send(pcmFrame(0));

    const ack = await waitFor(client, (message) => {
      return typeof message === "object" && message !== null && (message as { type?: string }).type === "audio.ack";
    });
    expect(ack).toMatchObject({
      type: "audio.ack",
      sessionId: "session-1",
      throughSequence: 0,
    });
  });

  it("rejects a second session.start on the same socket with RESOURCE_EXHAUSTED", async () => {
    const gateway = await listen();
    const client = await startSession(gateway.port);
    client.socket.send(sessionStart("session-2"));

    const exhausted = await waitFor(client, (message) => {
      return (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "engine.event" &&
        (message as { event?: { code?: string } }).event?.code === "RESOURCE_EXHAUSTED"
      );
    });
    expect(exhausted).toMatchObject({
      type: "engine.event",
      event: {
        type: "error",
        code: "RESOURCE_EXHAUSTED",
        fatal: true,
      },
    });
    expect(JSON.stringify(exhausted)).toMatch(/capacity: 1/);
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("rejects a second concurrent socket with RESOURCE_EXHAUSTED", async () => {
    const gateway = await listen();
    const first = await startSession(gateway.port, "session-1");
    const second = await connect(gateway.port);
    second.socket.send(sessionStart("session-2"));

    const exhausted = await waitFor(second, (message) => {
      return (
        typeof message === "object" &&
        message !== null &&
        (message as { event?: { code?: string } }).event?.code === "RESOURCE_EXHAUSTED"
      );
    });
    expect(exhausted).toMatchObject({
      event: { type: "error", code: "RESOURCE_EXHAUSTED", fatal: true },
    });
    expect(JSON.stringify(exhausted)).toMatch(/capacity: 1/);
    await expect(second.closeCode).resolves.toBe(4000);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("session.stop releases capacity so a later socket can start", async () => {
    const gateway = await listen();
    const first = await startSession(gateway.port, "session-1");
    first.socket.send(JSON.stringify({ type: "session.stop", sessionId: "session-1" }));
    await waitFor(first, (message) => {
      return (message as { event?: { state?: string } }).event?.state === "stopped";
    });

    const second = await startSession(gateway.port, "session-2");
    expect(second.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.accepted", sessionId: "session-2" }),
      ]),
    );
  });

  it("session.cancel releases capacity so a later socket can start", async () => {
    const gateway = await listen();
    const first = await startSession(gateway.port, "session-1");
    first.socket.send(JSON.stringify({ type: "session.cancel", sessionId: "session-1" }));
    await waitFor(first, (message) => {
      return (message as { event?: { state?: string } }).event?.state === "stopped";
    });

    const second = await startSession(gateway.port, "session-2");
    expect(second.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.accepted", sessionId: "session-2" }),
      ]),
    );
  });

  it("malformed JSON produces UNSUPPORTED then close 4000", async () => {
    const gateway = await listen();
    const client = await connect(gateway.port);
    client.socket.send("{");

    const error = await waitFor(client, (message) => {
      return (message as { event?: { code?: string } }).event?.code === "UNSUPPORTED";
    });
    expect(error).toMatchObject({
      event: { type: "error", code: "UNSUPPORTED", fatal: true },
    });
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("malformed PCM produces INVALID_AUDIO then close 4000", async () => {
    const gateway = await listen();
    const client = await startSession(gateway.port);
    client.socket.send(new ArrayBuffer(656));

    const error = await waitFor(client, (message) => {
      return (message as { event?: { code?: string } }).event?.code === "INVALID_AUDIO";
    });
    expect(error).toMatchObject({
      event: { type: "error", code: "INVALID_AUDIO", fatal: true },
    });
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("a sequence gap produces AUDIO_GAP then close 4000", async () => {
    const gateway = await listen();
    const client = await startSession(gateway.port);
    client.socket.send(pcmFrame(0));
    await waitFor(client, (message) => {
      return (message as { type?: string }).type === "audio.ack";
    });
    client.socket.send(pcmFrame(2));

    const warning = await waitFor(client, (message) => {
      return (message as { event?: { code?: string } }).event?.code === "AUDIO_GAP";
    });
    expect(warning).toMatchObject({
      event: { type: "warning", code: "AUDIO_GAP" },
    });
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("rejects Origin not in allowedOrigins at upgrade", async () => {
    const gateway = await listen();
    const socket = track(
      new WebSocket(`ws://127.0.0.1:${gateway.port}`, SUBPROTOCOL, {
        origin: "http://evil.example",
      }),
    );
    const outcome = await new Promise<"rejected" | "opened">((resolve) => {
      socket.once("open", () => resolve("opened"));
      socket.once("unexpected-response", () => resolve("rejected"));
      socket.once("error", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  it("throws when binding a non-loopback host", () => {
    expect(() => {
      void createTranscriptionGateway({
        host: "0.0.0.0",
        port: 0,
        runtime: new FakeRuntime(),
        allowedOrigins: [ALLOWED_ORIGIN],
      });
    }).toThrow(/loopback/);
  });

  it("does not accept session.start until runtime.ready resolves", async () => {
    const runtime = new FakeRuntime();
    let releaseReady!: () => void;
    runtime.readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const gateway = await listen(runtime);
    const client = await connect(gateway.port);
    client.socket.send(sessionStart());

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.messages.some((message) => (message as { type?: string }).type === "session.accepted")).toBe(false);

    releaseReady();
    await waitFor(client, (message) => (message as { type?: string }).type === "session.accepted");
  });

  it("releases admission if the client disconnects while ready() is pending", async () => {
    const runtime = new FakeRuntime();
    let readyCalls = 0;
    let enteredFirstReady!: () => void;
    const firstReadyEntered = new Promise<void>((resolve) => {
      enteredFirstReady = resolve;
    });
    const readyImpl = runtime.ready.bind(runtime);
    runtime.ready = async () => {
      readyCalls += 1;
      if (readyCalls === 1) {
        enteredFirstReady();
        await new Promise<void>(() => undefined);
      }
      return readyImpl();
    };

    const gateway = await listen(runtime);
    const first = await connect(gateway.port);
    first.socket.send(sessionStart("session-1"));
    await firstReadyEntered;
    first.socket.close();
    await first.closeCode;

    const second = await startSession(gateway.port, "session-2");
    expect(second.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.accepted", sessionId: "session-2" }),
      ]),
    );
  });

  it("rejects a client that omits the subprotocol at upgrade", async () => {
    const gateway = await listen();
    await expectUpgradeRejected(gateway.port);
  });

  it("rejects a client that offers the wrong subprotocol at upgrade", async () => {
    const gateway = await listen();
    await expectUpgradeRejected(gateway.port, "not-voice-transcription");
  });

  it("PCM before session.start produces INVALID_AUDIO then close 4000", async () => {
    const gateway = await listen();
    const client = await connect(gateway.port);
    client.socket.send(pcmFrame(0));

    const error = await waitFor(client, (message) => {
      return (message as { event?: { code?: string } }).event?.code === "INVALID_AUDIO";
    });
    expect(error).toMatchObject({
      event: { type: "error", code: "INVALID_AUDIO", fatal: true },
    });
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("decode rejection emits a fatal event and closes the socket with 4000", async () => {
    const gateway = await listen(new RejectingDecodeRuntime());
    const client = await startSession(gateway.port);
    client.socket.send(pcmFrame(0));

    const error = await waitFor(
      client,
      (message) => {
        return (
          (message as { event?: { type?: string; fatal?: boolean } }).event?.type === "error" &&
          (message as { event?: { fatal?: boolean } }).event?.fatal === true
        );
      },
      2500,
    );
    expect(error).toMatchObject({
      event: { type: "error", fatal: true, code: "INTERNAL" },
    });
    await expect(client.closeCode).resolves.toBe(4000);
  });

  it("reopens after close without reloading weights", async () => {
    const runtime = new FakeRuntime();
    const gateway = await listen(runtime);
    const first = await startSession(gateway.port, "session-1");
    expect(runtime.loadCount).toBe(1);
    expect(runtime.openCount).toBe(1);

    first.socket.close();
    await first.closeCode;

    const second = await startSession(gateway.port, "session-2");
    expect(second.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.accepted", sessionId: "session-2" }),
      ]),
    );
    expect(runtime.openCount).toBeGreaterThan(1);
    expect(runtime.loadCount).toBe(1);
  });
});
