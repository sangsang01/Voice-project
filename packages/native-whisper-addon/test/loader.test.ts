import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadNativeWhisperAddon } from "../src/loader.js";

const missingMessage =
  "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";

describe("loadNativeWhisperAddon", () => {
  it("throws a build instruction when the binary is missing", () => {
    const loadBinary = vi.fn((binaryPath: string): unknown => {
      const error = new Error(`Cannot find module '${binaryPath}'`) as NodeJS.ErrnoException;
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });

    expect(() => loadNativeWhisperAddon({ loadBinary })).toThrow(missingMessage);
    expect(loadBinary).toHaveBeenCalledWith(
      expect.stringMatching(/build[\\/]Release[\\/]native-whisper-addon\.node$/),
    );
  });

  it("throws when the loaded module is missing createRuntime", () => {
    expect(() =>
      loadNativeWhisperAddon({
        loadBinary: () => ({}),
      }),
    ).toThrow(/createRuntime/);
  });

  it("returns the loaded module when createRuntime is present", () => {
    const addon = { createRuntime: () => ({}) };
    expect(
      loadNativeWhisperAddon({
        binaryPath: fileURLToPath(new URL("./fake.node", import.meta.url)),
        loadBinary: () => addon,
      }),
    ).toBe(addon);
  });
});
