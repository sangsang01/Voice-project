import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../events.js";
import type { PushResult, TranscriptionEngine, TranscriptionSession } from "../engine.js";
import type { PcmFrame, SessionRequest } from "../types.js";

export interface EngineContractFixture {
  request: SessionRequest;
  frame: PcmFrame;
  /** Frames to push before stop(). Engines that segment on voice activity
   *  need enough audio to form an utterance; one frame is not enough. */
  framesBeforeStop?: number;
}

const terminalPushResult: PushResult = { accepted: false, reason: "backpressure" };

function nextTaskTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function drainAsyncDelivery(): Promise<void> {
  await nextTaskTurn();
  await nextTaskTurn();
}

async function openPreparedSession(
  createEngine: () => TranscriptionEngine,
  request: SessionRequest,
) {
  const engine = createEngine();
  await engine.prepare(request);
  const session = await engine.open(request);

  return { engine, session };
}

export function describeEngineContract(
  name: string,
  createEngine: () => TranscriptionEngine,
  fixture: EngineContractFixture,
) {
  describe(`${name} transcription engine contract`, () => {
    it("follows prepare, open, listening, stop, and stopped lifecycle", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      session.subscribe((event) => events.push(event));

      const frameCount = fixture.framesBeforeStop ?? 1;
      for (let index = 0; index < frameCount; index += 1) {
        const frame: PcmFrame = { ...fixture.frame, sequence: index, startMs: index * 20 };
        expect(session.push(frame)).toEqual({ accepted: true });
      }
      await session.stop();

      const listeningIndex = events.findIndex(
        (event) => event.type === "state" && event.state === "listening",
      );
      const drainingIndex = events.findIndex(
        (event) => event.type === "state" && event.state === "draining",
      );
      const finalSegmentIndex = events.findIndex(
        (event) => event.type === "segment.upsert" && event.segment.isFinal,
      );
      const stoppedIndex = events.findIndex(
        (event) => event.type === "state" && event.state === "stopped",
      );

      expect(listeningIndex).toBeGreaterThanOrEqual(0);
      expect(drainingIndex).toBeGreaterThan(listeningIndex);
      expect(finalSegmentIndex).toBeGreaterThan(drainingIndex);
      expect(stoppedIndex).toBeGreaterThan(finalSegmentIndex);
      await engine.dispose();
    });

    it("emits monotonically increasing event sequences", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      session.subscribe((event) => events.push(event));

      session.push(fixture.frame);
      await session.stop();

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
      await engine.dispose();
    });

    it("accepts a valid 320-sample PCM frame", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      session.subscribe((event) => events.push(event));

      expect(fixture.frame.samples).toHaveLength(320);
      expect(session.push(fixture.frame)).toEqual({ accepted: true });

      await session.cancel();
      await engine.dispose();
    });

    it("does not invoke a listener after it unsubscribes", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      const unsubscribe = session.subscribe((event) => events.push(event));
      const eventCountAtUnsubscribe = events.length;

      unsubscribe();
      expect(session.push(fixture.frame)).toEqual({ accepted: true });
      await drainAsyncDelivery();
      expect(events).toHaveLength(eventCountAtUnsubscribe);

      await session.cancel();
      await drainAsyncDelivery();
      expect(events).toHaveLength(eventCountAtUnsubscribe);
      await engine.dispose();
    });

    it("rejects terminal pushes consistently and emits nothing after stop resolves", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      session.subscribe((event) => events.push(event));

      await session.stop();
      const eventCountAfterStop = events.length;
      const firstResult = session.push(fixture.frame);
      const secondResult = session.push(fixture.frame);

      expect(firstResult).toEqual(terminalPushResult);
      expect(secondResult).toEqual(terminalPushResult);
      await drainAsyncDelivery();
      expect(events).toHaveLength(eventCountAfterStop);

      await session.stop();
      await session.cancel();
      expect(events).toHaveLength(eventCountAfterStop);
      await engine.dispose();
    });

    it("cancels immediately, emits only stopped for the cancellation, and remains terminal", async () => {
      const { engine, session } = await openPreparedSession(createEngine, fixture.request);
      const events: EngineEvent[] = [];
      session.subscribe((event) => events.push(event));
      const eventCountBeforeCancel = events.length;

      await session.cancel();

      expect(events.slice(eventCountBeforeCancel)).toEqual([
        expect.objectContaining({ type: "state", state: "stopped" }),
      ]);
      expect(session.push(fixture.frame)).toEqual(terminalPushResult);

      const eventCountAfterCancel = events.length;
      await session.cancel();
      await session.stop();
      expect(events).toHaveLength(eventCountAfterCancel);
      await engine.dispose();
    });
  });
}
