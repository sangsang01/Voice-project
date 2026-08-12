import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultNativeAddonPath, loadNativeWhisperAddon } from "../src/loader.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const missingMessage =
  "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";

describe("loadNativeWhisperAddon", () => {
  it("errors when the binary is missing", () => {
    expect(() =>
      loadNativeWhisperAddon({
        binaryPath: join(packageRoot, "build", "Release", "definitely-missing.node"),
        loadBinary: () => {
          const error = new Error("Cannot find module") as Error & { code?: string };
          error.code = "MODULE_NOT_FOUND";
          throw error;
        },
      }),
    ).toThrow(missingMessage);
  });

  it("rejects a loaded binary that is missing createRuntime", () => {
    expect(() =>
      loadNativeWhisperAddon({
        binaryPath: join(packageRoot, "build", "Release", "fake.node"),
        loadBinary: () => ({}),
      }),
    ).toThrow(/createRuntime/);
  });

  it("returns a shape-checked addon when createRuntime is present", () => {
    const createRuntime = () => ({
      pushVad: () => new Float32Array(),
      decode: async () => ({ text: "", language: "und", startMs: 0, endMs: 0 }),
      warmup: async () => undefined,
      reset: () => undefined,
      close: () => undefined,
    });

    const addon = loadNativeWhisperAddon({
      binaryPath: join(packageRoot, "build", "Release", "fake.node"),
      loadBinary: () => ({ createRuntime }),
    });

    expect(addon.createRuntime).toBe(createRuntime);
  });
});

describe("optional JFK smoke", () => {
  const modelPath = process.env.VOICE_MODEL_PATH;
  const vadModelPath = process.env.VOICE_VAD_MODEL_PATH;
  const binaryPath = defaultNativeAddonPath();
  const canSmoke = Boolean(modelPath && vadModelPath && existsSync(binaryPath));

  it.skipIf(!canSmoke)("decodes jfk.wav and contains Kennedy", async () => {
    const addon = loadNativeWhisperAddon({ binaryPath });
    const runtime = addon.createRuntime({
      modelPath: modelPath!,
      vadModelPath: vadModelPath!,
      threads: 2,
      useGpu: false,
    });

    try {
      await runtime.warmup();
      const samples = readWavPcm16(join(packageRoot, "../../apps/web/tests/fixtures/jfk.wav"));
      const result = await runtime.decode(samples, "");
      expect(result.text).toMatch(/Kennedy/i);
    } finally {
      runtime.close();
    }
  });
});

function readWavPcm16(path: string): Int16Array {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV file: ${path}`);
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "data") {
      const sampleCount = Math.floor(size / 2);
      const samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        samples[i] = buffer.readInt16LE(dataStart + i * 2);
      }
      return samples;
    }
    offset = dataStart + size + (size % 2);
  }

  throw new Error(`WAV data chunk not found: ${path}`);
}
