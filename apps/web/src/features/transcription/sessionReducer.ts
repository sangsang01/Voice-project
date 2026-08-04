import type {
  EngineEvent,
  EngineState,
  ErrorCode,
  TranscriptSegment,
  WarningCode,
} from "@voice/transcription-contracts";

export interface SessionWarning {
  code: WarningCode;
  message: string;
}

export interface FatalSessionError {
  code: ErrorCode;
  message: string;
  providerCode?: string;
}

export interface SessionState {
  sessionId: string;
  lastEventSequence: number;
  engineState: EngineState;
  segmentsById: Readonly<Record<string, TranscriptSegment>>;
  orderedSegmentIds: readonly string[];
  segments: readonly TranscriptSegment[];
  warnings: readonly SessionWarning[];
  fatalError?: FatalSessionError;
}

export type SessionAction = EngineEvent | { type: "clear"; nextSessionId: string };

export function createSessionState(sessionId: string): SessionState {
  return makeState({
    sessionId,
    lastEventSequence: 0,
    engineState: "stopped",
    segmentsById: {},
    orderedSegmentIds: [],
    warnings: [],
  });
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === "clear") {
    return createSessionState(action.nextSessionId);
  }

  if (action.sessionId !== state.sessionId || action.sequence <= state.lastEventSequence) {
    return state;
  }

  const next = { ...state, lastEventSequence: action.sequence };

  switch (action.type) {
    case "state":
      return makeState({ ...next, engineState: action.state });

    case "warning":
      return makeState({
        ...next,
        warnings: [...state.warnings, { code: action.code, message: action.message }],
      });

    case "error":
      return makeState({
        ...next,
        fatalError: action.fatal
          ? { code: action.code, message: action.message, providerCode: action.providerCode }
          : state.fatalError,
      });

    case "segment.remove": {
      const existing = state.segmentsById[action.segmentId];
      if (!existing || existing.isFinal) {
        return makeState(next);
      }

      const segmentsById = { ...state.segmentsById };
      delete segmentsById[action.segmentId];
      return makeState({ ...next, segmentsById });
    }

    case "segment.upsert": {
      const existing = state.segmentsById[action.segment.id];
      if (existing?.isFinal || (existing && action.segment.revision < existing.revision)) {
        return makeState(next);
      }

      return makeState({
        ...next,
        segmentsById: { ...state.segmentsById, [action.segment.id]: action.segment },
      });
    }
  }
}

function makeState(
  state: Omit<SessionState, "orderedSegmentIds" | "segments"> &
    Partial<Pick<SessionState, "orderedSegmentIds" | "segments">>,
): SessionState {
  const orderedSegmentIds = Object.values(state.segmentsById)
    .sort((left, right) => left.ordinal - right.ordinal || left.startMs - right.startMs || left.id.localeCompare(right.id))
    .map(({ id }) => id);

  return {
    ...state,
    orderedSegmentIds,
    segments: orderedSegmentIds.map((id) => state.segmentsById[id]),
  };
}
