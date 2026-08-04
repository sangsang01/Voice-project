import type { EngineEvent, TranscriptSegment } from "@voice/transcription-contracts";
import { describe, expect, it } from "vitest";
import { createSessionState, sessionReducer } from "./sessionReducer";

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "s1",
    ordinal: 1,
    revision: 1,
    startMs: 0,
    endMs: 500,
    text: "Xin chào",
    language: { tag: "vi-VN", confidence: 0.98 },
    isFinal: false,
    ...overrides,
  };
}

function segmentEvent(
  sessionId: string,
  sequence: number,
  segmentOverrides: Partial<TranscriptSegment> = {},
): EngineEvent {
  return { type: "segment.upsert", sessionId, sequence, segment: segment(segmentOverrides) };
}

describe("sessionReducer", () => {
  it("updates a provisional segment and replaces it with its final revision", () => {
    const initial = createSessionState("session-new");
    const provisional = segmentEvent("session-new", 1, {
      id: "s1",
      revision: 1,
      isFinal: false,
      text: "Xin",
    });
    const revised = segmentEvent("session-new", 2, {
      id: "s1",
      revision: 2,
      isFinal: true,
      text: "Xin chào",
    });

    expect(sessionReducer(initial, provisional).segments[0]?.text).toBe("Xin");
    expect(sessionReducer(sessionReducer(initial, provisional), revised).segments[0]?.text).toBe(
      "Xin chào",
    );
  });

  it("ignores old sessions and changes after finalization", () => {
    const initial = createSessionState("session-new");
    const finalized = sessionReducer(
      initial,
      segmentEvent("session-new", 2, { id: "s1", revision: 2, isFinal: true, text: "Xin chào" }),
    );

    expect(sessionReducer(initial, segmentEvent("old", 99, { id: "bad" }))).toEqual(initial);
    expect(sessionReducer(finalized, segmentEvent("session-new", 3, { text: "Xin" })).segments[0]?.text).toBe(
      "Xin chào",
    );
    expect(
      sessionReducer(finalized, { type: "segment.remove", sessionId: "session-new", sequence: 3, segmentId: "s1" })
        .segments,
    ).toHaveLength(1);
  });

  it("clears segments into a new session", () => {
    const initial = sessionReducer(createSessionState("session-new"), segmentEvent("session-new", 1));

    const cleared = sessionReducer(initial, { type: "clear", nextSessionId: "session-2" });

    expect(cleared.sessionId).toBe("session-2");
    expect(cleared.segments).toEqual([]);
  });

  it("keeps transcript segments in chronological ordinal order", () => {
    const initial = createSessionState("session-new");
    const afterSecond = sessionReducer(
      initial,
      segmentEvent("session-new", 1, { id: "s2", ordinal: 2, startMs: 500, endMs: 900 }),
    );
    const ordered = sessionReducer(
      afterSecond,
      segmentEvent("session-new", 2, { id: "s1", ordinal: 1, startMs: 0, endMs: 400 }),
    );

    expect(ordered.segments.map(({ id }) => id)).toEqual(["s1", "s2"]);
  });

  it("ignores non-increasing sequences and lower revisions", () => {
    const initial = sessionReducer(createSessionState("session-new"), segmentEvent("session-new", 2, { revision: 2 }));

    const staleSequence = sessionReducer(initial, segmentEvent("session-new", 2, { revision: 3, text: "stale" }));
    const lowerRevision = sessionReducer(initial, segmentEvent("session-new", 3, { revision: 1, text: "older" }));

    expect(staleSequence.segments[0]?.text).toBe("Xin chào");
    expect(lowerRevision.segments[0]?.text).toBe("Xin chào");
    expect(lowerRevision.lastEventSequence).toBe(3);
  });

  it("records state, warnings, fatal errors, and removes provisional segments", () => {
    const initial = createSessionState("session-new");
    const listening = sessionReducer(initial, {
      type: "state",
      sessionId: "session-new",
      sequence: 1,
      state: "listening",
    });
    const warned = sessionReducer(listening, {
      type: "warning",
      sessionId: "session-new",
      sequence: 2,
      code: "LANGUAGE_UNCERTAIN",
      message: "Language could not be determined",
    });
    const withSegment = sessionReducer(warned, segmentEvent("session-new", 3));
    const removed = sessionReducer(withSegment, {
      type: "segment.remove",
      sessionId: "session-new",
      sequence: 4,
      segmentId: "s1",
    });
    const failed = sessionReducer(removed, {
      type: "error",
      sessionId: "session-new",
      sequence: 5,
      code: "UNAVAILABLE",
      fatal: true,
      message: "Microphone unavailable",
      providerCode: "NotFoundError",
    });

    expect(listening.engineState).toBe("listening");
    expect(warned.warnings).toEqual([
      { code: "LANGUAGE_UNCERTAIN", message: "Language could not be determined" },
    ]);
    expect(removed.segments).toEqual([]);
    expect(failed.fatalError).toEqual({
      code: "UNAVAILABLE",
      message: "Microphone unavailable",
      providerCode: "NotFoundError",
    });
  });
});
