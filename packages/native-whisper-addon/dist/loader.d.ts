import type { NativeAddon } from "./types.js";
export type LoadBinary = (path: string) => unknown;
export interface LoadNativeWhisperAddonOptions {
    binaryPath?: string;
    loadBinary?: LoadBinary;
}
export declare function defaultNativeAddonPath(): string;
export declare function loadNativeWhisperAddon(options?: LoadNativeWhisperAddonOptions): NativeAddon;
