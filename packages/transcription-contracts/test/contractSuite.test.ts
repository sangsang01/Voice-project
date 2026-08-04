import {
  describeEngineContract,
  FakeTranscriptionEngine,
  makePcmFrame,
  makeSessionRequest,
} from "../src/testing";
import type { EngineEventListener, SessionRequest, TranscriptionSession } from "../src";

class ProvisionalEventEngine extends FakeTranscriptionEngine {
  public override async open(request: SessionRequest): Promise<TranscriptionSession> {
    const session = await super.open(request);

    return {
      push: (frame) => session.push(frame),
      stop: () => session.stop(),
      cancel: () => session.cancel(),
      subscribe(listener: EngineEventListener) {
        return session.subscribe((event) => {
          listener(event);
          if (event.type === "state" && event.state === "draining") {
            listener({
              type: "segment.upsert",
              sessionId: event.sessionId,
              sequence: event.sequence + 0.1,
              segment: {
                id: `${event.sessionId}:provisional`,
                ordinal: 0,
                revision: 1,
                startMs: 0,
                endMs: 20,
                text: "partial",
                language: { tag: "en-US", confidence: 0.9 },
                isFinal: false,
              },
            });
            listener({
              type: "warning",
              sessionId: event.sessionId,
              sequence: event.sequence + 0.2,
              code: "LANGUAGE_UNCERTAIN",
              message: "provisional language",
            });
          }
        });
      },
    };
  }
}

describeEngineContract("fake", () => new FakeTranscriptionEngine(), {
  request: makeSessionRequest(["en-US", "vi-VN"]),
  frame: makePcmFrame(0),
});

describeEngineContract("provisional events", () => new ProvisionalEventEngine(), {
  request: makeSessionRequest(["en-US", "vi-VN"]),
  frame: makePcmFrame(0),
});
