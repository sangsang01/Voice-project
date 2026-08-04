import type { PcmFrame } from "@voice/transcription-contracts";

export type { PcmFrame } from "@voice/transcription-contracts";

export const TARGET_SAMPLE_RATE_HZ = 16_000;
export const FRAME_DURATION_MS = 20;
export const FRAME_SAMPLES = (TARGET_SAMPLE_RATE_HZ * FRAME_DURATION_MS) / 1_000;
const FILTER_RADIUS = 32;

export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }

  return output;
}

export function resampleTo16kHz(input: Float32Array, inputSampleRateHz: number): Float32Array {
  const resampler = new StreamingResampler(inputSampleRateHz);
  const samples = resampler.push(input);
  const tail = resampler.flush();
  const output = new Float32Array(samples.length + tail.length);
  output.set(samples);
  output.set(tail, samples.length);
  return output;
}

export class StreamingResampler {
  private readonly samplesPerOutput: number;
  private readonly cutoff: number;
  private readonly samples: number[] = [];
  private firstSampleIndex = 0;
  private inputSampleCount = 0;
  private nextOutputIndex = 0;

  public constructor(private readonly inputSampleRateHz: number) {
  if (!Number.isFinite(inputSampleRateHz) || inputSampleRateHz <= 0) {
    throw new RangeError("input sample rate must be positive");
  }

    this.samplesPerOutput = inputSampleRateHz / TARGET_SAMPLE_RATE_HZ;
    this.cutoff = Math.min(0.5, TARGET_SAMPLE_RATE_HZ / (2 * inputSampleRateHz));
  }

  public push(input: Float32Array): Float32Array {
    this.samples.push(...input);
    this.inputSampleCount += input.length;
    return this.drain(false);
  }

  public flush(): Float32Array {
    return this.drain(true);
  }

  private drain(flush: boolean): Float32Array {
    const output: number[] = [];
    const outputCount = Math.floor(
      (this.inputSampleCount * TARGET_SAMPLE_RATE_HZ) / this.inputSampleRateHz,
    );

    while (this.nextOutputIndex < outputCount) {
      const position = this.nextOutputIndex * this.samplesPerOutput;
      if (!flush && position + FILTER_RADIUS > this.inputSampleCount - 1) break;

      output.push(this.filter(position));
      this.nextOutputIndex += 1;
    }

    this.discardConsumedHistory();
    return Float32Array.from(output);
  }

  private filter(position: number): number {
    let result = 0;
    let normalization = 0;
    const firstTap = Math.ceil(position - FILTER_RADIUS);
    const lastTap = Math.floor(position + FILTER_RADIUS);

    for (let sampleIndex = firstTap; sampleIndex <= lastTap; sampleIndex += 1) {
      const offset = sampleIndex - position;
      const coefficient = filterCoefficient(offset, this.cutoff);
      result += this.sampleAt(sampleIndex) * coefficient;
      normalization += coefficient;
    }

    return normalization === 0 ? 0 : result / normalization;
  }

  private sampleAt(sampleIndex: number): number {
    if (sampleIndex < 0 || sampleIndex >= this.inputSampleCount) return 0;
    return this.samples[sampleIndex - this.firstSampleIndex] ?? 0;
  }

  private discardConsumedHistory(): void {
    const firstRequiredIndex = Math.max(
      0,
      Math.floor(this.nextOutputIndex * this.samplesPerOutput - FILTER_RADIUS) - 1,
    );
    const count = firstRequiredIndex - this.firstSampleIndex;
    if (count > 0) {
      this.samples.splice(0, count);
      this.firstSampleIndex = firstRequiredIndex;
    }
  }
}

function filterCoefficient(offset: number, cutoff: number): number {
  const normalizedOffset = offset / FILTER_RADIUS;
  const window = 0.54 + 0.46 * Math.cos(Math.PI * normalizedOffset);
  const sincArgument = 2 * cutoff * offset;
  const sinc = sincArgument === 0 ? 1 : Math.sin(Math.PI * sincArgument) / (Math.PI * sincArgument);
  return 2 * cutoff * sinc * window;
}

export function createPcmFrames(
  samples: Float32Array,
  options: { sequence?: number; startMs?: number } = {},
): PcmFrame[] {
  const firstSequence = options.sequence ?? 0;
  const firstStartMs = options.startMs ?? 0;
  const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
  const frames: PcmFrame[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const start = index * FRAME_SAMPLES;
    frames.push({
      sequence: firstSequence + index,
      startMs: firstStartMs + index * FRAME_DURATION_MS,
      samples: floatToInt16(samples.slice(start, start + FRAME_SAMPLES)),
    });
  }

  return frames;
}
