const FILTER_RADIUS = 32;

function filterCoefficient(offset, cutoff) {
  const normalizedOffset = offset / FILTER_RADIUS;
  const window = 0.54 + 0.46 * Math.cos(Math.PI * normalizedOffset);
  const sincArgument = 2 * cutoff * offset;
  const sinc = sincArgument === 0 ? 1 : Math.sin(Math.PI * sincArgument) / (Math.PI * sincArgument);
  return 2 * cutoff * sinc * window;
}

class VoiceStreamingResampler {
  constructor(inputSampleRate) {
    this.samplesPerOutput = inputSampleRate / 16000;
    this.cutoff = Math.min(0.5, 16000 / (2 * inputSampleRate));
    this.samples = [];
    this.firstSampleIndex = 0;
    this.inputSampleCount = 0;
    this.nextOutputIndex = 0;
  }

  push(input) {
    this.samples.push(...input);
    this.inputSampleCount += input.length;
    const output = [];
    const outputCount = Math.floor((this.inputSampleCount * 16000) / sampleRate);

    while (this.nextOutputIndex < outputCount) {
      const position = this.nextOutputIndex * this.samplesPerOutput;
      if (position + FILTER_RADIUS > this.inputSampleCount - 1) break;
      output.push(this.filter(position));
      this.nextOutputIndex += 1;
    }

    this.discardConsumedHistory();
    return output;
  }

  filter(position) {
    let result = 0;
    let normalization = 0;
    const firstTap = Math.ceil(position - FILTER_RADIUS);
    const lastTap = Math.floor(position + FILTER_RADIUS);
    for (let sampleIndex = firstTap; sampleIndex <= lastTap; sampleIndex += 1) {
      const coefficient = filterCoefficient(sampleIndex - position, this.cutoff);
      result += this.sampleAt(sampleIndex) * coefficient;
      normalization += coefficient;
    }
    return normalization === 0 ? 0 : result / normalization;
  }

  sampleAt(sampleIndex) {
    if (sampleIndex < 0 || sampleIndex >= this.inputSampleCount) return 0;
    return this.samples[sampleIndex - this.firstSampleIndex] || 0;
  }

  discardConsumedHistory() {
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

class VoicePcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.sequence = 0;
    this.resampler = new VoiceStreamingResampler(sampleRate);
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    const output = this.resampler.push(input);
    for (const sample of output) {
      const value = Math.max(-1, Math.min(1, sample));
      this.pending.push(value < 0 ? value * 0x8000 : value * 0x7fff);

      if (this.pending.length === 320) {
        const samples = new Int16Array(this.pending);
        this.pending = [];
        this.port.postMessage(
          {
            type: "pcm-frame",
            sequence: this.sequence,
            startMs: this.sequence * 20,
            samples: samples.buffer,
          },
          [samples.buffer],
        );
        this.sequence += 1;
      }
    }
    return true;
  }
}

registerProcessor("voice-pcm-frame", VoicePcmFrameProcessor);
