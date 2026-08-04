import type { SessionRequest } from "./types";

export function validateSessionRequest(value: unknown): SessionRequest {
  if (!value || typeof value !== "object") throw new TypeError("request must be an object");
  const request = value as SessionRequest;
  const languages = [...request.candidateLanguages];
  if (languages.length < 1 || languages.length > 4) throw new RangeError("select 1-4 languages");
  if (new Set(languages).size !== languages.length) throw new TypeError("languages must be unique");
  if (languages.some((tag) => !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/.test(tag))) {
    throw new TypeError("languages must be BCP-47 tags");
  }
  if (request.mode !== "transcribe") throw new TypeError("mode must be transcribe");
  if (
    request.audio.encoding !== "pcm_s16le" ||
    request.audio.sampleRateHz !== 16000 ||
    request.audio.channels !== 1 ||
    request.audio.frameDurationMs !== 20
  ) {
    throw new TypeError("audio must be 16-kHz mono PCM with 20-ms frames");
  }
  return request;
}
