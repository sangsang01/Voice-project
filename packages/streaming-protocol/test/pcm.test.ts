import { describe, expect, it } from "vitest";
import {
  decodePcmMessage,
  encodePcmMessage,
  PCM_HEADER_BYTES,
  PCM_MESSAGE_BYTES,
  PCM_MESSAGE_TYPE,
  PCM_PROTOCOL_VERSION,
} from "../src/index.js";

describe("PCM wire codec", () => {
  it("round-trips the exact contract frame", () => {
    const samples = Int16Array.from({ length: 320 }, (_, index) => index - 160);
    const encoded = encodePcmMessage({ sequence: 7, startMs: 140, samples });
    expect(encoded.byteLength).toBe(656);
    expect(PCM_MESSAGE_BYTES).toBe(656);
    expect(decodePcmMessage(encoded)).toEqual({ sequence: 7, startMs: 140, samples });
  });

  it("writes the exact little-endian wire layout", () => {
    const samples = Int16Array.from({ length: 320 }, (_, index) => index - 160);
    const encoded = encodePcmMessage({ sequence: 0x01020304, startMs: 140.5, samples });
    const view = new DataView(encoded);

    expect(view.getUint8(0)).toBe(PCM_PROTOCOL_VERSION);
    expect(view.getUint8(1)).toBe(PCM_MESSAGE_TYPE);
    expect(view.getUint16(2, true)).toBe(0);
    expect(view.getUint32(4, true)).toBe(0x01020304);
    expect(view.getFloat64(8, true)).toBe(140.5);
    expect(view.getInt16(PCM_HEADER_BYTES, true)).toBe(-160);
    expect(view.getInt16(PCM_HEADER_BYTES + 319 * 2, true)).toBe(159);
  });

  it.each([
    { samples: new Int16Array(319), label: "wrong sample length" },
    { samples: new Uint16Array(320), label: "wrong sample type" },
  ])("rejects frames with $label", ({ samples }) => {
    expect(() =>
      encodePcmMessage({ sequence: 7, startMs: 140, samples: samples as unknown as Int16Array }),
    ).toThrow();
  });

  it.each([
    new ArrayBuffer(655),
    new Uint8Array([2, 1, 0, 0, ...new Array(652).fill(0)]).buffer,
    new Uint8Array([1, 2, 0, 0, ...new Array(652).fill(0)]).buffer,
    new Uint8Array([1, 1, 1, 0, ...new Array(652).fill(0)]).buffer,
  ])("rejects malformed frames", (message) => {
    expect(() => decodePcmMessage(message)).toThrow();
  });
});
