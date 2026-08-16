import {
  assertLoopbackBindHost,
  decodePcmMessage,
  parseJsonMessage,
  validateClientControl,
} from "@voice/streaming-protocol";
import type { EngineEvent, ErrorCode, SessionRequest, WarningCode } from "@voice/transcription-contracts";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import { AdmissionPool } from "./admission.js";
import type { StreamingRuntime, StreamingRuntimeSession } from "./runtime.js";
import { SessionScheduler } from "./sessionScheduler.js";

const SUBPROTOCOL = "voice-transcription.v1";
const CLOSE_PROTOCOL = 4000;

export interface GatewayOptions {
  host: string;
  port: number;
  runtime: StreamingRuntime;
  capacity?: number;
  allowedOrigins: readonly string[];
}

export interface TranscriptionGateway {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

interface ConnectionState {
  started: boolean;
  cleaned: boolean;
  sessionId: string;
  lastPcmSequence: number | undefined;
  nextEventSequence: number;
  release: (() => void) | undefined;
  scheduler: SessionScheduler | undefined;
  runtimeSession: StreamingRuntimeSession | undefined;
}

export function createTranscriptionGateway(options: GatewayOptions): Promise<TranscriptionGateway> {
  assertLoopbackBindHost(options.host);
  const capacity = options.capacity ?? 1;
  const pool = new AdmissionPool(capacity);

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: options.host,
      port: options.port,
      handleProtocols(protocols: Set<string>) {
        return protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false;
      },
      verifyClient(info: { origin: string; secure: boolean; req: IncomingMessage }) {
        return options.allowedOrigins.includes(info.origin);
      },
    });

    const onListenError = (error: Error) => reject(error);
    wss.once("error", onListenError);
    wss.once("listening", () => {
      wss.off("error", onListenError);
      const address = wss.address();
      if (!address || typeof address === "string") {
        wss.close();
        reject(new Error("failed to bind transcription gateway"));
        return;
      }

      wss.on("connection", (socket) => {
        bindConnection(socket, options, pool, capacity);
      });

      resolve({
        host: address.address,
        port: address.port,
        close: () => closeGateway(wss),
      });
    });
  });
}

