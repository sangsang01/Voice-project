import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSessionRequest } from "@voice/transcription-contracts/testing";
import { defaultNativeAddonPath, loadNativeWhisperAddon } from "@voice/native-whisper-addon";
import { describe, expect, it } from "vitest";

import { RuntimePool } from "../src/runtimePool.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const jfkPath = join(repoRoot, "apps/web/tests/fixtures/jfk.wav");

describe("native runtime smoke", () => {
  const modelPath = process.env.VOICE_MODEL_PATH;
  const vadModelPath = process.env.VOICE_VAD_MODEL_PATH;
  const requireNative = process.env.VOICE_REQUIRE_NATIVE_TEST === "1";
  const binaryPath = defaultNativeAddonPath();
  const modelsAvailable = Boolean(
    modelPath &&
      vadModelPath &&
      existsSync(modelPath) &&
      existsSync(vadModelPath) &&
      existsSync(binaryPath),
  );

  if (requireNative && !modelsAvailable) {
    it("requires native models when VOICE_REQUIRE_NATIVE_TEST=1", () => {
      const missing = [
        !modelPath || !existsSync(modelPath) ? "VOICE_MODEL_PATH" : undefined,
        !vadModelPath || !existsSync(vadModelPath) ? "VOICE_VAD_MODEL_PATH" : undefined,
        !existsSync(binaryPath) ? "native-whisper-addon.node" : undefined,
      ].filter(Boolean);
      throw new Error(`native smoke required but unavailable: ${missing.join(", ")}`);
    });
    return;
  }

  it.skipIf(!modelsAvailable)("pools a native handle and decodes jfk.wav containing Kennedy", async () => {
    const addon = loadNativeWhisperAddon({ binaryPath });
    const pool = await RuntimePool.create({
      modelName: "native-smoke",
      capacity: 1,
      createHandle: () =>
        addon.createRuntime({
          modelPath: modelPath!,
          vadModelPath: vadModelPath!,
          threads: 2,
          useGpu: false,
        }),
    });

    try {
      const session = await pool.open(makeSessionRequest(["en-US"]));
      const samples = readWavPcm16(jfkPath);
      const result = await session.decode("final", samples, "");
      expect(result.text).toMatch(/Kennedy/i);
      await session.close();
    } finally {
      await pool.shutdown({ drainTimeoutMs: 5_000 });
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
