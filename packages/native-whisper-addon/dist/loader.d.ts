import type { NativeAddon } from "./types.js";
export interface LoadNativeWhisperAddonOptions {
    binaryPath?: string;
    loadBinary?: (path: string) => unknown;
}
export declare function defaultNativeAddonPath(): string;
export declare function loadNativeWhisperAddon(options?: LoadNativeWhisperAddonOptions): NativeAddon;
