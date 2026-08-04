import { describe, expect, it } from "vitest";

import { inspectLocalCapabilities } from "../src/browser/capabilities.js";

describe("inspectLocalCapabilities", () => {
  it("prefers WebGPU and includes browser storage estimates", async () => {
    await expect(
      inspectLocalCapabilities({
        gpu: {},
        wasm: {},
        storage: {
          estimate: async () => ({ quota: 10_000, usage: 2_000 }),
        },
      }),
    ).resolves.toEqual({
      device: "webgpu",
      storage: { quota: 10_000, usage: 2_000, available: 8_000 },
    });
  });

  it("falls back to WebAssembly when WebGPU is unavailable", async () => {
    await expect(inspectLocalCapabilities({ wasm: {} })).resolves.toMatchObject({
      device: "wasm",
    });
  });

  it("reports unavailable when neither WebGPU nor WebAssembly is usable", async () => {
    await expect(inspectLocalCapabilities({})).resolves.toMatchObject({
      device: "unavailable",
    });
  });
});
