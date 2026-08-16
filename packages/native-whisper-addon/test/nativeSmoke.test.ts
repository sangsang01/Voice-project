import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadNativeWhisperAddon } from "../src/loader.js";

const modelPath = process.env.VOICE_MODEL_PATH;
const vadModelPath = process.env.VOICE_VAD_MODEL_PATH;
const requireNative = process.env.VOICE_REQUIRE_NATIVE_TEST === "1";
const hasModels = Boolean(modelPath && vadModelPath);

function readWavPcm16(wavPath: string): Int16Array {
  const buffer = readFileSync(wavPath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const start = offset + 8;
      const copy = buffer.subarray(start, start + size);
      return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`WAV data chunk missing: ${wavPath}`);
}

describe("native whisper smoke", () => {
  if (!hasModels && requireNative) {
    it("fails when native models are required but unset", () => {
      throw new Error("VOICE_MODEL_PATH and VOICE_VAD_MODEL_PATH must be set");
    });
    return;
  }

  if (!hasModels) {
    it.skip("native smoke skipped", () => {});
    return;
  }

  it("warms up once and transcribes jfk.wav without a second createRuntime", async () => {
    const addon = loadNativeWhisperAddon();
    const runtime = addon.createRuntime({
      modelPath: modelPath!,
      vadModelPath: vadModelPath!,
      threads: 1,
      useGpu: false,
    });

    try {
      await runtime.warmup();
      const samples = readWavPcm16(
        fileURLToPath(new URL("../../../apps/web/tests/fixtures/jfk.wav", import.meta.url)),
      );
      const first = await runtime.decode(samples, "");
      const second = await runtime.decode(samples, "");
      expect(first.text).toMatch(/Kennedy/i);
      expect(second.text).toMatch(/Kennedy/i);
    } finally {
      runtime.close();
    }
  });
});
