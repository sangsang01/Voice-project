import type { PcmFrame, SessionRequest } from "./types.js";

const BCP_47_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/;

export function validateSessionRequest(value: unknown): SessionRequest {
  if (!value || typeof value !== "object") {
    throw new TypeError("request must be an object");
  }

  const request = value as SessionRequest;

  if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
    throw new TypeError("sessionId must be a nonempty string");
  }

  if (
    !Array.isArray(request.candidateLanguages) ||
    request.candidateLanguages.some((language) => typeof language !== "string")
  ) {
    throw new TypeError("candidateLanguages must be an array of strings");
  }

  const languages = [...request.candidateLanguages];

  if (languages.length < 1 || languages.length > 4) {
    throw new RangeError("select 1-4 languages");
  }

  if (new Set(languages).size !== languages.length) {
    throw new TypeError("languages must be unique");
  }

  if (languages.some((tag) => !BCP_47_TAG.test(tag))) {
    throw new TypeError("languages must be BCP-47 tags");
  }

  if (request.mode !== "transcribe") {
    throw new TypeError("mode must be transcribe");
  }

  const audio = request.audio as unknown as Record<string, unknown>;
  if (
    !audio ||
    typeof audio !== "object" ||
    Array.isArray(audio) ||
    typeof audio.encoding !== "string" ||
    typeof audio.sampleRateHz !== "number" ||
    typeof audio.channels !== "number" ||
    typeof audio.frameDurationMs !== "number"
  ) {
    throw new TypeError("audio must be an object with valid properties");
  }

  if (
    audio.encoding !== "pcm_s16le" ||
    audio.sampleRateHz !== 16000 ||
    audio.channels !== 1 ||
    audio.frameDurationMs !== 20
  ) {
    throw new TypeError("audio must be 16-kHz mono PCM with 20-ms frames");
  }

  return request;
}

export function validatePcmFrame(value: unknown): PcmFrame {
  if (!value || typeof value !== "object") {
    throw new TypeError("frame must be an object");
  }

  const frame = value as PcmFrame;
  if (
    typeof frame.sequence !== "number" ||
    !Number.isFinite(frame.sequence) ||
    !Number.isInteger(frame.sequence) ||
    frame.sequence < 0
  ) {
    throw new RangeError("frame sequence must be a finite nonnegative integer");
  }

  if (
    typeof frame.startMs !== "number" ||
    !Number.isFinite(frame.startMs) ||
    frame.startMs < 0
  ) {
    throw new RangeError("frame startMs must be finite and nonnegative");
  }

  if (!(frame.samples instanceof Int16Array) || frame.samples.length !== 320) {
    throw new TypeError("frame must contain exactly 320 Int16 samples");
  }

  return frame;
}