function closeGateway(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close(1001, "server shutting down");
  }
  return new Promise((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function bindConnection(
  socket: WebSocket,
  options: GatewayOptions,
  pool: AdmissionPool,
  capacity: number,
): void {
  const state: ConnectionState = {
    started: false,
    cleaned: false,
    sessionId: "unknown",
    lastPcmSequence: undefined,
    nextEventSequence: 0,
    release: undefined,
    scheduler: undefined,
    runtimeSession: undefined,
  };

  let chain = Promise.resolve();

  socket.on("message", (data, isBinary) => {
    chain = chain.then(() => handleMessage(data, isBinary)).catch((error) => {
      fail(socket, state, "INTERNAL", error instanceof Error ? error.message : String(error));
    });
  });

  socket.on("close", () => {
    chain = chain.then(() => finish(state, true)).catch(() => undefined);
  });

  async function handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (state.cleaned || socket.readyState !== WebSocket.OPEN) return;

    if (isBinary) {
      await handleBinary(socket, state, data);
      return;
    }

    const text = typeof data === "string" ? data : data.toString();
    let control;
    try {
      control = validateClientControl(parseJsonMessage(text));
    } catch {
      fail(socket, state, "UNSUPPORTED", "invalid protocol");
      return;
    }

    if (!state.started) {
      if (control.type !== "session.start") {
        fail(socket, state, "UNSUPPORTED", "first message must be session.start");
        return;
      }
      await acceptSession(socket, state, options, pool, capacity, control.request);
      return;
    }

    if (control.type === "session.start") {
      fail(
        socket,
        state,
        "RESOURCE_EXHAUSTED",
        `session capacity exhausted (capacity: ${capacity})`,
      );
      return;
    }

    if (control.type === "session.stop") {
      await state.scheduler?.stop();
      await finish(state, false);
      return;
    }

    if (control.type === "session.cancel") {
      await state.scheduler?.cancel();
      await finish(state, false);
    }
  }
}

async function acceptSession(
  socket: WebSocket,
  state: ConnectionState,
  options: GatewayOptions,
  pool: AdmissionPool,
  capacity: number,
  request: SessionRequest,
): Promise<void> {
  state.sessionId = request.sessionId;
  const release = pool.reserve();
  if (!release) {
    fail(
      socket,
      state,
      "RESOURCE_EXHAUSTED",
      `session capacity exhausted (capacity: ${capacity})`,
    );
    return;
  }
  state.release = release;

  try {
    await options.runtime.ready();
    if (state.cleaned || socket.readyState !== WebSocket.OPEN) {
      await finish(state, true);
      return;
    }

    const runtimeSession = await options.runtime.open(request);
    state.runtimeSession = runtimeSession;
    const scheduler = new SessionScheduler({
      request,
      runtime: runtimeSession,
      emit(event) {
        noteSequence(state, event.sequence);
        sendJson(socket, { type: "engine.event", event });
        if (event.type === "error" && event.fatal) {
          socket.close(CLOSE_PROTOCOL, event.code);
          void finish(state, true);
        }
      },
    });
    state.scheduler = scheduler;
    state.started = true;
    sendJson(socket, {
      type: "session.accepted",
      sessionId: request.sessionId,
      model: options.runtime.modelName,
      backend: options.runtime.backend,
    });
    scheduler.start();
  } catch (error) {
    fail(socket, state, "INTERNAL", error instanceof Error ? error.message : String(error));
  }
}

async function handleBinary(socket: WebSocket, state: ConnectionState, data: RawData): Promise<void> {
  if (!state.started || !state.scheduler) {
    fail(socket, state, "INVALID_AUDIO", "binary audio is not accepted before session.start");
    return;
  }

  let frame;
  try {
    frame = decodePcmMessage(copyToArrayBuffer(data));
  } catch {
    fail(socket, state, "INVALID_AUDIO", "malformed PCM frame");
    return;
  }

  if (state.lastPcmSequence !== undefined && frame.sequence !== state.lastPcmSequence + 1) {
    warn(socket, state, "AUDIO_GAP", `audio sequence jumped from ${state.lastPcmSequence} to ${frame.sequence}`);
    socket.close(CLOSE_PROTOCOL, "AUDIO_GAP");
    await finish(state, true);
    return;
  }

  state.lastPcmSequence = frame.sequence;
  const samples = new Int16Array(frame.samples.length);
  samples.set(frame.samples);
  state.scheduler.push({ sequence: frame.sequence, startMs: frame.startMs, samples });
  sendJson(socket, {
    type: "audio.ack",
    sessionId: state.sessionId,
    throughSequence: frame.sequence,
  });
}

async function finish(state: ConnectionState, cancelIfActive: boolean): Promise<void> {
  if (state.cleaned) return;
  state.cleaned = true;
  try {
    if (cancelIfActive) await state.scheduler?.cancel();
  } finally {
    state.release?.();
    state.release = undefined;
    try {
      await state.runtimeSession?.close();
    } finally {
      state.runtimeSession = undefined;
      state.scheduler = undefined;
    }
  }
}

function fail(socket: WebSocket, state: ConnectionState, code: ErrorCode, message: string): void {
  const event: EngineEvent = {
    type: "error",
    sessionId: state.sessionId,
    sequence: state.nextEventSequence++,
    code,
    fatal: true,
    message,
  };
  sendJson(socket, { type: "engine.event", event });
  if (socket.readyState === WebSocket.OPEN) socket.close(CLOSE_PROTOCOL, code);
  void finish(state, true);
}

function warn(socket: WebSocket, state: ConnectionState, code: WarningCode, message: string): void {
  const event: EngineEvent = {
    type: "warning",
    sessionId: state.sessionId,
    sequence: state.nextEventSequence++,
    code,
    message,
  };
  sendJson(socket, { type: "engine.event", event });
}

function noteSequence(state: ConnectionState, sequence: number): void {
  state.nextEventSequence = Math.max(state.nextEventSequence, sequence + 1);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(value));
}

function copyToArrayBuffer(data: RawData): ArrayBuffer {
  if (typeof data === "string") {
    throw new TypeError("expected binary frame");
  }
  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}
