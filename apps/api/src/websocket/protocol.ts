import { validateSessionRequest } from "@voice/transcription-contracts";
import type { SessionRequest } from "@voice/transcription-contracts";

export const PCM_FRAME_BYTES = 640;

export type ProtocolCloseCode = 1008 | 1009;

export class ProtocolError extends Error {
  readonly closeCode: ProtocolCloseCode;

  constructor(message: string, closeCode: ProtocolCloseCode) {
    super(message);
    this.name = "ProtocolError";
    this.closeCode = closeCode;
  }
}

export type ClientMessage =
  | { kind: "session.start"; request: SessionRequest }
  | { kind: "session.stop" }
  | { kind: "session.cancel" }
  | { kind: "session.ping" }
  | { kind: "audio.frame"; frame: Buffer };

export interface ProtocolState {
  started: boolean;
}

export function createProtocolState(): ProtocolState {
  return { started: false };
}

function parseBinary(state: ProtocolState, data: Buffer): ClientMessage {
  if (!state.started) throw new ProtocolError("audio received before session.start", 1008);
  if (data.byteLength > PCM_FRAME_BYTES) throw new ProtocolError("frame exceeds the maximum size", 1009);
  if (data.byteLength !== PCM_FRAME_BYTES) throw new ProtocolError("frame must be exactly 640 bytes", 1008);
  return { kind: "audio.frame", frame: data };
}

function parseControl(state: ProtocolState, data: Buffer | string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
  } catch {
    throw new ProtocolError("malformed JSON control message", 1008);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("type" in parsed)) {
    throw new ProtocolError("control message missing type", 1008);
  }

  const message = parsed as Record<string, unknown>;
  const { type } = message;

  if (type === "session.start") {
    if (state.started) throw new ProtocolError("duplicate session.start", 1008);
    const extraKeys = Object.keys(message).filter((key) => key !== "type" && key !== "request");
    if (extraKeys.length > 0) throw new ProtocolError("unsupported session.start metadata", 1008);

    let request: SessionRequest;
    try {
      request = validateSessionRequest(message.request);
    } catch {
      throw new ProtocolError("invalid session.start request", 1008);
    }
    state.started = true;
    return { kind: "session.start", request };
  }

  if (!state.started) throw new ProtocolError("control message before session.start", 1008);

  if (type === "session.stop") return { kind: "session.stop" };
  if (type === "session.cancel") return { kind: "session.cancel" };
  if (type === "session.ping") return { kind: "session.ping" };

  throw new ProtocolError("unsupported message type", 1008);
}

/** Returns a validated domain message; never returns raw client payloads. Throws ProtocolError with the safe close code to use. */
export function parseClientMessage(state: ProtocolState, data: Buffer | string, isBinary: boolean): ClientMessage {
  if (isBinary) return parseBinary(state, typeof data === "string" ? Buffer.from(data) : data);
  return parseControl(state, data);
}
