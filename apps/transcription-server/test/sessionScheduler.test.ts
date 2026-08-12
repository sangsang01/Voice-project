import { makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { EngineEvent, PcmFrame } from "@voice/transcription-contracts";
import { describe, expect, it } from "vitest";

import { SessionScheduler } from "../src/sessionScheduler.js";
import type { DecodeResult, StreamingRuntimeSession, VadUpdate } from "../src/runtime.js";

interface DecodeCall {
  kind: "provisional" | "final";
  resolve(result: DecodeResult): void;
  reject(error: unknown): void;
}

function createManualClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers: Array<{ id: number; time: number; callback: () => void }> = [];
  return {
    now: () => currentTime,
    setTimer: function setTimer(callback: () => void, delay?: number) {
      const id = nextId++;
      timers.push({ id, time: currentTime + (delay ?? 0), callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    } as unknown as typeof setTimeout,
    clearTimer: ((id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    }) as typeof clearTimeout,
    advance(ms: number): void {
      currentTime += ms;
      let firedAny = true;
      while (firedAny) {
        firedAny = false;
        const due = timers.filter((timer) => timer.time <= currentTime).sort((a, b) => a.time - b.time);
        for (const timer of due) {
          const index = timers.indexOf(timer);
          if (index === -1) continue;
          timers.splice(index, 1);
          timer.callback();
          firedAny = true;
        }
      }
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeRuntime() {
  const vadUpdates: VadUpdate[] = [];
  const decodeCalls: DecodeCall[] = [];
  const decodeKinds: Array<"provisional" | "final"> = [];
  const runtime: StreamingRuntimeSession = {
    push(_frame: PcmFrame): VadUpdate {
      return vadUpdates.shift() ?? { speechStarted: false, speechEnded: false };
    },
    decode(kind) {
      decodeKinds.push(kind);
      return new Promise<DecodeResult>((resolve, reject) => {
        decodeCalls.push({ kind, resolve, reject });
      });
    },
    close: async () => undefined,
  };
  return {
    runtime,
    queueVadUpdate: (update: VadUpdate) => vadUpdates.push(update),
    decodeCalls,
    decodeKinds,
    resolveOldest(result: DecodeResult): void {
      const call = decodeCalls.shift();
      if (!call) throw new Error("no pending decode call to resolve");
      call.resolve(result);
    },
  };
}

function makeFrame(sequence: number): PcmFrame {
  return { sequence, startMs: sequence * 20, samples: new Int16Array(320) };
}

const result = (text: string, language = "en"): DecodeResult => ({ text, language, startMs: 0, endMs: 20 });

describe("SessionScheduler", () => {
  it("schedules no decode before decodeIntervalMs after speech starts", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const events: EngineEvent[] = [];
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: (event) => events.push(event),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));

    clock.advance(749);
    expect(fake.decodeCalls).toHaveLength(0);

    clock.advance(1);
    expect(fake.decodeCalls).toHaveLength(1);
  });

  it("emits revision 0 on the first tick and revision 1 with the same id on the second", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const events: EngineEvent[] = [];
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: (event) => events.push(event),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));

    clock.advance(750);
    expect(fake.decodeCalls).toHaveLength(1);
    fake.resolveOldest(result("hello"));
    await flush();

    const segments = events.filter((event) => event.type === "segment.upsert");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ segment: { revision: 0, isFinal: false } });
    const segmentId = (segments[0] as Extract<EngineEvent, { type: "segment.upsert" }>).segment.id;

    clock.advance(750);
    expect(fake.decodeCalls).toHaveLength(1);
    fake.resolveOldest(result("hello there"));
    await flush();

    const secondSegments = events.filter((event) => event.type === "segment.upsert");
    expect(secondSegments).toHaveLength(2);
    expect(secondSegments[1]).toMatchObject({ segment: { revision: 1, isFinal: false, id: segmentId } });
  });

  it("coalesces ticks that fire while a decode is pending into a single follow-up decode", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));

    clock.advance(750);
    expect(fake.decodeCalls).toHaveLength(1);

    // Two more intervals elapse while the first decode is still pending.
    clock.advance(750);
    clock.advance(750);
    expect(fake.decodeCalls).toHaveLength(1);

    fake.resolveOldest(result("hello"));
    await flush();

    // Only one follow-up decode fires, not one per elapsed tick.
    expect(fake.decodeKinds).toEqual(["provisional", "provisional"]);
    expect(fake.decodeCalls).toHaveLength(1);
  });

  it("prioritizes exactly one final decode when speech ends while a provisional decode is pending", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));
    clock.advance(750);
    expect(fake.decodeKinds).toEqual(["provisional"]);

    fake.queueVadUpdate({ speechStarted: false, speechEnded: true });
    scheduler.push(makeFrame(1));

    // Further ticks must not sneak in another provisional decode.
    clock.advance(750);
    clock.advance(750);
    expect(fake.decodeKinds).toEqual(["provisional"]);

    fake.resolveOldest(result("hello"));
    await flush();

    expect(fake.decodeKinds).toEqual(["provisional", "final"]);
  });

  it("emits an immutable final segment at revision 2 and starts a fresh utterance afterward", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const events: EngineEvent[] = [];
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: (event) => events.push(event),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));
    clock.advance(750);
    fake.resolveOldest(result("hello"));
    await flush();
    clock.advance(750);
    fake.resolveOldest(result("hello there"));
    await flush();

    fake.queueVadUpdate({ speechStarted: false, speechEnded: true });
    scheduler.push(makeFrame(2));
    fake.resolveOldest(result("hello there friend", "en"));
    await flush();

    const segments = events.filter(
      (event): event is Extract<EngineEvent, { type: "segment.upsert" }> => event.type === "segment.upsert",
    );
    expect(segments).toHaveLength(3);
    expect(segments[2]).toMatchObject({
      segment: { revision: 2, isFinal: true, id: segments[0]!.segment.id, language: { tag: "en-US" } },
    });

    // A new utterance starts a new ordinal/id and resets revisions.
    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(3));
    clock.advance(750);
    fake.resolveOldest(result("second utterance"));
    await flush();

    const allSegments = events.filter(
      (event): event is Extract<EngineEvent, { type: "segment.upsert" }> => event.type === "segment.upsert",
    );
    const fresh = allSegments[3]!;
    expect(fresh.segment.id).not.toBe(segments[0]!.segment.id);
    expect(fresh.segment.revision).toBe(0);
    expect(fresh.segment.isFinal).toBe(false);
  });

  it("drains in-progress speech into a final decode when stopped", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const events: EngineEvent[] = [];
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: (event) => events.push(event),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    expect(fake.decodeKinds).toEqual(["final"]);
    expect(stopped).toBe(false);

    fake.resolveOldest(result("drained"));
    await stopping;

    expect(stopped).toBe(true);
    const segments = events.filter((event) => event.type === "segment.upsert");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ segment: { isFinal: true } });
  });

  it("resolves stop immediately when no speech was ever detected", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: () => undefined,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(fake.decodeCalls).toHaveLength(0);
  });

  it("emits no segment after cancellation even if a decode was already in flight", async () => {
    const clock = createManualClock();
    const fake = createFakeRuntime();
    const events: EngineEvent[] = [];
    const scheduler = new SessionScheduler({
      request: makeSessionRequest(["en-US"]),
      runtime: fake.runtime,
      emit: (event) => events.push(event),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    fake.queueVadUpdate({ speechStarted: true, speechEnded: false });
    scheduler.push(makeFrame(0));
    clock.advance(750);
    expect(fake.decodeCalls).toHaveLength(1);

    const cancelling = scheduler.cancel();
    fake.resolveOldest(result("too late"));
    await cancelling;

    expect(events.filter((event) => event.type === "segment.upsert")).toHaveLength(0);

    // Pushes after cancellation are ignored.
    scheduler.push(makeFrame(1));
    clock.advance(750);
    expect(fake.decodeKinds).toEqual(["provisional"]);
    expect(fake.decodeCalls).toHaveLength(0);
  });
});
