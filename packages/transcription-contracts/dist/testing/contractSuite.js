import { describe, expect, it } from "vitest";
const terminalPushResult = { accepted: false, reason: "backpressure" };
function nextTaskTurn() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
async function drainAsyncDelivery() {
    await nextTaskTurn();
    await nextTaskTurn();
}
async function openPreparedSession(createEngine, request) {
    const engine = createEngine();
    await engine.prepare(request);
    const session = await engine.open(request);
    return { engine, session };
}
export function describeEngineContract(name, createEngine, fixture) {
    describe(`${name} transcription engine contract`, () => {
        it("follows prepare, open, listening, stop, and stopped lifecycle", async () => {
            const { engine, session } = await openPreparedSession(createEngine, fixture.request);
            const events = [];
            session.subscribe((event) => events.push(event));
            const frameCount = fixture.framesBeforeStop ?? 1;
            for (let index = 0; index < frameCount; index += 1) {
                const frame = { ...fixture.frame, sequence: index, startMs: index * 20 };
                expect(session.push(frame)).toEqual({ accepted: true });
            }
            await session.stop();
            const listeningIndex = events.findIndex((event) => event.type === "state" && event.state === "listening");
            const drainingIndex = events.findIndex((event) => event.type === "state" && event.state === "draining");
            const finalSegmentIndex = events.findIndex((event) => event.type === "segment.upsert" && event.segment.isFinal);
            const stoppedIndex = events.findIndex((event) => event.type === "state" && event.state === "stopped");
            expect(listeningIndex).toBeGreaterThanOrEqual(0);
            expect(drainingIndex).toBeGreaterThan(listeningIndex);
            expect(finalSegmentIndex).toBeGreaterThan(drainingIndex);
            expect(stoppedIndex).toBeGreaterThan(finalSegmentIndex);
            await engine.dispose();
        });
        it("emits monotonically increasing event sequences", async () => {
            const { engine, session } = await openPreparedSession(createEngine, fixture.request);
            const events = [];
            session.subscribe((event) => events.push(event));
            session.push(fixture.frame);
            await session.stop();
            expect(events.length).toBeGreaterThan(0);
            expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence)).toBe(true);
            await engine.dispose();
        });
        it("accepts a valid 320-sample PCM frame", async () => {
            const { engine, session } = await openPreparedSession(createEngine, fixture.request);
            const events = [];
            session.subscribe((event) => events.push(event));
            expect(fixture.frame.samples).toHaveLength(320);
            expect(session.push(fixture.frame)).toEqual({ accepted: true });
            await session.cancel();
            await engine.dispose();
        });
        it("does not invoke a listener after it unsubscribes", async () => {
            const { engine, session } = await openPreparedSession(createEngine, fixture.request);
            const events = [];
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
            const events = [];
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
            const events = [];
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
