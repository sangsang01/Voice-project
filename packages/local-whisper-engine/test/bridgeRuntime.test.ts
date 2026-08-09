import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  vadReset: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../src/cache/modelAssets.js", () => ({
  loadModelAsset: vi.fn(async () => new ArrayBuffer(16)),
}));

vi.mock("../wasm/whisper-bridge.js", () => ({
  default: async () => ({
    FS: { writeFile: vi.fn() },
    HEAPU8: new Uint8Array(1_024),
    HEAPF32: new Float32Array(256),
    _malloc: vi.fn(() => 16),
    _free: vi.fn(),
    WhisperBridge: class {
      init() { return true; }
      vadProbs() { return 0; }
      probsPtr() { return 0; }
      vadReset() { mocks.vadReset(); }
      transcribe() { return { text: "", language: "en", languageProbability: 1 }; }
      release() { mocks.release(); }
    },
  }),
}));

import { createBridgeRuntime } from "../src/worker/bridgeRuntime.js";

describe("createBridgeRuntime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates native VAD state reset to the bridge", async () => {
    const runtime = createBridgeRuntime();
    await runtime.load({ onProgress: vi.fn() }, new AbortController().signal);

    runtime.vadReset();

    expect(mocks.vadReset).toHaveBeenCalledOnce();
  });
});
