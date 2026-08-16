import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const NOT_BUILT = "Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon";
export function defaultNativeAddonPath() {
    return fileURLToPath(new URL("../build/Release/native-whisper-addon.node", import.meta.url));
}
function isMissingBinaryError(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    const code = error.code;
    return code === "MODULE_NOT_FOUND" || code === "ENOENT";
}
function defaultLoadBinary(binaryPath) {
    if (!existsSync(binaryPath)) {
        const error = new Error(`Cannot find module '${binaryPath}'`);
        error.code = "MODULE_NOT_FOUND";
        throw error;
    }
    return createRequire(import.meta.url)(binaryPath);
}
export function loadNativeWhisperAddon(options = {}) {
    const binaryPath = options.binaryPath ?? defaultNativeAddonPath();
    const loadBinary = options.loadBinary ?? defaultLoadBinary;
    let loaded;
    try {
        loaded = loadBinary(binaryPath);
    }
    catch (error) {
        if (isMissingBinaryError(error)) {
            throw new Error(NOT_BUILT);
        }
        throw error;
    }
    if (typeof loaded !== "object" ||
        loaded === null ||
        typeof loaded.createRuntime !== "function") {
        throw new Error("Native whisper addon is missing createRuntime");
    }
    return loaded;
}
