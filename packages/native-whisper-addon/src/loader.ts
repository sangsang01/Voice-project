import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NativeAddon } from "./types.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

const MISSING_BINARY_MESSAGE =
  "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";

export type LoadBinary = (path: string) => unknown;

export interface LoadNativeWhisperAddonOptions {
  binaryPath?: string;
  loadBinary?: LoadBinary;
}

export function defaultNativeAddonPath(): string {
  return join(packageRoot, "build", "Release", "native-whisper-addon.node");
}

export function loadNativeWhisperAddon(options: LoadNativeWhisperAddonOptions = {}): NativeAddon {
  const binaryPath = options.binaryPath ?? defaultNativeAddonPath();
  const loadBinary = options.loadBinary ?? ((path: string) => require(path));

  let loaded: unknown;
  try {
    loaded = loadBinary(binaryPath);
  } catch (error) {
    if (!existsSync(binaryPath) || isModuleNotFound(error)) {
      throw new Error(MISSING_BINARY_MESSAGE);
    }
    throw error;
  }

  if (!isNativeAddon(loaded)) {
    throw new Error("Native whisper addon binary is missing createRuntime");
  }

  return loaded;
}

function isNativeAddon(value: unknown): value is NativeAddon {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createRuntime?: unknown }).createRuntime === "function"
  );
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "MODULE_NOT_FOUND"
  );
}
