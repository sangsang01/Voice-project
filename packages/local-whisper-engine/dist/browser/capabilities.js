// A minimal WebAssembly module whose sole function has signature () -> v128
// and whose body is `v128.const i32x4 0 0 0 0` followed by `end`. Validating
// this module is the standard feature-detection trick for WASM SIMD support:
// engines without SIMD reject the v128 result type / v128.const opcode.
//
//   \0asm, version 1
//   type section:     1 type, func () -> v128            (0x7b = v128)
//   function section:  1 function, using type 0
//   code section:      1 body (20 bytes): 0 locals,
//                       v128.const i32x4 0 0 0 0 (0xfd 0x0c + 16 zero bytes), end
export const SIMD_PROBE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b);
function detectSimd() {
    try {
        return typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
    }
    catch {
        return false;
    }
}
function defaultEnvironment() {
    return {
        crossOriginIsolated: typeof globalThis.crossOriginIsolated === "boolean" ? globalThis.crossOriginIsolated : false,
        wasm: typeof WebAssembly === "undefined" ? undefined : WebAssembly,
        simd: detectSimd(),
    };
}
/**
 * whisper.cpp's WASM build needs SIMD and pthreads. pthreads needs
 * SharedArrayBuffer, which the browser only grants to cross-origin-isolated
 * documents -- so a host that forgets COOP/COEP silently loses threading.
 * Reporting it here turns that into a legible message instead of a mystery.
 */
export function inspectLocalCapabilities(environment = defaultEnvironment()) {
    if (!environment.wasm) {
        return { supported: false, reason: "This browser has no WebAssembly runtime." };
    }
    if (!environment.simd) {
        return { supported: false, reason: "This browser lacks WebAssembly SIMD support." };
    }
    if (!environment.crossOriginIsolated) {
        return {
            supported: false,
            reason: "Local transcription needs cross-origin isolation. Serve this page with the COOP and COEP headers.",
        };
    }
    return { supported: true };
}
