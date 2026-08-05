import type { ErrorCode, EngineEvent } from "@voice/transcription-contracts";
import type { GoogleDuration, GoogleProviderError, GoogleStreamingRecognitionResult } from "./providerTypes";

export interface NormalizeResultContext {
  sessionId: string;
  sequence: number;
  ordinal: number;
  revision: number;
  startMs: number;
  selectedLanguages: readonly string[];
}

export interface NormalizeErrorContext {
  sessionId: string;
  sequence: number;
}

function durationToMs(duration: GoogleDuration | undefined): number | undefined {
  if (!duration) return undefined;
  const seconds = duration.seconds ?? 0;
  const nanos = duration.nanos ?? 0;
  return Math.round(seconds * 1000 + nanos / 1_000_000);
}

/**
 * Google's V1 streamingRecognize response only carries an end time per
 * result (resultEndTime); it never reports where the utterance started, so
 * the caller (GoogleStream) tracks and supplies startMs from audio frame
 * timing via the context.
 */
export function normalizeGoogleResult(
  result: GoogleStreamingRecognitionResult,
  context: NormalizeResultContext,
): EngineEvent | null {
  const alternative = result.alternatives[0];
  const text = alternative?.transcript.trim() ?? "";
  if (!text) return null;

  const endMs = durationToMs(result.resultEndTime) ?? context.startMs;
  const tag =
    result.languageCode && context.selectedLanguages.includes(result.languageCode) ? result.languageCode : "und";
  const language = alternative?.confidence === undefined ? { tag } : { tag, confidence: alternative.confidence };

  return {
    type: "segment.upsert",
    sessionId: context.sessionId,
    sequence: context.sequence,
    segment: {
      id: `google-${context.ordinal}`,
      ordinal: context.ordinal,
      revision: context.revision,
      startMs: context.startMs,
      endMs,
      text,
      language,
      isFinal: result.isFinal === true,
    },
  };
}

const GRPC_CODE_TO_ENGINE_ERROR: Record<number, ErrorCode> = {
  3: "INVALID_AUDIO", // INVALID_ARGUMENT
  4: "TIMEOUT", // DEADLINE_EXCEEDED
  8: "RESOURCE_EXHAUSTED", // RESOURCE_EXHAUSTED
  14: "UNAVAILABLE", // UNAVAILABLE
  16: "UNAVAILABLE", // UNAUTHENTICATED (never surface auth detail to the browser)
};

export function normalizeGoogleError(error: GoogleProviderError, context: NormalizeErrorContext): EngineEvent {
  return {
    type: "error",
    sessionId: context.sessionId,
    sequence: context.sequence,
    code: GRPC_CODE_TO_ENGINE_ERROR[error.code] ?? "INTERNAL",
    fatal: true,
    message: "Cloud transcription provider error",
    providerCode: String(error.code),
  };
}
