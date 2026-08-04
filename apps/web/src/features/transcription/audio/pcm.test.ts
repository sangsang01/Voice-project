import { describe, expect, it } from "vitest";
import {
  FRAME_SAMPLES,
  StreamingResampler,
  createPcmFrames,
  floatToInt16,
  resampleTo16kHz,
} from "./pcm";

describe("floatToInt16", () => {
  it("clamps floating point samples with asymmetric Int16 limits", () => {
    expect(
      Array.from(floatToInt16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]))),
    ).toEqual([-0x8000, -0x8000, -0x4000, 0, 0x3fff, 0x7fff, 0x7fff]);
  });
});

describe("PCM framing", () => {
  it("resamples 48-kHz audio into bounded 16-kHz 20-ms frames", () => {
    const source = new Float32Array(48_000).map((_, index) => (index < 24_000 ? 1.5 : -1.5));
    const frames = createPcmFrames(resampleTo16kHz(source, 48_000));

    expect(frames).toHaveLength(50);
    expect(frames.every((frame) => frame.samples.length === FRAME_SAMPLES)).toBe(true);
    expect(Math.max(...frames.flatMap((frame) => Array.from(frame.samples)))).toBe(0x7fff);
    expect(Math.min(...frames.flatMap((frame) => Array.from(frame.samples)))).toBe(-0x8000);
  });

  it("assigns strictly monotonic frame sequences", () => {
    const frames = createPcmFrames(new Float32Array(FRAME_SAMPLES * 3), {
      sequence: 7,
      startMs: 140,
    });

    expect(frames.map((frame) => frame.sequence)).toEqual([7, 8, 9]);
    expect(frames.map((frame) => frame.startMs)).toEqual([140, 160, 180]);
  });
});

describe("StreamingResampler", () => {
  it("keeps 44.1-kHz output continuous across arbitrary input chunks", () => {
    const source = sineWave(44_100, 1_000, 4_410);
    const whole = new StreamingResampler(44_100).push(source);
    const chunkedResampler = new StreamingResampler(44_100);
    const chunked = [137, 251, 89, 401, 997, 2_535]
      .flatMap((size, index, sizes) => {
        const start = sizes.slice(0, index).reduce((total, next) => total + next, 0);
        return Array.from(chunkedResampler.push(source.slice(start, start + size)));
      });

    expect(chunked).toEqual(Array.from(whole));
  });

  it("suppresses high frequencies that would alias below the 16-kHz Nyquist limit", () => {
    const output = resampleTo16kHz(sineWave(48_000, 12_000, 48_000), 48_000);
    const settled = output.slice(500, -500);
    const rms = Math.sqrt(settled.reduce((sum, sample) => sum + sample ** 2, 0) / settled.length);

    expect(rms).toBeLessThan(0.05);
  });
});

function sineWave(sampleRateHz: number, frequencyHz: number, length: number): Float32Array {
  return Float32Array.from(
    { length },
    (_, index) => Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz),
  );
}
