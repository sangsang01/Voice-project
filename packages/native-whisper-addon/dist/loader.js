import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const MISSING_BINARY_MESSAGE = "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";
export function defaultNativeAddonPath() {
    return join(packageRoot, "build", "Release", "native-whisper-addon.node");
}
export function loadNativeWhisperAddon(options = {}) {
    const binaryPath = options.binaryPath ?? defaultNativeAddonPath();
    const loadBinary = options.loadBinary ?? ((path) => require(path));
    let loaded;
    try {
        loaded = loadBinary(binaryPath);
    }
    catch (error) {
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
function isNativeAddon(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.createRuntime === "function");
}
function isModuleNotFound(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "MODULE_NOT_FOUND");
}
