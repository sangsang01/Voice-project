import { validateSessionRequest } from "@voice/transcription-contracts";
import type {
  EngineEvent,
  EngineState,
  ErrorCode,
  TranscriptSegment,
  WarningCode,
} from "@voice/transcription-contracts";
import type { ClientControl, ServerMessage } from "./messages.js";

const ENGINE_STATES = ["preparing", "ready", "listening", "draining", "stopped"] as const;
const WARNING_CODES = ["AUDIO_GAP", "DEGRADED_PERFORMANCE", "LANGUAGE_UNCERTAIN"] as const;
const ERROR_CODES = [
  "UNAVAILABLE",
  "UNSUPPORTED",
  "INVALID_AUDIO",
  "RESOURCE_EXHAUSTED",
  "TIMEOUT",
  "INTERNAL",
] as const;

export function validateClientControl(value: unknown): ClientControl {
  const message = asRecord(value, "client control");
  const type = message.type;

  switch (type) {
    case "session.start":
      assertExactKeys(message, ["protocol", "request", "type"], "client control");
      if (message.protocol !== 1) {
        throw new TypeError("protocol must be 1");
      }
      return { type, protocol: 1, request: validateSessionRequest(message.request) };

    case "session.stop":
    case "session.cancel":
      assertExactKeys(message, ["sessionId", "type"], "client control");
      return { type, sessionId: nonemptyString(message.sessionId, "sessionId") };

    default:
      throw new TypeError("unknown client control type");
  }
}

export function validateServerMessage(value: unknown): ServerMessage {
  const message = asRecord(value, "server message");
  const type = message.type;

  switch (type) {
    case "session.accepted":
      assertExactKeys(message, ["model", "sessionId", "type"], "server message");
      return {
        type,
        sessionId: nonemptyString(message.sessionId, "sessionId"),
        model: nonemptyString(message.model, "model"),
      };

    case "audio.ack":
      assertExactKeys(message, ["sessionId", "throughSequence", "type"], "server message");
      return {
        type,
        sessionId: nonemptyString(message.sessionId, "sessionId"),
        throughSequence: nonnegativeInteger(message.throughSequence, "throughSequence"),
      };

    case "engine.event":
      assertExactKeys(message, ["event", "type"], "server message");
      return { type, event: validateEngineEvent(message.event) };

    default:
      throw new TypeError("unknown server message type");
  }
}

export function parseJsonMessage(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("message must be valid JSON");
  }
}

function validateEngineEvent(value: unknown): EngineEvent {
  const event = asRecord(value, "engine event");
  nonemptyString(event.sessionId, "sessionId");
  nonnegativeNumber(event.sequence, "sequence");

  switch (event.type) {
    case "state":
      if (!isEngineState(event.state)) {
        throw new TypeError("state must be a valid engine state");
      }
      return event as unknown as EngineEvent;

    case "segment.upsert":
      validateTranscriptSegment(event.segment);
      return event as unknown as EngineEvent;

    case "segment.remove":
      stringValue(event.segmentId, "segmentId");
      return event as unknown as EngineEvent;

    case "warning":
      if (!isWarningCode(event.code)) {
        throw new TypeError("warning code must be valid");
      }
      stringValue(event.message, "message");
      return event as unknown as EngineEvent;

    case "error": {
      if (!isErrorCode(event.code)) {
        throw new TypeError("error code must be valid");
      }
      if (typeof event.fatal !== "boolean") {
        throw new TypeError("fatal must be a boolean");
      }
      stringValue(event.message, "message");
      if (event.providerCode !== undefined) {
        stringValue(event.providerCode, "providerCode");
      }
      return event as unknown as EngineEvent;
    }

    default:
      throw new TypeError("unknown engine event type");
  }
}

function validateTranscriptSegment(value: unknown): TranscriptSegment {
  const segment = asRecord(value, "segment");
  const language = asRecord(segment.language, "language");
  stringValue(segment.id, "segment.id");
  nonnegativeInteger(segment.ordinal, "segment.ordinal");
  nonnegativeInteger(segment.revision, "segment.revision");
  nonnegativeNumber(segment.startMs, "segment.startMs");
  nonnegativeNumber(segment.endMs, "segment.endMs");
  stringValue(segment.text, "segment.text");
  languageTag(language.tag, "segment.language.tag");
  booleanValue(segment.isFinal, "segment.isFinal");

  if (language.confidence !== undefined) {
    confidence(language.confidence, "segment.language.confidence");
  }

  return segment as unknown as TranscriptSegment;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new TypeError(`${label} has unknown or missing top-level keys`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a finite nonnegative integer`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and nonnegative`);
  }
  return value;
}

function languageTag(value: unknown, label: string): string {
  if (value !== "und" && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`${label} must be a language tag or und`);
  }
  return value;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be between 0 and 1`);
  }
  return value;
}

function isEngineState(value: unknown): value is EngineState {
  return typeof value === "string" && ENGINE_STATES.includes(value as EngineState);
}

function isWarningCode(value: unknown): value is WarningCode {
  return typeof value === "string" && WARNING_CODES.includes(value as WarningCode);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.includes(value as ErrorCode);
}
