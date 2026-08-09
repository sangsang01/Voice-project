export interface LocalCapabilityEnvironment {
    crossOriginIsolated?: boolean;
    wasm?: unknown;
    simd?: boolean;
}
export interface LocalCapabilities {
    supported: boolean;
    reason?: string;
}
export declare const SIMD_PROBE: Uint8Array<ArrayBuffer>;
/**
 * whisper.cpp's WASM build needs SIMD and pthreads. pthreads needs
 * SharedArrayBuffer, which the browser only grants to cross-origin-isolated
 * documents -- so a host that forgets COOP/COEP silently loses threading.
 * Reporting it here turns that into a legible message instead of a mystery.
 */
export declare function inspectLocalCapabilities(environment?: LocalCapabilityEnvironment): LocalCapabilities;
