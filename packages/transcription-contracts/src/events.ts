import type { TranscriptSegment } from "./types";

export type EngineState = "preparing" | "ready" | "listening" | "draining" | "stopped";

export type EngineWarningCode = "AUDIO_GAP" | "DEGRADED_PERFORMANCE" | "LANGUAGE_UNCERTAIN";

export type EngineErrorCode =
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "INVALID_AUDIO"
  | "RESOURCE_EXHAUSTED"
  | "TIMEOUT"
  | "INTERNAL";

export type EngineEvent =
  | { type: "state"; sessionId: string; sequence: number; state: EngineState }
  | { type: "segment.upsert"; sessionId: string; sequence: number; segment: TranscriptSegment }
  | { type: "segment.remove"; sessionId: string; sequence: number; segmentId: string }
  | { type: "warning"; sessionId: string; sequence: number; code: EngineWarningCode; message: string }
  | {
      type: "error";
      sessionId: string;
      sequence: number;
      code: EngineErrorCode;
      fatal: boolean;
      message: string;
      providerCode?: string;
    };
