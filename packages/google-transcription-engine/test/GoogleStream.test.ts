import { describe, expect, it } from "vitest";
import { GoogleStream } from "../src/GoogleStream";
import { createFakeSpeechClientFactory } from "./helpers/fakeGoogleStream";
import type { EngineEvent } from "@voice/transcription-contracts";

function open(candidateLanguages: readonly string[] = ["vi-VN", "en-US", "es-ES", "zh-CN"]) {
  const { factory, duplex } = createFakeSpeechClientFactory();
  const events: EngineEvent[] = [];
  const stream = new GoogleStream({
    sessionId: "session-1",
    candidateLanguages,
    factory,
    onEvent: (event) => events.push(event),
  });
  return { stream, duplex, events };
}

function samples(...values: number[]): Int16Array {
  return Int16Array.from(values);
}

describe("GoogleStream", () => {
  it("opens with the exact V1 streaming config", () => {
    const { duplex } = open();
    expect(duplex.writes).toHaveLength(1);
    const first = duplex.writes[0];
    expect(first).toEqual({
      streamingConfig: {
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: "vi-VN",
          alternativeLanguageCodes: ["en-US", "es-ES", "zh-CN"],
        },
        interimResults: true,
      },
    });
  });

  it("never sends more than three alternative language codes", () => {
    const { duplex } = open(["vi-VN", "en-US", "es-ES", "zh-CN"]);
    const first = duplex.writes[0];
    if (!first || !("streamingConfig" in first)) throw new Error("expected a streamingConfig chunk");
    expect(first.streamingConfig.config.alternativeLanguageCodes.length).toBeLessThanOrEqual(3);
  });

  it("forwards PCM frames as ordered audioContent buffers containing only the frame's own bytes", () => {
    const { stream, duplex } = open();
    const backing = new ArrayBuffer(16);
    const first = new Int16Array(backing, 0, 4);
    first.set([1, 2, 3, 4]);
    const second = new Int16Array(backing, 8, 4);
    second.set([5, 6, 7, 8]);

    stream.write({ sequence: 0, samples: first });
    stream.write({ sequence: 1, samples: second });

    const frames = duplex.writes.slice(1) as { audioContent: Buffer }[];
    expect(frames).toHaveLength(2);
    expect(frames[0]!.audioContent.byteLength).toBe(8);
    expect(frames[1]!.audioContent.byteLength).toBe(8);
    expect(Array.from(new Int16Array(frames[0]!.audioContent.buffer, frames[0]!.audioContent.byteOffset, 4))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(Array.from(new Int16Array(frames[1]!.audioContent.buffer, frames[1]!.audioContent.byteOffset, 4))).toEqual([
      5, 6, 7, 8,
    ]);
  });

  it("propagates backpressure from the underlying duplex", () => {
    const { stream, duplex } = open();
    duplex.writeReturnValue = false;
    expect(stream.write({ sequence: 0, samples: samples(1, 2) })).toBe(false);
    duplex.writeReturnValue = true;
    expect(stream.write({ sequence: 1, samples: samples(3, 4) })).toBe(true);
  });

  it("assigns a new ordinal after a final result and bumps revision on interim updates", () => {
    const { duplex, events } = open();

    duplex.emitData({
      results: [{ alternatives: [{ transcript: "Xin", confidence: 0.4 }], isFinal: false, languageCode: "vi-VN" }],
    });
    duplex.emitData({
      results: [
        { alternatives: [{ transcript: "Xin chào", confidence: 0.9 }], isFinal: true, languageCode: "vi-VN" },
      ],
    });
    duplex.emitData({
      results: [{ alternatives: [{ transcript: "My name", confidence: 0.5 }], isFinal: false, languageCode: "en-US" }],
    });

    const upserts = events.filter((event) => event.type === "segment.upsert");
    expect(upserts).toHaveLength(3);
    expect(upserts[0]!.segment.id).toBe("google-1");
    expect(upserts[0]!.segment.revision).toBe(1);
    expect(upserts[1]!.segment.id).toBe("google-1");
    expect(upserts[1]!.segment.revision).toBe(2);
    expect(upserts[1]!.segment.isFinal).toBe(true);
    expect(upserts[2]!.segment.id).toBe("google-2");
    expect(upserts[2]!.segment.revision).toBe(1);
  });

  it("maps a provider error through the shared error event", () => {
    const { duplex, events } = open();
    duplex.emitError({ code: 14, message: "upstream unavailable, credentials abc123" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "UNAVAILABLE", fatal: true });
    expect(JSON.stringify(events[0])).not.toContain("abc123");
  });

  it("closes exactly once: stop() ends the duplex and removes listeners idempotently", () => {
    const { stream, duplex } = open();
    stream.stop();
    stream.stop();
    stream.cancel();

    expect(duplex.ended).toBe(true);
    expect(duplex.destroyed).toBe(false);
    expect(duplex.listenerCount("data")).toBe(0);
  });

  it("cancel() destroys the duplex instead of ending it", () => {
    const { stream, duplex } = open();
    stream.cancel();

    expect(duplex.destroyed).toBe(true);
    expect(duplex.ended).toBe(false);
  });

  it("stops accepting writes after close", () => {
    const { stream, duplex } = open();
    stream.stop();
    expect(stream.write({ sequence: 0, samples: samples(1, 2) })).toBe(false);
    expect(duplex.writes).toHaveLength(1);
  });
});
