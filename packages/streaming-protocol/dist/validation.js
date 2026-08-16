import { validateSessionRequest } from "@voice/transcription-contracts";
const NATIVE_BACKENDS = new Set(["cpu", "cuda", "vulkan", "metal"]);
const ENGINE_STATES = new Set(["preparing", "ready", "listening", "draining", "stopped"]);
const WARNING_CODES = new Set(["AUDIO_GAP", "DEGRADED_PERFORMANCE", "LANGUAGE_UNCERTAIN"]);
const ERROR_CODES = new Set([
    "UNAVAILABLE",
    "UNSUPPORTED",
    "INVALID_AUDIO",
    "RESOURCE_EXHAUSTED",
    "TIMEOUT",
    "INTERNAL",
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNonemptyString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${field} must be a nonempty string`);
    }
    return value;
}
function requireFiniteNonnegativeInteger(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new TypeError(`${field} must be a finite nonnegative integer`);
    }
    return value;
}
function requireFiniteNumber(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${field} must be a finite number`);
    }
    return value;
}
function requireBoolean(value, field) {
    if (typeof value !== "boolean") {
        throw new TypeError(`${field} must be a boolean`);
    }
    return value;
}
function requireString(value, field) {
    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }
    return value;
}
function validateTranscriptSegment(value) {
    if (!isRecord(value)) {
        throw new TypeError("segment must be an object");
    }
    const languageValue = value.language;
    if (!isRecord(languageValue)) {
        throw new TypeError("segment language must be an object");
    }
    const language = {
        tag: requireNonemptyString(languageValue.tag, "language.tag"),
    };
    if (languageValue.confidence !== undefined) {
        language.confidence = requireFiniteNumber(languageValue.confidence, "language.confidence");
    }
    return {
        id: requireNonemptyString(value.id, "segment.id"),
        ordinal: requireFiniteNonnegativeInteger(value.ordinal, "segment.ordinal"),
        revision: requireFiniteNonnegativeInteger(value.revision, "segment.revision"),
        startMs: requireFiniteNumber(value.startMs, "segment.startMs"),
        endMs: requireFiniteNumber(value.endMs, "segment.endMs"),
        text: requireString(value.text, "segment.text"),
        language,
        isFinal: requireBoolean(value.isFinal, "segment.isFinal"),
    };
}
function validateEngineEvent(value) {
    if (!isRecord(value)) {
        throw new TypeError("engine event must be an object");
    }
    const sessionId = requireNonemptyString(value.sessionId, "sessionId");
    const sequence = requireFiniteNonnegativeInteger(value.sequence, "sequence");
    switch (value.type) {
        case "state":
            if (typeof value.state !== "string" || !ENGINE_STATES.has(value.state)) {
                throw new TypeError("engine state is invalid");
            }
            return { type: "state", sessionId, sequence, state: value.state };
        case "segment.upsert":
            return {
                type: "segment.upsert",
                sessionId,
                sequence,
                segment: validateTranscriptSegment(value.segment),
            };
        case "segment.remove":
            return {
                type: "segment.remove",
                sessionId,
                sequence,
                segmentId: requireNonemptyString(value.segmentId, "segmentId"),
            };
        case "warning":
            if (typeof value.code !== "string" || !WARNING_CODES.has(value.code)) {
                throw new TypeError("warning code is invalid");
            }
            return {
                type: "warning",
                sessionId,
                sequence,
                code: value.code,
                message: requireString(value.message, "message"),
            };
        case "error": {
            if (typeof value.code !== "string" || !ERROR_CODES.has(value.code)) {
                throw new TypeError("error code is invalid");
            }
            const event = {
                type: "error",
                sessionId,
                sequence,
                code: value.code,
                fatal: requireBoolean(value.fatal, "fatal"),
                message: requireString(value.message, "message"),
            };
            if (value.providerCode !== undefined) {
                event.providerCode = requireString(value.providerCode, "providerCode");
            }
            return event;
        }
        default:
            throw new TypeError("unknown engine event type");
    }
}
export function parseJsonMessage(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new TypeError("message must be valid JSON");
    }
}
export function validateClientControl(value) {
    if (!isRecord(value)) {
        throw new TypeError("client control must be an object");
    }
    switch (value.type) {
        case "session.start":
            if (value.protocol !== 1) {
                throw new TypeError("protocol must be 1");
            }
            return {
                type: "session.start",
                protocol: 1,
                request: validateSessionRequest(value.request),
            };
        case "session.stop":
            return {
                type: "session.stop",
                sessionId: requireNonemptyString(value.sessionId, "sessionId"),
            };
        case "session.cancel":
            return {
                type: "session.cancel",
                sessionId: requireNonemptyString(value.sessionId, "sessionId"),
            };
        default:
            throw new TypeError("unknown client control type");
    }
}
export function validateServerMessage(value) {
    if (!isRecord(value)) {
        throw new TypeError("server message must be an object");
    }
    switch (value.type) {
        case "session.accepted": {
            const backend = value.backend;
            if (typeof backend !== "string" || !NATIVE_BACKENDS.has(backend)) {
                throw new TypeError("backend must be cpu, cuda, vulkan, or metal");
            }
            return {
                type: "session.accepted",
                sessionId: requireNonemptyString(value.sessionId, "sessionId"),
                model: requireNonemptyString(value.model, "model"),
                backend: backend,
            };
        }
        case "audio.ack":
            return {
                type: "audio.ack",
                sessionId: requireNonemptyString(value.sessionId, "sessionId"),
                throughSequence: requireFiniteNonnegativeInteger(value.throughSequence, "throughSequence"),
            };
        case "engine.event":
            return {
                type: "engine.event",
                event: validateEngineEvent(value.event),
            };
        default:
            throw new TypeError("unknown server message type");
    }
}
