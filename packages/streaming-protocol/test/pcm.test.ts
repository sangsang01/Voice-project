import { describe, expect, it } from "vitest";
import { decodePcmMessage, encodePcmMessage, PCM_MESSAGE_BYTES } from "../src/index.js";

describe("PCM wire codec", () => {
  it("round-trips the exact contract frame", () => {
    const samples = Int16Array.from({ length: 320 }, (_, index) => index - 160);
    const encoded = encodePcmMessage({ sequence: 7, startMs: 140, samples });
    expect(encoded.byteLength).toBe(656);
    expect(PCM_MESSAGE_BYTES).toBe(656);
    const decoded = decodePcmMessage(encoded);
    expect(decoded.sequence).toBe(7);
    expect(decoded.startMs).toBe(140);
    expect(Array.from(decoded.samples)).toEqual(Array.from(samples));
  });

  it("rejects the wrong byte length", () => {
    expect(() => decodePcmMessage(new ArrayBuffer(655))).toThrow(/656/);
  });

  it("rejects an unsupported protocol version", () => {
    const bytes = new Uint8Array(656);
    bytes[0] = 2;
    bytes[1] = 1;
    expect(() => decodePcmMessage(bytes.buffer)).toThrow(/version/);
  });

  it("rejects nonzero reserved bytes", () => {
    const bytes = new Uint8Array(656);
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[2] = 1;
    expect(() => decodePcmMessage(bytes.buffer)).toThrow(/reserved/);
  });
});
