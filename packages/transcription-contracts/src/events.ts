import type { TranscriptSegment } from "./types.js";

export type EngineState = "preparing" | "ready" | "listening" | "draining" | "stopped";

export type WarningCode =
  | "AUDIO_GAP"
  | "DEGRADED_PERFORMANCE"
  | "LANGUAGE_UNCERTAIN";

export type ErrorCode =
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "INVALID_AUDIO"
  | "RESOURCE_EXHAUSTED"
  | "TIMEOUT"
  | "INTERNAL";

export type EngineEvent =
  | {
      type: "state";
      sessionId: string;
      sequence: number;
      state: EngineState;
    }
  | {
      type: "segment.upsert";
      sessionId: string;
      sequence: number;
      segment: TranscriptSegment;
    }
  | {
      type: "segment.remove";
      sessionId: string;
      sequence: number;
      segmentId: string;
    }
  | {
      type: "warning";
      sessionId: string;
      sequence: number;
      code: WarningCode;
      message: string;
    }
  | {
      type: "error";
      sessionId: string;
      sequence: number;
      code: ErrorCode;
      fatal: boolean;
      message: string;
      providerCode?: string;
    };
