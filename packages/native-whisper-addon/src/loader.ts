import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { NativeAddon } from "./types.js";

const NOT_BUILT =
  "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";

export interface LoadNativeWhisperAddonOptions {
  binaryPath?: string;
  loadBinary?: (path: string) => unknown;
}

export function defaultNativeAddonPath(): string {
  return fileURLToPath(new URL("../build/Release/native-whisper-addon.node", import.meta.url));
}

function isMissingBinaryError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "MODULE_NOT_FOUND" || code === "ENOENT";
}

function defaultLoadBinary(binaryPath: string): unknown {
  if (!existsSync(binaryPath)) {
    const error = new Error(`Cannot find module '${binaryPath}'`) as NodeJS.ErrnoException;
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return createRequire(import.meta.url)(binaryPath);
}

export function loadNativeWhisperAddon(
  options: LoadNativeWhisperAddonOptions = {},
): NativeAddon {
  const binaryPath = options.binaryPath ?? defaultNativeAddonPath();
  const loadBinary = options.loadBinary ?? defaultLoadBinary;

  let loaded: unknown;
  try {
    loaded = loadBinary(binaryPath);
  } catch (error) {
    if (isMissingBinaryError(error)) {
      throw new Error(NOT_BUILT);
    }
    throw error;
  }

  if (
    typeof loaded !== "object" ||
    loaded === null ||
    typeof (loaded as NativeAddon).createRuntime !== "function"
  ) {
    throw new Error("Native whisper addon is missing createRuntime");
  }

  return loaded as NativeAddon;
}
