export const EXPECTED_EMSCRIPTEN_VERSION = "6.0.6";

// Rebuild with:
// emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef
export const PINNED_EMSDK_IMAGE =
  "emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef";

export function parseEmscriptenVersion(emccVersionOutput) {
  return emccVersionOutput.match(/\bemcc\b[^\r\n]*?\b(\d+\.\d+\.\d+)\b/i)?.[1];
}

export function validateEmscriptenVersion(emccVersionOutput) {
  const actualVersion = parseEmscriptenVersion(emccVersionOutput);

  if (!actualVersion) {
    throw new Error("Unable to determine the Emscripten version from `emcc --version` output.");
  }

  if (actualVersion !== EXPECTED_EMSCRIPTEN_VERSION) {
    throw new Error(
      `Emscripten ${EXPECTED_EMSCRIPTEN_VERSION} is required to reproduce the committed WASM artifacts; found ${actualVersion}.`,
    );
  }

  return actualVersion;
}
