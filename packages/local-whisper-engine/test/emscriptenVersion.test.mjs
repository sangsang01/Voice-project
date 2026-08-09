import { describe, expect, it } from "vitest";

import {
  EXPECTED_EMSCRIPTEN_VERSION,
  parseEmscriptenVersion,
  validateEmscriptenVersion,
} from "../scripts/emscripten-version.mjs";

describe("Emscripten version validation", () => {
  const expectedOutput =
    "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.6 (ce75e06884093bcefb86a6b8fd56a5d62a4cc245)\n";

  it("parses the emcc release from its version banner", () => {
    expect(parseEmscriptenVersion(expectedOutput)).toBe("6.0.6");
  });

  it("accepts the pinned compiler release", () => {
    expect(validateEmscriptenVersion(expectedOutput)).toBe(EXPECTED_EMSCRIPTEN_VERSION);
  });

  it("rejects a different compiler release with the detected version", () => {
    expect(() => validateEmscriptenVersion("emcc (Emscripten) 5.0.1\n")).toThrow(
      "Emscripten 6.0.6 is required to reproduce the committed WASM artifacts; found 5.0.1.",
    );
  });

  it("rejects an unrecognizable compiler banner", () => {
    expect(() => validateEmscriptenVersion("emcc version unavailable\n")).toThrow(
      "Unable to determine the Emscripten version from `emcc --version` output.",
    );
  });
});
