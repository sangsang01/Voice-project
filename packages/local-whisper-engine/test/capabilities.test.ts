import { describe, expect, it } from "vitest";

import { inspectLocalCapabilities } from "../src/browser/capabilities.js";

const ok = { crossOriginIsolated: true, wasm: {}, simd: true };

describe("inspectLocalCapabilities", () => {
  it("reports supported when isolation, wasm and simd are all present", () => {
    expect(inspectLocalCapabilities(ok)).toEqual({ supported: true });
  });

  it("reports the missing WebAssembly runtime", () => {
    const result = inspectLocalCapabilities({ ...ok, wasm: undefined });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebAssembly/i);
  });

  it("reports missing SIMD support", () => {
    const result = inspectLocalCapabilities({ ...ok, simd: false });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/SIMD/i);
  });

  it("names cross-origin isolation so a misconfigured host is diagnosable", () => {
    const result = inspectLocalCapabilities({ ...ok, crossOriginIsolated: false });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/cross-origin isolation/i);
    expect(result.reason).toMatch(/COOP|COEP/);
  });
});
