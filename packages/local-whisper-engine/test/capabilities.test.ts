import { describe, expect, it } from "vitest";

import { inspectLocalCapabilities, SIMD_PROBE } from "../src/browser/capabilities.js";

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

describe("SIMD_PROBE", () => {
  // Byte offsets the controls below depend on. Pinned explicitly so a change to
  // the module's layout fails loudly here rather than silently neutering them.
  const V128_RESULT_TYPE_INDEX = 14; // 0x7b, the func's v128 result type
  const SIMD_OPCODE_PREFIX_INDEX = 24; // 0xfd, the SIMD instruction prefix
  const V128_CONST_SUBOPCODE_INDEX = 25; // 0x0c, selects v128.const

  const corrupt = (index: number, byte: number) => {
    const bytes = Uint8Array.from(SIMD_PROBE);
    bytes[index] = byte;
    return bytes;
  };

  it("is a valid WebAssembly module", () => {
    // The check that would have caught the original broken bytes: they failed
    // validate() unconditionally, in every engine, regardless of SIMD support.
    expect(WebAssembly.validate(SIMD_PROBE)).toBe(true);
  });

  it("pins the byte layout the controls below depend on", () => {
    expect(SIMD_PROBE[V128_RESULT_TYPE_INDEX]).toBe(0x7b);
    expect(SIMD_PROBE[SIMD_OPCODE_PREFIX_INDEX]).toBe(0xfd);
    expect(SIMD_PROBE[V128_CONST_SUBOPCODE_INDEX]).toBe(0x0c);
  });

  it("stops validating when the v128 result type is swapped for i32", () => {
    // The load-bearing discriminator: an engine without SIMD rejects the v128
    // result type outright, which is what makes this probe a real feature test
    // rather than a module that merely happens to parse.
    expect(WebAssembly.validate(corrupt(V128_RESULT_TYPE_INDEX, 0x7f))).toBe(false);
  });

  it("stops validating when v128.const's sub-opcode is made invalid", () => {
    expect(WebAssembly.validate(corrupt(V128_CONST_SUBOPCODE_INDEX, 0x41))).toBe(false);
  });

  it("stops validating when v128.const loses its 16-byte immediate", () => {
    const truncated = Uint8Array.from([...SIMD_PROBE.slice(0, 26), 0x0b]);
    expect(WebAssembly.validate(truncated)).toBe(false);
  });

  // Documents a trap rather than testing the probe. Overwriting the 0xfd prefix
  // with i32.const leaves a STILL-VALID module: the 16 immediate bytes then
  // decode as `unreachable` (0x00), and after `unreachable` the operand stack
  // is type-polymorphic, so the missing v128 return silently type-checks. That
  // makes this byte useless as a corruption control -- an easy mistake to make,
  // and one that yields a control which passes for the wrong reason. Asserted
  // here so anyone who reaches for it finds the answer already written down.
  it("does NOT stop validating when the SIMD prefix alone is overwritten", () => {
    expect(WebAssembly.validate(corrupt(SIMD_OPCODE_PREFIX_INDEX, 0x41))).toBe(true);
  });
});

describe("inspectLocalCapabilities with no argument", () => {
  it("degrades safely under real Node, where crossOriginIsolated is undefined", () => {
    const result = inspectLocalCapabilities();
    expect(typeof result.supported).toBe("boolean");
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/cross-origin isolation/i);
  });
});
