import { validateSessionRequest } from "@voice/transcription-contracts";
const ENGINE_STATES = ["preparing", "ready", "listening", "draining", "stopped"];
const WARNING_CODES = ["AUDIO_GAP", "DEGRADED_PERFORMANCE", "LANGUAGE_UNCERTAIN"];
const ERROR_CODES = [
    "UNAVAILABLE",
    "UNSUPPORTED",
    "INVALID_AUDIO",
    "RESOURCE_EXHAUSTED",
    "TIMEOUT",
    "INTERNAL",
];
export function validateClientControl(value) {
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
export function validateServerMessage(value) {
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
export function parseJsonMessage(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new TypeError("message must be valid JSON");
    }
}
function validateEngineEvent(value) {
    const event = asRecord(value, "engine event");
    nonemptyString(event.sessionId, "sessionId");
    nonnegativeNumber(event.sequence, "sequence");
    switch (event.type) {
        case "state":
            if (!isEngineState(event.state)) {
                throw new TypeError("state must be a valid engine state");
            }
            return event;
        case "segment.upsert":
            validateTranscriptSegment(event.segment);
            return event;
        case "segment.remove":
            stringValue(event.segmentId, "segmentId");
            return event;
        case "warning":
            if (!isWarningCode(event.code)) {
                throw new TypeError("warning code must be valid");
            }
            stringValue(event.message, "message");
            return event;
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
            return event;
        }
        default:
            throw new TypeError("unknown engine event type");
    }
}
function validateTranscriptSegment(value) {
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
    return segment;
}
function assertExactKeys(value, expectedKeys, label) {
    const actualKeys = Object.keys(value).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    if (actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
        throw new TypeError(`${label} has unknown or missing top-level keys`);
    }
}
function asRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function nonemptyString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${label} must be a nonempty string`);
    }
    return value;
}
function stringValue(value, label) {
    if (typeof value !== "string") {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}
function booleanValue(value, label) {
    if (typeof value !== "boolean") {
        throw new TypeError(`${label} must be a boolean`);
    }
    return value;
}
function nonnegativeInteger(value, label) {
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 0) {
        throw new RangeError(`${label} must be a finite nonnegative integer`);
    }
    return value;
}
function nonnegativeNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RangeError(`${label} must be finite and nonnegative`);
    }
    return value;
}
function languageTag(value, label) {
    if (value !== "und" && (typeof value !== "string" || value.length === 0)) {
        throw new TypeError(`${label} must be a language tag or und`);
    }
    return value;
}
function confidence(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`${label} must be between 0 and 1`);
    }
    return value;
}
function isEngineState(value) {
    return typeof value === "string" && ENGINE_STATES.includes(value);
}
function isWarningCode(value) {
    return typeof value === "string" && WARNING_CODES.includes(value);
}
function isErrorCode(value) {
    return typeof value === "string" && ERROR_CODES.includes(value);
}
