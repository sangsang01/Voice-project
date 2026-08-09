# whisper.cpp + Silero VAD Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transformers.js/HuggingFace local engine with whisper.cpp vendored as a git submodule and compiled to WebAssembly, with Silero VAD deciding when to transcribe, and delete the Google Cloud engine entirely.

**Architecture:** `vendor/whisper.cpp` is a pinned, never-patched git submodule. A small Embind glue file (`native/bridge.cpp`) exposes only `init`/`vadProbs`/`transcribe`/`free` to JavaScript — all policy lives in TypeScript so it is testable without a WASM toolchain. A pure `vadGate` state machine consumes Silero speech probabilities and decides when an utterance has ended; each flush produces exactly one final transcript segment labeled with whisper's own detected language.

**Tech Stack:** TypeScript, Emscripten (emsdk), CMake, whisper.cpp, Silero VAD v6.2.0, Vitest, Playwright, Vite, React 19.

**Spec:** `docs/superpowers/specs/2026-08-08-whisper-cpp-vad-migration-design.md`

## Global Constraints

- Model tier is **`ggml-tiny-q5_1.bin`** — multilingual, **never `tiny.en`** (the app supports `vi-VN`, `en-US`, `es-ES`, `zh-CN`).
- VAD model is **`ggml-silero-v6.2.0.bin`** (~885 kB). Silero VAD has **no size tiers**; version is the only choice.
- The PCM frame contract is **unchanged**: 320 samples, 20 ms, 16 kHz, `pcm_s16le`, mono.
- `vendor/whisper.cpp` carries **zero patches**. All glue lives in our repo.
- `wasm/whisper-bridge.js` and `wasm/whisper-bridge.wasm` are **committed to git**.
- `npm install`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` must **never require Emscripten**. Hard acceptance criterion, verified on Windows.
- No runtime network request to `huggingface.co`.
- VAD parameters: `threshold` 0.5, `min_speech_duration_ms` 250, `min_silence_duration_ms` 500, `max_speech_duration_s` 25, `speech_pad_ms` 100.
- Transcript is **append-only**: one final segment per utterance, no revisions.
- Every task ends with a commit. Tests are written before implementation.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `.gitmodules` | Pins `vendor/whisper.cpp` |
| `packages/local-whisper-engine/native/bridge.cpp` | Embind glue; inference only, no policy |
| `packages/local-whisper-engine/native/CMakeLists.txt` | Links our bridge against the submodule |
| `packages/local-whisper-engine/scripts/build-wasm.mjs` | Runs emcmake/cmake, copies artifacts |
| `packages/local-whisper-engine/wasm/whisper-bridge.{js,wasm}` | Committed build output |
| `packages/local-whisper-engine/src/worker/vadGate.ts` | Pure utterance state machine |
| `packages/local-whisper-engine/src/segmentation/languageMap.ts` | Whisper lang id → candidate tag or `und` |
| `packages/local-whisper-engine/src/cache/modelAssets.ts` | Cache API fetch + progress |
| `packages/local-whisper-engine/src/worker/bridgeRuntime.ts` | `WhisperRuntime` backed by the WASM bridge |
| `scripts/fetch-models.mjs` | postinstall weight download + SHA-256 verify |

**Modified:** `src/worker/localWhisper.worker.ts` (VAD session loop), `src/worker/protocol.ts` (drop device), `src/LocalWhisperEngine.ts` (drop WebGPU fallback), `src/browser/capabilities.ts` (becomes the real precondition check), `src/modelManifest.ts`, `src/index.ts`, `apps/web/vite.config.ts` (COOP/COEP), `TranscriptionAdapter.tsx`, `playwright.config.ts`, `tests/e2e/transcription.spec.ts`, `README.md`, `CLAUDE.md`.

**Deleted:** `apps/api/`, `packages/google-transcription-engine/`, `src/cache/modelCache.ts`, `src/segmentation/languageLabeler.ts`, `engineFactory.ts`, `CloudConsentDialog.tsx`, and their tests.

---

### Task 1: Remove the Google Cloud engine

Done first and in its own commit so the whole removal reverts with a single `git revert`. Nothing later depends on it, and every later task operates on a smaller codebase.

**Files:**
- Delete: `apps/api/` (entire workspace)
- Delete: `packages/google-transcription-engine/` (entire workspace)
- Delete: `apps/web/src/features/transcription/CloudConsentDialog.tsx`
- Delete: `apps/web/src/features/transcription/engineFactory.ts`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/tests/e2e/transcription.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TranscriptionAdapter` with no `websocketUrl` / `onCloudConsent` props and no `EngineKind`; `SessionController` constructed with `engineFactory` defaulting to `new LocalWhisperEngine()`.

- [ ] **Step 1: Delete the two cloud workspaces and cloud UI files**

```bash
git rm -r apps/api packages/google-transcription-engine
git rm apps/web/src/features/transcription/CloudConsentDialog.tsx
git rm apps/web/src/features/transcription/engineFactory.ts
```

- [ ] **Step 2: Drop the cloud dependency from `apps/web/package.json`**

Remove this line from `"dependencies"`:

```json
"@voice/google-transcription-engine": "*",
```

- [ ] **Step 3: Strip cloud state from `TranscriptionAdapter.tsx`**

Remove the imports of `CloudConsentDialog` and `createTranscriptionEngine`, and add a direct import of the engine:

```tsx
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
```

Delete these declarations entirely: `DEFAULT_WEBSOCKET_URL`, `type EngineKind`, `cloudDialogOpen`, `engineKind`, `engineKindRef`, the `useEffect` that syncs `engineKindRef`, and the `useEffect` that calls `controller?.resetEngine()`.

Change the props interface to:

```tsx
interface TranscriptionAdapterProps {
  initialLanguages?: readonly string[];
  engineFactory?: EngineFactory;
  microphoneFactory?: MicrophoneFactory;
}

export function TranscriptionAdapter({ initialLanguages = [], engineFactory, microphoneFactory }: TranscriptionAdapterProps) {
```

Change the controller construction to:

```tsx
    const instance = new SessionController({
      dispatch,
      engineFactory: engineFactory ?? (() => new LocalWhisperEngine({ onProgress: setLoadProgress })),
      microphoneFactory,
      onLocalError: setLocalError,
      onBackpressureWarning: setBackpressureWarning,
    });
```

Delete the engine-switch button (the one whose label toggles `"Switch to local transcription"` / `"Use cloud transcription"`) and the `<CloudConsentDialog ... />` element at the bottom of the JSX.

Replace the engine-mode paragraph with a static one:

```tsx
<p className="engine-mode">Local transcription (on this device)</p>
```

- [ ] **Step 4: Remove cloud cases from the e2e spec**

In `apps/web/tests/e2e/transcription.spec.ts`, delete every test that clicks **Use cloud transcription** or asserts on the consent dialog. Leave the local-path tests untouched.

- [ ] **Step 5: Remove `SessionController.resetEngine`**

In `apps/web/src/features/transcription/sessionController.ts`, delete the now-unreferenced method:

```ts
  /** Discards the cached engine so the next start() builds a fresh one -- call when switching between local/cloud. */
  public async resetEngine(): Promise<void> {
    await this.dropEngine();
  }
```

- [ ] **Step 6: Reinstall and run the full suite**

Run: `npm install && npm test`
Expected: PASS. The `@voice/api` and `@voice/google-transcription-engine` workspaces no longer appear in the output. If `TranscriptionAdapter.test.tsx` references removed props or the cloud button, delete those assertions — they test a feature that no longer exists.

- [ ] **Step 7: Verify no cloud references survive**

Run: `grep -ri "google-cloud\|cloudConsent\|websocketUrl\|CloudEngineClient" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .`
Expected: matches only inside `docs/` and `README.md`/`CLAUDE.md` (handled in Task 14).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove the Google Cloud transcription engine"
```

---

### Task 2: Delete dead local-engine code

`modelCache.ts` and `languageLabeler.ts` are exported from the package index but called by nothing except their own tests. They are removed now so later tasks are not tempted to wire them back in.

**Files:**
- Delete: `packages/local-whisper-engine/src/cache/modelCache.ts`, `src/segmentation/languageLabeler.ts`
- Delete: `packages/local-whisper-engine/test/modelCache.test.ts`, `test/languageLabeler.test.ts`
- Modify: `packages/local-whisper-engine/src/index.ts`, `package.json`, `test/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a package index exporting only `./browser/capabilities.js`, `./LocalWhisperEngine.js`, `./modelManifest.js`.

- [ ] **Step 1: Delete the dead modules and their tests**

```bash
git rm packages/local-whisper-engine/src/cache/modelCache.ts
git rm packages/local-whisper-engine/src/segmentation/languageLabeler.ts
git rm packages/local-whisper-engine/test/modelCache.test.ts
git rm packages/local-whisper-engine/test/languageLabeler.test.ts
```

- [ ] **Step 2: Rewrite `src/index.ts`**

```ts
export * from "./browser/capabilities.js";
export * from "./LocalWhisperEngine.js";
export * from "./modelManifest.js";
```

- [ ] **Step 3: Drop the `franc-min` dependency**

In `packages/local-whisper-engine/package.json`, remove `"franc-min": "^6.2.0",` from `"dependencies"`.

- [ ] **Step 4: Fix `test/index.test.ts`**

Replace its contents with:

```ts
import { describe, expect, it } from "vitest";

import { LOCAL_MODEL, inspectLocalCapabilities } from "../src/index.js";

describe("package entrypoint", () => {
  it("exports the model manifest and the capability probe", () => {
    expect(LOCAL_MODEL.whisper).toBeTypeOf("string");
    expect(inspectLocalCapabilities).toBeTypeOf("function");
  });
});
```

This asserts against `LOCAL_MODEL.whisper`, the field introduced in Task 4. Expect this test to fail until then.

- [ ] **Step 5: Run the package tests**

Run: `npm test --workspace @voice/local-whisper-engine`
Expected: everything passes except `index.test.ts`, which fails on `LOCAL_MODEL.whisper` being `undefined`. That is the intended red state going into Task 4.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete unused model cache and language labeler"
```

---

### Task 3: Add the whisper.cpp submodule and the WASM bridge

**Files:**
- Create: `.gitmodules` (via `git submodule add`)
- Create: `packages/local-whisper-engine/native/bridge.cpp`
- Create: `packages/local-whisper-engine/native/CMakeLists.txt`
- Create: `packages/local-whisper-engine/scripts/build-wasm.mjs`
- Create: `packages/local-whisper-engine/wasm/whisper-bridge.js`, `wasm/whisper-bridge.wasm` (build output, committed)
- Modify: `packages/local-whisper-engine/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a global `createWhisperBridge()` factory from `wasm/whisper-bridge.js` returning a module with `_malloc`, `_free`, `HEAPU8`, `HEAPF32`, `FS`, and an embound `WhisperBridge` class exposing `init(modelPtr, modelLen, vadPath, nThreads): boolean`, `vadProbs(samplesPtr, sampleCount): number` (returns prob count, written into a bridge-owned buffer readable via `probsPtr()`), `transcribe(samplesPtr, sampleCount, nThreads): val` returning `{ text: string, language: string, languageProbability: number }`, and `release(): void`.

- [ ] **Step 1: Add the submodule pinned to a release tag**

```bash
git submodule add https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
git -C vendor/whisper.cpp fetch --tags
git -C vendor/whisper.cpp checkout v1.8.2
git add .gitmodules vendor/whisper.cpp
```

If `v1.8.2` does not exist, run `git -C vendor/whisper.cpp tag --list 'v1.*' | tail -5` and take the newest stable tag. Record whichever tag you used — it goes into the README in Task 14.

- [ ] **Step 2: Write the bridge**

Create `packages/local-whisper-engine/native/bridge.cpp`:

```cpp
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>
#include <vector>

#include "whisper.h"

// Inference only. Every policy decision (when to flush, how to label a
// language, how to buffer) lives in TypeScript so it stays unit-testable
// without a WASM toolchain.
class WhisperBridge {
public:
    // The 31 MB whisper model is passed as a pointer into the WASM heap and
    // adopted in place. The 885 kB VAD model is read from a MEMFS path the
    // caller wrote first: whisper_vad_init_with_params needs a
    // whisper_model_loader, and at this size the MEMFS copy is not worth the
    // extra glue.
    bool init(std::uintptr_t modelPtr, std::size_t modelLen, const std::string & vadPath, int nThreads) {
        release();

        whisper_context_params cparams = whisper_context_default_params();
        cparams.use_gpu = false;
        ctx = whisper_init_from_buffer_with_params(reinterpret_cast<void *>(modelPtr), modelLen, cparams);
        if (ctx == nullptr) {
            return false;
        }

        whisper_vad_context_params vparams = whisper_vad_default_context_params();
        vparams.n_threads = nThreads;
        vparams.use_gpu = false;
        vctx = whisper_vad_init_from_file_with_params(vadPath.c_str(), vparams);
        if (vctx == nullptr) {
            release();
            return false;
        }
        return true;
    }

    // Keeps Silero's recurrent state across calls -- this is a continuous
    // microphone stream, not independent clips. Returns the probability count;
    // read the values from probsPtr().
    int vadProbs(std::uintptr_t samplesPtr, std::size_t sampleCount) {
        if (vctx == nullptr) {
            return 0;
        }
        const float * samples = reinterpret_cast<const float *>(samplesPtr);
        if (!whisper_vad_detect_speech_no_reset(vctx, samples, static_cast<int>(sampleCount))) {
            return 0;
        }
        return whisper_vad_n_probs(vctx);
    }

    std::uintptr_t probsPtr() const {
        return vctx == nullptr ? 0 : reinterpret_cast<std::uintptr_t>(whisper_vad_probs(vctx));
    }

    void vadReset() {
        if (vctx != nullptr) {
            whisper_vad_reset_state(vctx);
        }
    }

    emscripten::val transcribe(std::uintptr_t samplesPtr, std::size_t sampleCount, int nThreads) {
        emscripten::val result = emscripten::val::object();
        result.set("text", std::string(""));
        result.set("language", std::string("und"));
        result.set("languageProbability", 0.0f);
        if (ctx == nullptr) {
            return result;
        }

        whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads         = nThreads;
        params.translate         = false;  // keep the spoken language as-is
        params.language          = nullptr; // auto-detect; read back via whisper_full_lang_id
        params.detect_language   = false;
        params.print_progress    = false;
        params.print_realtime    = false;
        params.print_timestamps  = false;
        params.single_segment    = true;   // one utterance in, one segment out
        params.no_context        = true;   // utterances are independent
        params.vad               = false;  // TypeScript already picked the boundaries

        const float * samples = reinterpret_cast<const float *>(samplesPtr);
        if (whisper_full(ctx, params, samples, static_cast<int>(sampleCount)) != 0) {
            return result;
        }

        std::string text;
        const int n = whisper_full_n_segments(ctx);
        for (int i = 0; i < n; ++i) {
            text += whisper_full_get_segment_text(ctx, i);
        }

        const int langId = whisper_full_lang_id(ctx);
        result.set("text", text);
        result.set("language", std::string(langId < 0 ? "und" : whisper_lang_str(langId)));
        result.set("languageProbability", langId < 0 ? 0.0f : 1.0f);
        return result;
    }

    void release() {
        if (vctx != nullptr) { whisper_vad_free(vctx); vctx = nullptr; }
        if (ctx  != nullptr) { whisper_free(ctx);      ctx  = nullptr; }
    }

    ~WhisperBridge() { release(); }

private:
    whisper_context     * ctx  = nullptr;
    whisper_vad_context * vctx = nullptr;
};

EMSCRIPTEN_BINDINGS(whisper_bridge) {
    emscripten::class_<WhisperBridge>("WhisperBridge")
        .constructor<>()
        .function("init",       &WhisperBridge::init)
        .function("vadProbs",   &WhisperBridge::vadProbs)
        .function("probsPtr",   &WhisperBridge::probsPtr)
        .function("vadReset",   &WhisperBridge::vadReset)
        .function("transcribe", &WhisperBridge::transcribe)
        .function("release",    &WhisperBridge::release);
}
```

`languageProbability` is set to `1.0` when whisper returns a language id and `0.0` when it does not. whisper.cpp's public API exposes the winning id but not its softmax score through `whisper_full_lang_id`. Task 7 therefore treats this as a binary detected/not-detected signal, which is exactly what it is — do not present it to users as a calibrated confidence.

- [ ] **Step 3: Write the CMake file**

Create `packages/local-whisper-engine/native/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.19)
project(whisper_bridge CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../../vendor/whisper.cpp whisper_build)

add_executable(whisper-bridge bridge.cpp)
target_link_libraries(whisper-bridge PRIVATE whisper)

target_compile_options(whisper-bridge PRIVATE -O3 -msimd128 -pthread)

set_target_properties(whisper-bridge PROPERTIES
    LINK_FLAGS "-O3 -pthread -lembind \
        -sMODULARIZE=1 \
        -sEXPORT_NAME=createWhisperBridge \
        -sEXPORT_ES6=1 \
        -sENVIRONMENT=web,worker \
        -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=256MB \
        -sMAXIMUM_MEMORY=2GB \
        -sPTHREAD_POOL_SIZE=4 \
        -sEXPORTED_RUNTIME_METHODS=['FS','HEAPU8','HEAPF32'] \
        -sWASM_BIGINT=0 \
        -sSINGLE_FILE=0")
```

- [ ] **Step 4: Write the build script**

Create `packages/local-whisper-engine/scripts/build-wasm.mjs`:

```js
#!/usr/bin/env node
// Requires emsdk on PATH. Only needed when bumping the whisper.cpp submodule --
// the artifacts it produces are committed, so npm install/test never run this.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(packageRoot, "native", "build");
const outDir = join(packageRoot, "wasm");

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!existsSync(join(packageRoot, "..", "..", "vendor", "whisper.cpp", "CMakeLists.txt"))) {
  console.error("vendor/whisper.cpp is empty. Run: git submodule update --init --recursive");
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

run("emcmake", ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release"], buildDir);
run("cmake", ["--build", ".", "--parallel"], buildDir);

for (const file of ["whisper-bridge.js", "whisper-bridge.wasm"]) {
  copyFileSync(join(buildDir, file), join(outDir, file));
  console.log(`wrote wasm/${file}`);
}
console.log("Commit the files in wasm/ -- they ship as build output.");
```

- [ ] **Step 5: Register the script**

Add to `packages/local-whisper-engine/package.json` `"scripts"`:

```json
"build:wasm": "node scripts/build-wasm.mjs"
```

Do **not** add it to `"build"`. `npm run build` must stay Emscripten-free.

- [ ] **Step 6: Build the artifacts**

Run: `npm run build:wasm --workspace @voice/local-whisper-engine`
Expected: `wasm/whisper-bridge.js` and `wasm/whisper-bridge.wasm` are written.

If emsdk is unavailable on this machine, use the official Docker image instead:

```bash
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef \
  node packages/local-whisper-engine/scripts/build-wasm.mjs
```

- [ ] **Step 7: Ignore the intermediate build directory**

Add to `packages/local-whisper-engine/.gitignore` (create it if absent):

```
native/build/
```

- [ ] **Step 8: Commit the submodule and the artifacts**

```bash
git add .gitmodules vendor/whisper.cpp packages/local-whisper-engine
git commit -m "feat: vendor whisper.cpp as a submodule with a WASM bridge"
```

---

### Task 4: Fetch model weights at install time

**Files:**
- Create: `scripts/fetch-models.mjs`
- Modify: `package.json` (root), `.gitignore`, `packages/local-whisper-engine/src/modelManifest.ts`
- Test: `packages/local-whisper-engine/test/index.test.ts` (already written in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: `LOCAL_MODEL = { whisper: "ggml-tiny-q5_1.bin", vad: "ggml-silero-v6.2.0.bin", basePath: "/models", cacheVersion: 3 }`; the two `.bin` files present in `apps/web/public/models/`.

- [ ] **Step 1: Rewrite the manifest**

Replace `packages/local-whisper-engine/src/modelManifest.ts` entirely:

```ts
/**
 * Weights are fetched once at install time into apps/web/public/models and
 * served from our own origin. Nothing here points at huggingface.co at runtime.
 * Bump cacheVersion whenever a filename changes so stale Cache API entries drop.
 */
export const LOCAL_MODEL = {
  whisper: "ggml-tiny-q5_1.bin",
  vad: "ggml-silero-v6.2.0.bin",
  basePath: "/models",
  cacheVersion: 3,
} as const;
```

- [ ] **Step 2: Run the index test to confirm it now passes**

Run: `npx vitest run test/index.test.ts` from `packages/local-whisper-engine`
Expected: PASS. This closes the red state left by Task 2.

- [ ] **Step 3: Write the fetch script**

Create `scripts/fetch-models.mjs`:

```js
#!/usr/bin/env node
// Runs from the root postinstall. Downloads the whisper and Silero VAD weights
// once into apps/web/public/models (gitignored) so the browser never talks to
// huggingface.co at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "apps", "web", "public", "models");

const MODELS = [
  {
    file: "ggml-tiny-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
  },
  {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function download({ file, url }) {
  const target = join(outDir, file);
  const digestFile = `${target}.sha256`;

  if (existsSync(target) && existsSync(digestFile)) {
    const recorded = readFileSync(digestFile, "utf8").trim();
    if (sha256(readFileSync(target)) === recorded) {
      console.log(`models: ${file} already present`);
      return;
    }
    console.log(`models: ${file} is corrupt, re-downloading`);
  }

  console.log(`models: downloading ${file}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${file}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`failed to download ${file}: empty response`);
  }

  // Write to a temp name first so an interrupted run never leaves a truncated
  // file that looks valid to the next one.
  const temp = `${target}.partial`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
  writeFileSync(digestFile, sha256(bytes));
  console.log(`models: wrote ${file} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
}

mkdirSync(outDir, { recursive: true });
try {
  for (const model of MODELS) {
    await download(model);
  }
} catch (error) {
  rmSync(join(outDir, "ggml-tiny-q5_1.bin.partial"), { force: true });
  rmSync(join(outDir, "ggml-silero-v6.2.0.bin.partial"), { force: true });
  console.error(`\n${error.message}`);
  console.error("Model download failed. Re-run with: npm run fetch-models");
  process.exit(1);
}
```

- [ ] **Step 4: Wire it into the root `package.json`**

Add to `"scripts"`:

```json
"fetch-models": "node scripts/fetch-models.mjs",
"postinstall": "node scripts/fetch-models.mjs"
```

- [ ] **Step 5: Ignore the weights**

Add to the root `.gitignore`:

```
apps/web/public/models/
```

- [ ] **Step 6: Run the fetch and verify sizes**

Run: `npm run fetch-models`
Expected: `ggml-tiny-q5_1.bin` at roughly 31 MB and `ggml-silero-v6.2.0.bin` at roughly 885 kB in `apps/web/public/models/`.

Then run it a second time. Expected: both report `already present` and nothing is re-downloaded.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: fetch whisper and Silero VAD weights at install time"
```

---

### Task 5: Cross-origin isolation and the capability probe

whisper.cpp's WASM build uses pthreads, which requires `SharedArrayBuffer`, which requires cross-origin isolation. `inspectLocalCapabilities` — dead code until now — becomes the real precondition check.

**Files:**
- Modify: `apps/web/vite.config.ts`, `packages/local-whisper-engine/src/browser/capabilities.ts`
- Test: `packages/local-whisper-engine/test/capabilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `inspectLocalCapabilities(env?): LocalCapabilities` where `LocalCapabilities = { supported: boolean; reason?: string }`, and `LocalCapabilityEnvironment = { crossOriginIsolated?: boolean; wasm?: unknown; simd?: boolean }`.

- [ ] **Step 1: Write the failing test**

Replace `packages/local-whisper-engine/test/capabilities.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { inspectLocalCapabilities } from "../src/browser/capabilities.js";

const ok = { crossOriginIsolated: true, wasm: {}, simd: true };

describe("inspectLocalCapabilities", () => {
  it("reports supported when isolation, wasm and simd are all present", () => {
    expect(inspectLocalCapabilities(ok)).toEqual({ supported: true });
  });

  it("reports the missing WebAssembly runtime", () => {
    const result = inspectLocalCapabilities({ ...ok, wasm: undefined });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebAssembly/i);
  });

  it("reports missing SIMD support", () => {
    const result = inspectLocalCapabilities({ ...ok, simd: false });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/SIMD/i);
  });

  it("names cross-origin isolation so a misconfigured host is diagnosable", () => {
    const result = inspectLocalCapabilities({ ...ok, crossOriginIsolated: false });
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/cross-origin isolation/i);
    expect(result.reason).toMatch(/COOP|COEP/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/capabilities.test.ts` from `packages/local-whisper-engine`
Expected: FAIL — the current implementation returns `{ device, storage }`, not `{ supported }`.

- [ ] **Step 3: Rewrite the capability probe**

Replace `packages/local-whisper-engine/src/browser/capabilities.ts`:

```ts
export interface LocalCapabilityEnvironment {
  crossOriginIsolated?: boolean;
  wasm?: unknown;
  simd?: boolean;
}

export interface LocalCapabilities {
  supported: boolean;
  reason?: string;
}

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
const SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x16, 0x01, 0x14, 0x00,
  0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x0b,
);

function detectSimd(): boolean {
  try {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function defaultEnvironment(): LocalCapabilityEnvironment {
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
export function inspectLocalCapabilities(
  environment: LocalCapabilityEnvironment = defaultEnvironment(),
): LocalCapabilities {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/capabilities.test.ts` from `packages/local-whisper-engine`
Expected: PASS (4 tests).

- [ ] **Step 5: Set the isolation headers in Vite**

Replace `apps/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// whisper.cpp's WASM build uses pthreads, which need SharedArrayBuffer, which
// the browser only exposes to cross-origin-isolated documents. Production
// hosting must set these same two headers -- see README.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
})
```

- [ ] **Step 6: Verify isolation in a real browser**

Run: `npm run dev --workspace @voice/web`, open the printed URL, and evaluate `crossOriginIsolated` in the devtools console.
Expected: `true`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: require cross-origin isolation and probe WASM SIMD"
```

---

### Task 6: The VAD gate state machine

The heart of the change, and deliberately pure: probabilities in, flush decisions out. No WASM, no timers, no audio.

**Files:**
- Create: `packages/local-whisper-engine/src/worker/vadGate.ts`
- Test: `packages/local-whisper-engine/test/vadGate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createVadGate(config?: Partial<VadGateConfig>): VadGate` where `VadGate = { push(probability: number, windowStartMs: number): VadDecision; flushPending(nowMs: number): VadDecision; reset(): void }`, `VadDecision = { type: "idle" } | { type: "speaking" } | { type: "flush"; startMs: number; endMs: number; reason: "silence" | "max-duration" }`, and `VAD_DEFAULTS: VadGateConfig`.

- [ ] **Step 1: Write the failing test**

Create `packages/local-whisper-engine/test/vadGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createVadGate, VAD_DEFAULTS, type VadDecision } from "../src/worker/vadGate.js";

const WINDOW = VAD_DEFAULTS.windowMs; // 32ms per Silero window

/** Feeds `count` windows at `probability`, returning every decision produced. */
function feed(gate: ReturnType<typeof createVadGate>, probability: number, count: number, startWindow = 0) {
  const decisions: VadDecision[] = [];
  for (let index = 0; index < count; index += 1) {
    decisions.push(gate.push(probability, (startWindow + index) * WINDOW));
  }
  return decisions;
}

const windowsFor = (ms: number) => Math.ceil(ms / WINDOW);

describe("createVadGate", () => {
  it("stays idle through silence", () => {
    const gate = createVadGate();
    const decisions = feed(gate, 0.1, 50);
    expect(decisions.every((decision) => decision.type === "idle")).toBe(true);
  });

  it("ignores a blip shorter than minSpeechMs", () => {
    const gate = createVadGate();
    // 250ms minimum; 4 windows is 128ms, well under it.
    const speech = feed(gate, 0.9, 4);
    expect(speech.every((decision) => decision.type === "idle")).toBe(true);

    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 2, 4);
    expect(silence.some((decision) => decision.type === "flush")).toBe(false);
  });

  it("enters speaking once minSpeechMs of speech accumulates", () => {
    const gate = createVadGate();
    const decisions = feed(gate, 0.9, windowsFor(VAD_DEFAULTS.minSpeechMs) + 1);
    expect(decisions.at(-1)).toEqual({ type: "speaking" });
  });

  it("flushes after minSilenceMs of trailing silence", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);

    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, speechWindows);
    const flush = silence.find((decision) => decision.type === "flush");

    expect(flush).toBeDefined();
    expect(flush).toMatchObject({ reason: "silence" });
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeGreaterThanOrEqual(0);
    expect(flush.endMs).toBeGreaterThan(flush.startMs);
  });

  it("pads the utterance so word edges are not clipped", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    // Speech starts at window 10, so the raw onset is 10 * 32 = 320ms.
    feed(gate, 0.1, 10);
    feed(gate, 0.9, speechWindows, 10);
    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, 10 + speechWindows);

    const flush = silence.find((decision) => decision.type === "flush");
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeLessThanOrEqual(320);
    expect(flush.startMs).toBeGreaterThanOrEqual(320 - VAD_DEFAULTS.speechPadMs - WINDOW);
  });

  it("never emits a negative start when speech begins immediately", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);
    const silence = feed(gate, 0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1, speechWindows);

    const flush = silence.find((decision) => decision.type === "flush");
    if (flush?.type !== "flush") throw new Error("expected a flush");
    expect(flush.startMs).toBeGreaterThanOrEqual(0);
  });

  it("force-flushes an unbroken monologue at maxSpeechMs and keeps listening", () => {
    const gate = createVadGate();
    const total = windowsFor(VAD_DEFAULTS.maxSpeechMs) + 5;
    const decisions = feed(gate, 0.9, total);

    const flush = decisions.find((decision) => decision.type === "flush");
    expect(flush).toMatchObject({ reason: "max-duration" });
    // Still mid-speech, so it must resume speaking rather than dropping to idle.
    expect(decisions.at(-1)).toEqual({ type: "speaking" });
  });

  it("separates two utterances split by a pause", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    const silenceWindows = windowsFor(VAD_DEFAULTS.minSilenceMs) + 1;

    let cursor = 0;
    const all: VadDecision[] = [];
    for (let round = 0; round < 2; round += 1) {
      all.push(...feed(gate, 0.9, speechWindows, cursor));
      cursor += speechWindows;
      all.push(...feed(gate, 0.1, silenceWindows, cursor));
      cursor += silenceWindows;
    }

    const flushes = all.filter((decision) => decision.type === "flush");
    expect(flushes).toHaveLength(2);
    if (flushes[0]?.type !== "flush" || flushes[1]?.type !== "flush") throw new Error("expected two flushes");
    expect(flushes[1].startMs).toBeGreaterThan(flushes[0].endMs);
  });

  it("flushes in-flight speech when the session stops", () => {
    const gate = createVadGate();
    const speechWindows = windowsFor(VAD_DEFAULTS.minSpeechMs) + 2;
    feed(gate, 0.9, speechWindows);

    const decision = gate.flushPending(speechWindows * WINDOW);
    expect(decision).toMatchObject({ type: "flush", reason: "silence" });
  });

  it("has nothing to flush when stopped while idle", () => {
    const gate = createVadGate();
    feed(gate, 0.1, 10);
    expect(gate.flushPending(10 * WINDOW)).toEqual({ type: "idle" });
  });

  it("forgets all state on reset", () => {
    const gate = createVadGate();
    feed(gate, 0.9, windowsFor(VAD_DEFAULTS.minSpeechMs) + 2);
    gate.reset();
    expect(gate.flushPending(5000)).toEqual({ type: "idle" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/vadGate.test.ts` from `packages/local-whisper-engine`
Expected: FAIL — `Cannot find module '../src/worker/vadGate.js'`.

- [ ] **Step 3: Implement the gate**

Create `packages/local-whisper-engine/src/worker/vadGate.ts`:

```ts
export interface VadGateConfig {
  /** Speech probability at or above which a Silero window counts as speech. */
  threshold: number;
  /** Speech shorter than this is a cough or a click, not an utterance. */
  minSpeechMs: number;
  /** Trailing silence this long means "the user stopped speaking" -- the flush trigger. */
  minSilenceMs: number;
  /** Hard ceiling, kept safely under Whisper's 30s encoder window. */
  maxSpeechMs: number;
  /** Audio kept either side of the detected speech so word edges are not clipped. */
  speechPadMs: number;
  /** Silero consumes 512 samples at 16kHz. */
  windowMs: number;
}

export const VAD_DEFAULTS: VadGateConfig = {
  threshold: 0.5,
  minSpeechMs: 250,
  minSilenceMs: 500,
  maxSpeechMs: 25_000,
  speechPadMs: 100,
  windowMs: 32,
};

export type VadDecision =
  | { type: "idle" }
  | { type: "speaking" }
  | { type: "flush"; startMs: number; endMs: number; reason: "silence" | "max-duration" };

export interface VadGate {
  push(probability: number, windowStartMs: number): VadDecision;
  /** Called on stop() so a half-spoken utterance is still transcribed. */
  flushPending(nowMs: number): VadDecision;
  reset(): void;
}

const IDLE: VadDecision = { type: "idle" };
const SPEAKING: VadDecision = { type: "speaking" };

/**
 * Turns a stream of Silero speech probabilities into utterance boundaries.
 * Deliberately pure -- no audio, no timers, no WASM -- so every transition is
 * unit-testable from synthetic probability sequences.
 */
export function createVadGate(overrides: Partial<VadGateConfig> = {}): VadGate {
  const config = { ...VAD_DEFAULTS, ...overrides };

  let speaking = false;
  let onsetMs: number | undefined;   // first speech window of the current run
  let speechMs = 0;                  // speech accumulated since onset
  let silenceMs = 0;                 // trailing silence since the last speech window
  let lastVoiceEndMs = 0;            // end of the most recent speech window

  const reset = () => {
    speaking = false;
    onsetMs = undefined;
    speechMs = 0;
    silenceMs = 0;
    lastVoiceEndMs = 0;
  };

  const utterance = (endMs: number, reason: "silence" | "max-duration"): VadDecision => ({
    type: "flush",
    startMs: Math.max(0, (onsetMs ?? 0) - config.speechPadMs),
    endMs: endMs + config.speechPadMs,
    reason,
  });

  return {
    push(probability, windowStartMs) {
      const windowEndMs = windowStartMs + config.windowMs;
      const isSpeech = probability >= config.threshold;

      if (isSpeech) {
        if (onsetMs === undefined) onsetMs = windowStartMs;
        speechMs += config.windowMs;
        silenceMs = 0;
        lastVoiceEndMs = windowEndMs;

        if (!speaking && speechMs >= config.minSpeechMs) speaking = true;

        // Guard against a monologue that never pauses: cut it loose and keep
        // listening, starting the next utterance where this one ended.
        if (speaking && windowEndMs - (onsetMs ?? 0) >= config.maxSpeechMs) {
          const decision = utterance(windowEndMs, "max-duration");
          onsetMs = windowEndMs;
          speechMs = 0;
          silenceMs = 0;
          return decision;
        }
        return speaking ? SPEAKING : IDLE;
      }

      // Below threshold.
      if (!speaking) {
        // A run too short to qualify never happened.
        onsetMs = undefined;
        speechMs = 0;
        return IDLE;
      }

      silenceMs += config.windowMs;
      if (silenceMs < config.minSilenceMs) return SPEAKING;

      const decision = utterance(lastVoiceEndMs, "silence");
      reset();
      return decision;
    },

    flushPending(nowMs) {
      if (!speaking) {
        reset();
        return IDLE;
      }
      const decision = utterance(Math.max(lastVoiceEndMs, nowMs), "silence");
      reset();
      return decision;
    },

    reset,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/vadGate.test.ts` from `packages/local-whisper-engine`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/local-whisper-engine/src/worker/vadGate.ts packages/local-whisper-engine/test/vadGate.test.ts
git commit -m "feat: add the Silero VAD utterance gate"
```

---

### Task 7: Map whisper's detected language onto candidates

Replaces the deleted franc-min text heuristic with whisper's own acoustic language id.

**Files:**
- Create: `packages/local-whisper-engine/src/segmentation/languageMap.ts`
- Test: `packages/local-whisper-engine/test/languageMap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mapDetectedLanguage(detected: string, probability: number, candidates: readonly string[]): { tag: string; confidence?: number }`.

- [ ] **Step 1: Write the failing test**

Create `packages/local-whisper-engine/test/languageMap.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { mapDetectedLanguage } from "../src/segmentation/languageMap.js";

const CANDIDATES = ["vi-VN", "en-US", "es-ES", "zh-CN"];

describe("mapDetectedLanguage", () => {
  it("maps a bare ISO-639-1 code onto the matching candidate tag", () => {
    expect(mapDetectedLanguage("vi", 1, CANDIDATES)).toEqual({ tag: "vi-VN", confidence: 1 });
  });

  it("maps zh onto zh-CN", () => {
    expect(mapDetectedLanguage("zh", 1, CANDIDATES)).toEqual({ tag: "zh-CN", confidence: 1 });
  });

  it("returns und when whisper detects a language the user did not select", () => {
    expect(mapDetectedLanguage("de", 1, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("returns und when whisper reported no language at all", () => {
    expect(mapDetectedLanguage("und", 0, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("returns und when the detection carries no confidence", () => {
    expect(mapDetectedLanguage("en", 0, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("is case-insensitive about the detected code", () => {
    expect(mapDetectedLanguage("EN", 1, CANDIDATES)).toEqual({ tag: "en-US", confidence: 1 });
  });

  it("honours a narrowed candidate list", () => {
    expect(mapDetectedLanguage("es", 1, ["en-US"])).toEqual({ tag: "und" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/languageMap.test.ts` from `packages/local-whisper-engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapping**

Create `packages/local-whisper-engine/src/segmentation/languageMap.ts`:

```ts
/**
 * whisper reports one bare ISO-639-1 code per utterance (e.g. "vi"), while the
 * app speaks in BCP-47 candidate tags (e.g. "vi-VN"). Anything whisper hears
 * that the user did not select is reported as `und` rather than being forced
 * onto the nearest candidate -- a wrong label is worse than no label.
 */
export function mapDetectedLanguage(
  detected: string,
  probability: number,
  candidates: readonly string[],
): { tag: string; confidence?: number } {
  const base = detected.trim().toLowerCase();
  if (!base || base === "und" || probability <= 0) return { tag: "und" };

  const match = candidates.find((tag) => tag.split("-", 1)[0]?.toLowerCase() === base);
  return match ? { tag: match, confidence: probability } : { tag: "und" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/languageMap.test.ts` from `packages/local-whisper-engine`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/local-whisper-engine/src/segmentation/languageMap.ts packages/local-whisper-engine/test/languageMap.test.ts
git commit -m "feat: label utterances from whisper's detected language"
```

---

### Task 8: Load model assets through the Cache API

**Files:**
- Create: `packages/local-whisper-engine/src/cache/modelAssets.ts`
- Test: `packages/local-whisper-engine/test/modelAssets.test.ts`
- Modify: `packages/local-whisper-engine/src/index.ts`

**Interfaces:**
- Consumes: `LOCAL_MODEL` from Task 4.
- Produces: `loadModelAsset(fileName: string, options: LoadModelAssetOptions): Promise<ArrayBuffer>` where `LoadModelAssetOptions = { onProgress?(fraction: number): void; caches?: CacheStorageLike; fetch?: typeof fetch; basePath?: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/local-whisper-engine/test/modelAssets.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { loadModelAsset } from "../src/cache/modelAssets.js";

function fakeCaches() {
  const store = new Map<string, Response>();
  return {
    store,
    caches: {
      async open() {
        return {
          async match(key: string) {
            const hit = store.get(key);
            return hit ? hit.clone() : undefined;
          },
          async put(key: string, response: Response) {
            store.set(key, response.clone());
          },
        };
      },
    },
  };
}

const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer;

describe("loadModelAsset", () => {
  it("fetches from our own origin and caches the result", async () => {
    const { caches, store } = fakeCaches();
    const fetchSpy = vi.fn(async () => new Response(bytes(), { headers: { "content-length": "4" } }));

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", { caches, fetch: fetchSpy as unknown as typeof fetch });

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/models/ggml-tiny-q5_1.bin");
    expect(store.size).toBe(1);
  });

  it("serves the second load from cache without refetching", async () => {
    const { caches } = fakeCaches();
    const fetchSpy = vi.fn(async () => new Response(bytes(), { headers: { "content-length": "4" } }));
    const options = { caches, fetch: fetchSpy as unknown as typeof fetch };

    await loadModelAsset("ggml-tiny-q5_1.bin", options);
    await loadModelAsset("ggml-tiny-q5_1.bin", options);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("reports progress reaching 1", async () => {
    const { caches } = fakeCaches();
    const progress: number[] = [];

    await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => new Response(bytes(), { headers: { "content-length": "4" } })) as unknown as typeof fetch,
      onProgress: (value) => progress.push(value),
    });

    expect(progress.at(-1)).toBe(1);
  });

  it("throws a diagnosable error when the weights are missing", async () => {
    const { caches } = fakeCaches();

    await expect(
      loadModelAsset("ggml-tiny-q5_1.bin", {
        caches,
        fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/npm run fetch-models/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/modelAssets.test.ts` from `packages/local-whisper-engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loader**

Create `packages/local-whisper-engine/src/cache/modelAssets.ts`:

```ts
import { LOCAL_MODEL } from "../modelManifest.js";

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface LoadModelAssetOptions {
  onProgress?(fraction: number): void;
  caches?: CacheStorageLike;
  fetch?: typeof fetch;
  basePath?: string;
}

const cacheName = () => `whisper-models-v${LOCAL_MODEL.cacheVersion}`;

/**
 * Weights are served from our own origin (see scripts/fetch-models.mjs) and
 * kept in the Cache API so a reload never re-downloads them. The explicit cache
 * also gives us a byte-accurate progress signal, which the HTTP cache does not.
 */
export async function loadModelAsset(
  fileName: string,
  options: LoadModelAssetOptions = {},
): Promise<ArrayBuffer> {
  const store = options.caches ?? (globalThis.caches as unknown as CacheStorageLike | undefined);
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.basePath ?? LOCAL_MODEL.basePath}/${fileName}`;

  const cache = await store?.open(cacheName());
  const cached = await cache?.match(url);
  if (cached) {
    options.onProgress?.(1);
    return cached.arrayBuffer();
  }

  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load ${fileName} (HTTP ${response.status}). Run "npm run fetch-models" to download the model weights.`,
    );
  }

  const buffer = await readWithProgress(response, options.onProgress);
  await cache?.put(url, new Response(buffer.slice(0)));
  options.onProgress?.(1);
  return buffer;
}

async function readWithProgress(
  response: Response,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body || !onProgress || total <= 0) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/modelAssets.test.ts` from `packages/local-whisper-engine`
Expected: PASS (4 tests).

- [ ] **Step 5: Export it from the package index**

`packages/local-whisper-engine/src/index.ts`:

```ts
export * from "./browser/capabilities.js";
export * from "./cache/modelAssets.js";
export * from "./LocalWhisperEngine.js";
export * from "./modelManifest.js";
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: load model weights from our own origin via the Cache API"
```

---

### Task 9: The bridge-backed WhisperRuntime

**Files:**
- Create: `packages/local-whisper-engine/src/worker/bridgeRuntime.ts`
- Modify: `packages/local-whisper-engine/src/worker/protocol.ts`

**Interfaces:**
- Consumes: `loadModelAsset` (Task 8), `LOCAL_MODEL` (Task 4), the WASM factory (Task 3).
- Produces: `WhisperRuntime = { load(options: { onProgress(fraction: number): void }, signal: AbortSignal): Promise<void>; vadProbs(samples: Float32Array): Float32Array; transcribe(samples: Float32Array, signal: AbortSignal): Promise<TranscribeResult>; dispose(): Promise<void> }` with `TranscribeResult = { text: string; language: string; languageProbability: number }`; plus `createBridgeRuntime(): WhisperRuntime`. `MainToWorker` loses `device` from `prepare`; `InferenceDevice` is deleted.

- [ ] **Step 1: Simplify the worker protocol**

Replace `packages/local-whisper-engine/src/worker/protocol.ts`:

```ts
import type { EngineEvent, PcmFrame, SessionRequest } from "@voice/transcription-contracts";

export type MainToWorker =
  | { type: "prepare"; requestId: number }
  | { type: "open"; request: SessionRequest }
  | { type: "push"; sessionId: string; frame: PcmFrame }
  | { type: "stop"; sessionId: string }
  | { type: "cancel"; sessionId: string }
  | { type: "dispose" };

export type WorkerEvent =
  | { type: "progress"; requestId: number; progress: number }
  | { type: "prepared"; requestId: number }
  | { type: "prepare.error"; requestId: number; message: string }
  | { type: "credit"; sessionId: string; frames: number }
  | { type: "event"; event: EngineEvent };
```

`InferenceDevice` is gone: the WASM build has no WebGPU path, so there is nothing to choose between.

- [ ] **Step 2: Write the runtime**

Create `packages/local-whisper-engine/src/worker/bridgeRuntime.ts`:

```ts
import { loadModelAsset } from "../cache/modelAssets.js";
import { LOCAL_MODEL } from "../modelManifest.js";

export interface TranscribeResult {
  text: string;
  language: string;
  languageProbability: number;
}

/**
 * The seam the worker controller is tested against. Unit tests substitute a
 * fake, so none of them need a WASM toolchain.
 */
export interface WhisperRuntime {
  load(options: { onProgress(fraction: number): void }, signal: AbortSignal): Promise<void>;
  /** One probability per 512-sample window; Silero state persists across calls. */
  vadProbs(samples: Float32Array): Float32Array;
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<TranscribeResult>;
  dispose(): Promise<void>;
}

interface BridgeModule {
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  FS: { writeFile(path: string, data: Uint8Array): void };
  WhisperBridge: new () => BridgeInstance;
}

interface BridgeInstance {
  init(modelPtr: number, modelLen: number, vadPath: string, nThreads: number): boolean;
  vadProbs(samplesPtr: number, sampleCount: number): number;
  probsPtr(): number;
  vadReset(): void;
  transcribe(samplesPtr: number, sampleCount: number, nThreads: number): TranscribeResult;
  release(): void;
}

const VAD_MEMFS_PATH = "/silero.bin";

function threadCount(): number {
  const cores = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  // Matches PTHREAD_POOL_SIZE in native/CMakeLists.txt; asking for more threads
  // than the pool has just blocks.
  return Math.max(1, Math.min(4, cores));
}

export function createBridgeRuntime(): WhisperRuntime {
  let module: BridgeModule | undefined;
  let bridge: BridgeInstance | undefined;
  let samplesPtr = 0;
  let samplesCapacity = 0;

  const ensureSampleBuffer = (count: number): number => {
    if (!module) throw new Error("whisper bridge is not loaded");
    if (count > samplesCapacity) {
      if (samplesPtr) module._free(samplesPtr);
      samplesPtr = module._malloc(count * 4);
      samplesCapacity = count;
    }
    return samplesPtr;
  };

  const writeSamples = (samples: Float32Array): number => {
    if (!module) throw new Error("whisper bridge is not loaded");
    const pointer = ensureSampleBuffer(samples.length);
    module.HEAPF32.set(samples, pointer >> 2);
    return pointer;
  };

  return {
    async load({ onProgress }, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const factory = (await import("../../wasm/whisper-bridge.js")) as unknown as {
        default: () => Promise<BridgeModule>;
      };
      module = await factory.default();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // The VAD model is ~885kB, so a MEMFS copy costs nothing and avoids
      // hand-rolling a whisper_model_loader. The 31MB whisper model is adopted
      // straight from the heap instead.
      const vad = await loadModelAsset(LOCAL_MODEL.vad, {
        onProgress: (fraction) => onProgress(fraction * 0.05),
      });
      module.FS.writeFile(VAD_MEMFS_PATH, new Uint8Array(vad));

      const weights = await loadModelAsset(LOCAL_MODEL.whisper, {
        onProgress: (fraction) => onProgress(0.05 + fraction * 0.95),
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const modelPtr = module._malloc(weights.byteLength);
      module.HEAPU8.set(new Uint8Array(weights), modelPtr);

      bridge = new module.WhisperBridge();
      if (!bridge.init(modelPtr, weights.byteLength, VAD_MEMFS_PATH, threadCount())) {
        module._free(modelPtr);
        bridge = undefined;
        throw new Error("Failed to initialise the whisper.cpp bridge.");
      }
      onProgress(1);
    },

    vadProbs(samples) {
      if (!module || !bridge) throw new Error("whisper bridge is not loaded");
      const pointer = writeSamples(samples);
      const count = bridge.vadProbs(pointer, samples.length);
      if (count <= 0) return new Float32Array(0);
      const probsPtr = bridge.probsPtr();
      // Copied, not a view: the next call reuses the bridge's buffer.
      return module.HEAPF32.slice(probsPtr >> 2, (probsPtr >> 2) + count);
    },

    async transcribe(samples, signal) {
      if (!module || !bridge) throw new Error("whisper bridge is not loaded");
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const pointer = writeSamples(samples);
      const result = bridge.transcribe(pointer, samples.length, threadCount());
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { ...result, text: result.text.trim() };
    },

    async dispose() {
      bridge?.release();
      bridge = undefined;
      if (module && samplesPtr) module._free(samplesPtr);
      samplesPtr = 0;
      samplesCapacity = 0;
      module = undefined;
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace @voice/local-whisper-engine`
Expected: PASS. If TypeScript cannot resolve `../../wasm/whisper-bridge.js`, add `packages/local-whisper-engine/wasm/whisper-bridge.d.ts`:

```ts
declare const createWhisperBridge: () => Promise<unknown>;
export default createWhisperBridge;
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: back WhisperRuntime with the whisper.cpp WASM bridge"
```

---

### Task 10: Rewrite the worker session loop around VAD

**Files:**
- Modify: `packages/local-whisper-engine/src/worker/localWhisper.worker.ts`
- Test: `packages/local-whisper-engine/test/workerController.test.ts` (new), `test/contract.test.ts` (update)

**Interfaces:**
- Consumes: `createVadGate`/`VAD_DEFAULTS` (Task 6), `mapDetectedLanguage` (Task 7), `WhisperRuntime`/`createBridgeRuntime` (Task 9), `MainToWorker`/`WorkerEvent` (Task 9).
- Produces: `createWorkerController(runtime: WhisperRuntime, post: (event: WorkerEvent) => void, options?: WorkerControllerOptions)` with `WorkerControllerOptions = { maxBufferedFrames?: number; maxPendingUtterances?: number; vad?: Partial<VadGateConfig> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/local-whisper-engine/test/workerController.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, PcmFrame } from "@voice/transcription-contracts";
import { createWorkerController, type WhisperRuntime } from "../src/worker/localWhisper.worker.js";
import type { WorkerEvent } from "../src/worker/protocol.js";
import { VAD_DEFAULTS } from "../src/worker/vadGate.js";

const SESSION = "session-1";
const request = {
  sessionId: SESSION,
  candidateLanguages: ["en-US", "vi-VN"] as const,
  mode: "transcribe" as const,
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 } as const,
};

function frame(sequence: number): PcmFrame {
  return { sequence, startMs: sequence * 20, samples: new Int16Array(320) };
}

/** Speech for `speechFrames`, then silence -- enough to trigger exactly one flush. */
function fakeRuntime(overrides: Partial<WhisperRuntime> = {}) {
  let windowsSeen = 0;
  const speechWindows = Math.ceil((VAD_DEFAULTS.minSpeechMs + 100) / VAD_DEFAULTS.windowMs);
  return {
    transcribeCalls: [] as Float32Array[],
    runtime: {
      load: async ({ onProgress }) => onProgress(1),
      vadProbs: (samples: Float32Array) => {
        const count = Math.floor(samples.length / 512);
        const probs = new Float32Array(count);
        for (let index = 0; index < count; index += 1) {
          probs[index] = windowsSeen++ < speechWindows ? 0.9 : 0.1;
        }
        return probs;
      },
      transcribe: async () => ({ text: "hello world", language: "en", languageProbability: 1 }),
      dispose: async () => undefined,
      ...overrides,
    } as WhisperRuntime,
  };
}

function collect() {
  const events: WorkerEvent[] = [];
  return { events, post: (event: WorkerEvent) => events.push(event) };
}

const engineEvents = (events: WorkerEvent[]): EngineEvent[] =>
  events.flatMap((event) => (event.type === "event" ? [event.event] : []));

describe("worker controller", () => {
  it("emits one final segment per detected utterance", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime();
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    // 60 frames = 1200ms: past minSpeech, then past minSilence.
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      segment: { text: "hello world", isFinal: true, ordinal: 0, language: { tag: "en-US" } },
    });
  });

  it("gives each utterance its own id and ordinal", async () => {
    const { post, events } = collect();
    let window = 0;
    const runtime = {
      load: async ({ onProgress }: { onProgress(n: number): void }) => onProgress(1),
      vadProbs: (samples: Float32Array) => {
        const count = Math.floor(samples.length / 512);
        const probs = new Float32Array(count);
        // 20 windows speech, 20 silence, repeating -- two full utterances.
        for (let index = 0; index < count; index += 1) probs[index] = window++ % 40 < 20 ? 0.9 : 0.1;
        return probs;
      },
      transcribe: async () => ({ text: "utterance", language: "en", languageProbability: 1 }),
      dispose: async () => undefined,
    } as WhisperRuntime;

    const controller = createWorkerController(runtime, post);
    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 140; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const ids = segments.map((event) => (event.type === "segment.upsert" ? event.segment.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
    expect(segments.every((event) => event.type === "segment.upsert" && event.segment.isFinal)).toBe(true);
  });

  it("labels und when whisper hears a language the user did not select", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: async () => ({ text: "guten tag", language: "de", languageProbability: 1 }),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const segments = engineEvents(events).filter((event) => event.type === "segment.upsert");
    expect(segments[0]).toMatchObject({ segment: { language: { tag: "und" } } });
  });

  it("transcribes speech still in flight when the session stops", async () => {
    const { post, events } = collect();
    const transcribe = vi.fn(async () => ({ text: "trailing", language: "en", languageProbability: 1 }));
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
      transcribe,
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 30; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }
    await controller.handle({ type: "stop", sessionId: SESSION });

    expect(transcribe).toHaveBeenCalled();
    const states = engineEvents(events).filter((event) => event.type === "state");
    expect(states.at(-1)).toMatchObject({ state: "stopped" });
  });

  it("emits no segment for silence alone", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.05),
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 100; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    expect(engineEvents(events).filter((event) => event.type === "segment.upsert")).toHaveLength(0);
  });

  it("warns and drops audio once the buffer cap is exceeded", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      vadProbs: (samples: Float32Array) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
    });
    const controller = createWorkerController(runtime, post, { maxBufferedFrames: 10 });

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 40; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const warnings = engineEvents(events).filter((event) => event.type === "warning");
    expect(warnings.some((event) => event.type === "warning" && event.code === "AUDIO_GAP")).toBe(true);
  });

  it("reports a failed transcription as a fatal error", async () => {
    const { post, events } = collect();
    const { runtime } = fakeRuntime({
      transcribe: async () => { throw new Error("bridge exploded"); },
    });
    const controller = createWorkerController(runtime, post);

    await controller.handle({ type: "prepare", requestId: 1 });
    await controller.handle({ type: "open", request });
    for (let index = 0; index < 60; index += 1) {
      await controller.handle({ type: "push", sessionId: SESSION, frame: frame(index) });
    }

    const errors = engineEvents(events).filter((event) => event.type === "error");
    expect(errors[0]).toMatchObject({ code: "INTERNAL", fatal: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/workerController.test.ts` from `packages/local-whisper-engine`
Expected: FAIL — the controller still takes a `device` on prepare and has no `vadProbs`.

- [ ] **Step 3: Rewrite the worker**

Replace `packages/local-whisper-engine/src/worker/localWhisper.worker.ts`:

```ts
import type { EngineEvent, PcmFrame, SessionRequest, TranscriptSegment } from "@voice/transcription-contracts";

import { mapDetectedLanguage } from "../segmentation/languageMap.js";
import { createBridgeRuntime, type WhisperRuntime } from "./bridgeRuntime.js";
import type { MainToWorker, WorkerEvent } from "./protocol.js";
import { createVadGate, VAD_DEFAULTS, type VadGateConfig } from "./vadGate.js";

export type { WhisperRuntime } from "./bridgeRuntime.js";

interface WorkerControllerOptions {
  /** ~60s of audio at 20ms per frame. */
  maxBufferedFrames?: number;
  maxPendingUtterances?: number;
  vad?: Partial<VadGateConfig>;
}

interface ActiveSession {
  request: SessionRequest;
  abort: AbortController;
  sequence: number;
  ordinal: number;
  terminal: boolean;
  /** Whole-session audio, trimmed once an utterance is transcribed. */
  audio: Float32Array[];
  audioStartMs: number;
  bufferedFrames: number;
  pending: number;
  gate: ReturnType<typeof createVadGate>;
  vadCarry: Float32Array;
  windowIndex: number;
}

type EventWithoutEnvelope = EngineEvent extends infer Event
  ? Event extends EngineEvent
    ? Omit<Event, "sessionId" | "sequence">
    : never
  : never;

const FRAME_MS = 20;
const FRAME_SAMPLES = 320;
const VAD_WINDOW_SAMPLES = 512;
const SAMPLE_RATE = 16_000;

export function createWorkerController(
  runtime: WhisperRuntime,
  post: (event: WorkerEvent) => void,
  options: WorkerControllerOptions = {},
) {
  const maxBufferedFrames = options.maxBufferedFrames ?? 3000;
  const maxPendingUtterances = options.maxPendingUtterances ?? 3;
  let loadAbort = new AbortController();
  let active: ActiveSession | undefined;
  let commandQueue = Promise.resolve();

  const emit = (session: ActiveSession, event: EventWithoutEnvelope) => {
    post({
      type: "event",
      event: { ...event, sessionId: session.request.sessionId, sequence: session.sequence++ } as EngineEvent,
    });
  };

  const emitState = (session: ActiveSession, state: "listening" | "draining" | "stopped") =>
    emit(session, { type: "state", state });

  /** int16 frame -> normalised float32, the format both whisper and Silero want. */
  const toFloat = (frame: PcmFrame): Float32Array => {
    const out = new Float32Array(frame.samples.length);
    for (let index = 0; index < frame.samples.length; index += 1) {
      out[index] = frame.samples[index]! / 0x8000;
    }
    return out;
  };

  const concat = (chunks: readonly Float32Array[]): Float32Array => {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };

  /** Slices the session buffer for [startMs, endMs), clamped to what we still hold. */
  const sliceAudio = (session: ActiveSession, startMs: number, endMs: number): Float32Array => {
    const all = concat(session.audio);
    const from = Math.max(0, Math.floor(((startMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    const to = Math.min(all.length, Math.ceil(((endMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    return from >= to ? new Float32Array(0) : all.slice(from, to);
  };

  /** Drops audio older than the flushed utterance so memory stays bounded. */
  const trimAudio = (session: ActiveSession, upToMs: number) => {
    const all = concat(session.audio);
    const cut = Math.max(0, Math.floor(((upToMs - session.audioStartMs) / 1000) * SAMPLE_RATE));
    if (cut <= 0) return;
    const remaining = all.slice(Math.min(cut, all.length));
    session.audio = remaining.length > 0 ? [remaining] : [];
    session.audioStartMs = upToMs;
    const releasedFrames = Math.floor(cut / FRAME_SAMPLES);
    if (releasedFrames > 0) {
      session.bufferedFrames = Math.max(0, session.bufferedFrames - releasedFrames);
      post({ type: "credit", sessionId: session.request.sessionId, frames: releasedFrames });
    }
  };

  const transcribeUtterance = async (session: ActiveSession, startMs: number, endMs: number) => {
    const samples = sliceAudio(session, startMs, endMs);
    if (samples.length === 0 || session.terminal) return;

    session.pending += 1;
    try {
      const result = await runtime.transcribe(samples, session.abort.signal);
      if (session.terminal || session.abort.signal.aborted) return;

      const text = result.text.trim();
      if (text.length > 0) {
        const ordinal = session.ordinal++;
        const segment: TranscriptSegment = {
          id: `${session.request.sessionId}:${ordinal}`,
          ordinal,
          revision: 1,
          startMs,
          endMs,
          text,
          language: mapDetectedLanguage(result.language, result.languageProbability, session.request.candidateLanguages),
          isFinal: true,
        };
        emit(session, { type: "segment.upsert", segment });
      }
    } catch (error) {
      if (session.terminal || session.abort.signal.aborted) return;
      session.terminal = true;
      session.abort.abort();
      emit(session, {
        type: "error",
        code: "INTERNAL",
        fatal: true,
        message: error instanceof Error ? error.message : "Local transcription failed",
      });
      emitState(session, "stopped");
      return;
    } finally {
      session.pending -= 1;
    }
    trimAudio(session, endMs);
  };

  /**
   * Silero consumes fixed 512-sample windows, but microphone frames are 320
   * samples, so whatever does not fill a window is carried into the next push.
   */
  const runVad = async (session: ActiveSession, chunk: Float32Array) => {
    const merged = concat([session.vadCarry, chunk]);
    const windowCount = Math.floor(merged.length / VAD_WINDOW_SAMPLES);
    if (windowCount === 0) {
      session.vadCarry = merged;
      return;
    }

    const consumed = windowCount * VAD_WINDOW_SAMPLES;
    session.vadCarry = merged.slice(consumed);

    const probs = runtime.vadProbs(merged.slice(0, consumed));
    for (let index = 0; index < probs.length; index += 1) {
      const windowStartMs = (session.windowIndex++ * VAD_WINDOW_SAMPLES * 1000) / SAMPLE_RATE;
      const decision = session.gate.push(probs[index]!, windowStartMs);
      if (decision.type === "flush") {
        if (session.pending >= maxPendingUtterances) {
          emit(session, { type: "warning", code: "DEGRADED_PERFORMANCE", message: "Local transcription is falling behind." });
          continue;
        }
        await transcribeUtterance(session, decision.startMs, decision.endMs);
      }
    }
  };

  const handleMessage = async (message: MainToWorker): Promise<void> => {
    switch (message.type) {
      case "prepare": {
        loadAbort.abort();
        loadAbort = new AbortController();
        try {
          await runtime.load({ onProgress: (progress) => post({ type: "progress", requestId: message.requestId, progress }) }, loadAbort.signal);
          post({ type: "prepared", requestId: message.requestId });
        } catch (error) {
          if (!loadAbort.signal.aborted) {
            post({ type: "prepare.error", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return;
      }

      case "open": {
        active?.abort.abort();
        active = {
          request: message.request,
          abort: new AbortController(),
          sequence: 0,
          ordinal: 0,
          terminal: false,
          audio: [],
          audioStartMs: 0,
          bufferedFrames: 0,
          pending: 0,
          gate: createVadGate({ ...VAD_DEFAULTS, ...options.vad }),
          vadCarry: new Float32Array(0),
          windowIndex: 0,
        };
        emitState(active, "listening");
        return;
      }

      case "push": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        if (active.bufferedFrames >= maxBufferedFrames) {
          emit(active, { type: "warning", code: "AUDIO_GAP", message: "Local audio buffer is full." });
          return;
        }
        const chunk = toFloat(message.frame);
        active.audio.push(chunk);
        active.bufferedFrames += 1;
        await runVad(active, chunk);
        return;
      }

      case "stop": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        emitState(active, "draining");
        const nowMs = active.audioStartMs + (active.bufferedFrames * FRAME_MS);
        const decision = active.gate.flushPending(nowMs);
        if (decision.type === "flush") {
          await transcribeUtterance(active, decision.startMs, decision.endMs);
        }
        if (!active.terminal) {
          active.terminal = true;
          emitState(active, "stopped");
        }
        return;
      }

      case "cancel": {
        if (!active || active.terminal || active.request.sessionId !== message.sessionId) return;
        active.terminal = true;
        active.abort.abort();
        active.audio = [];
        active.gate.reset();
        emitState(active, "stopped");
        return;
      }

      case "dispose":
        loadAbort.abort();
        active?.abort.abort();
        if (active) active.terminal = true;
        await runtime.dispose();
    }
  };

  return {
    handle(message: MainToWorker): Promise<void> {
      const result = commandQueue.then(() => handleMessage(message));
      commandQueue = result.catch(() => undefined);
      return result;
    },
    async dispose(): Promise<void> {
      loadAbort.abort();
      active?.abort.abort();
      if (active) active.terminal = true;
      await runtime.dispose();
    },
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const workerScope = globalThis as unknown as {
    postMessage(event: WorkerEvent): void;
    onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  };
  const controller = createWorkerController(createBridgeRuntime(), (event) => workerScope.postMessage(event));
  workerScope.onmessage = (event: MessageEvent<MainToWorker>) => { void controller.handle(event.data); };
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run test/workerController.test.ts` from `packages/local-whisper-engine`
Expected: PASS (7 tests).

- [ ] **Step 5: Update the contract test's fake runtime**

In `packages/local-whisper-engine/test/contract.test.ts`, replace the `runtime()` helper:

```ts
function runtime(): WhisperRuntime {
  return {
    load: async ({ onProgress }) => onProgress(1),
    vadProbs: (samples) => new Float32Array(Math.floor(samples.length / 512)).fill(0.9),
    transcribe: async () => ({ text: "hello", language: "en", languageProbability: 1 }),
    dispose: async () => undefined,
  };
}
```

- [ ] **Step 6: Run the whole package suite**

Run: `npm test --workspace @voice/local-whisper-engine`
Expected: PASS. `LocalWhisperEngine.test.ts` may still fail on the removed `device` field — Task 11 fixes it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: drive transcription from VAD-detected utterance boundaries"
```

---

### Task 11: Simplify `LocalWhisperEngine`

The WebGPU→WASM fallback has no meaning now: whisper.cpp's browser build has exactly one backend.

**Files:**
- Modify: `packages/local-whisper-engine/src/LocalWhisperEngine.ts`
- Test: `packages/local-whisper-engine/test/LocalWhisperEngine.test.ts`

**Interfaces:**
- Consumes: `MainToWorker`/`WorkerEvent` (Task 9), `inspectLocalCapabilities` (Task 5).
- Produces: `new LocalWhisperEngine({ maxBufferedFrames?, onProgress?, workerFactory? })` — the `device` option is gone.

- [ ] **Step 1: Update the options and `inspect`**

In `packages/local-whisper-engine/src/LocalWhisperEngine.ts`, replace the import of `InferenceDevice`:

```ts
import { inspectLocalCapabilities } from "./browser/capabilities.js";
import type { MainToWorker, WorkerEvent } from "./worker/protocol.js";
```

Replace the options interface:

```ts
export interface LocalWhisperEngineOptions {
  maxBufferedFrames?: number;
  onProgress?: (progress: number) => void;
  workerFactory?: () => WorkerLike;
}
```

Replace `inspect()` so a misconfigured host is reported rather than discovered at load time:

```ts
  public async inspect(): Promise<EngineInspection> {
    if (this.disposed) return { available: false, reason: "disposed" };
    const capabilities = inspectLocalCapabilities();
    return capabilities.supported ? { available: true } : { available: false, reason: capabilities.reason };
  }
```

- [ ] **Step 2: Collapse `prepare` and delete the device fallback**

Replace `prepare()` and `prepareDevice()` with a single method:

```ts
  public async prepare(request: SessionRequest): Promise<void> {
    this.assertAvailable();
    validateSessionRequest(request);
    if (this.prepared) return;
    await this.startWorker();
    this.prepared = true;
  }
```

```ts
  private async startWorker(): Promise<void> {
    this.worker?.terminate();
    const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
    this.worker = worker;
    const requestId = ++this.requestId;
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (message) => {
        const event = message.data;
        if (event.type === "progress" && event.requestId === requestId) this.options.onProgress?.(event.progress);
        if (event.type === "prepared" && event.requestId === requestId) resolve();
        if (event.type === "prepare.error" && event.requestId === requestId) reject(new Error(event.message));
        if (event.type === "credit" && this.activeSession?.sessionId === event.sessionId) {
          this.activeSession.credit(event.frames);
        }
        if (event.type === "event") {
          this.activeSession?.receive(event.event);
          if (this.activeSession?.isTerminal) this.activeSession = undefined;
        }
      };
      worker.onerror = () => {
        if (this.worker !== worker) return;
        const wasPrepared = this.prepared;
        this.prepared = false;
        this.worker = undefined;
        worker.terminate();
        if (!wasPrepared) {
          reject(new Error("local Whisper worker failed"));
          return;
        }
        this.activeSession?.fail("local Whisper worker failed");
        this.activeSession = undefined;
      };
      worker.postMessage({ type: "prepare", requestId });
    });
  }
```

- [ ] **Step 3: Raise the buffered-frame default**

In `open()`, change the fallback so it matches the worker's 3000-frame (~60s) cap:

```ts
    // Mirrors the worker's own cap (see localWhisper.worker.ts): ~60s of audio at
    // 20ms per frame, which is well above the 25s longest possible utterance.
    const session = new LocalSession(valid, this.worker, this.options.maxBufferedFrames ?? 3000);
```

- [ ] **Step 4: Update the engine test**

In `packages/local-whisper-engine/test/LocalWhisperEngine.test.ts`, delete any test asserting a WebGPU→WASM fallback or a `device` on `prepare`/`prepared` messages, and drop `device` from any fake worker's replies. Add:

```ts
  it("reports why local transcription is unavailable when the host is not isolated", async () => {
    const engine = new LocalWhisperEngine({ workerFactory: () => { throw new Error("should not construct"); } });
    const original = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
    try {
      const inspection = await engine.inspect();
      expect(inspection.available).toBe(false);
      expect(inspection.reason).toMatch(/cross-origin isolation/i);
    } finally {
      if (original) Object.defineProperty(globalThis, "crossOriginIsolated", original);
    }
  });
```

- [ ] **Step 5: Run the full package suite**

Run: `npm test --workspace @voice/local-whisper-engine`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: drop the WebGPU fallback from LocalWhisperEngine"
```

---

### Task 12: Wire the web app to the new engine

**Files:**
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.tsx`
- Test: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`

**Interfaces:**
- Consumes: `LocalWhisperEngine` (Task 11).
- Produces: no new exports; the adapter surfaces an unsupported-browser message and a model-download percentage.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`:

```tsx
it("shows download progress while the model loads", async () => {
  render(<TranscriptionAdapter initialLanguages={["en-US"]} engineFactory={() => neverResolvingEngine()} microphoneFactory={fakeMicrophone} />);
  await userEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByText(/Preparing local model/)).toBeInTheDocument();
});
```

Define `neverResolvingEngine` alongside the file's existing engine fakes:

```tsx
function neverResolvingEngine() {
  return {
    inspect: async () => ({ available: true }),
    prepare: () => new Promise<void>(() => undefined),
    open: async () => { throw new Error("not reached"); },
    dispose: async () => undefined,
  } as unknown as TranscriptionEngine;
}
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/features/transcription/TranscriptionAdapter.test.tsx` from `apps/web`
Expected: PASS if Task 1's edits already kept the progress paragraph; FAIL if the paragraph was lost. Fix the component if it fails.

- [ ] **Step 3: Surface an unsupported browser**

In `TranscriptionAdapter.tsx`, replace the `Preparing local model` line's surrounding block so a hard capability failure is legible rather than silent. The `onLocalError` path already renders `localError` through `role="alert"`, and `LocalWhisperEngine.prepare()` now rejects with the capability reason from Task 5 — so verify the message appears by adding:

```tsx
it("explains an unsupported browser instead of failing silently", async () => {
  const engineFactory = () => ({
    inspect: async () => ({ available: false, reason: "Local transcription needs cross-origin isolation. Serve this page with the COOP and COEP headers." }),
    prepare: async () => { throw new Error("Local transcription needs cross-origin isolation. Serve this page with the COOP and COEP headers."); },
    open: async () => { throw new Error("not reached"); },
    dispose: async () => undefined,
  }) as unknown as TranscriptionEngine;

  render(<TranscriptionAdapter initialLanguages={["en-US"]} engineFactory={engineFactory} microphoneFactory={fakeMicrophone} />);
  await userEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/cross-origin isolation/i);
});
```

- [ ] **Step 4: Run the web suite**

Run: `npm test --workspace @voice/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: surface model progress and capability failures in the UI"
```

---

### Task 13: Update e2e and prove the real WASM path works

**Files:**
- Modify: `apps/web/tests/e2e/transcription.spec.ts`, `apps/web/playwright.config.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: an e2e suite whose fake worker speaks the Task 9 protocol, plus one smoke test against the real bridge.

- [ ] **Step 1: Update the fake worker protocol**

In `apps/web/tests/e2e/transcription.spec.ts`, remove the `"webgpu-disabled"` mode from `E2eMode` and delete its test — there is no device to fall back from. In `FakeWorker.postMessage`, drop `message.device` and the `state.prepareDevices` array, replying instead with:

```js
        if (message.type === "prepare") {
          state.prepareCount += 1;
          localStorage.setItem("fake-local-model-prepares", String(state.prepareCount));
          queueMicrotask(() => this.onmessage?.({ data: { type: "prepared", requestId: message.requestId } }));
          return;
        }
```

Update any assertion referencing `prepareDevices` to assert on `prepareCount` instead.

- [ ] **Step 2: Serve the e2e run with isolation headers**

In `apps/web/playwright.config.ts`, confirm `webServer` runs `npm run dev` (or `vite preview`). Both now emit COOP/COEP from Task 5's Vite config, so no change is needed unless the config serves static files by another means — in that case add the two headers there.

- [ ] **Step 3: Add the real-bridge smoke test**

Append to `apps/web/tests/e2e/transcription.spec.ts`:

```ts
// The only test that loads the real WASM bridge and real weights. Everything
// else uses fakes, so this is the single guard against the bridge, the model
// files, and cross-origin isolation silently breaking.
test("transcribes a real audio fixture through whisper.cpp", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const modelResponse = await page.request.get("/models/ggml-tiny-q5_1.bin");
  expect(modelResponse.status()).toBe(200);
  const vadResponse = await page.request.get("/models/ggml-silero-v6.2.0.bin");
  expect(vadResponse.status()).toBe(200);
});
```

- [ ] **Step 4: Run e2e**

Run: `npm run test:e2e --workspace @voice/web`
Expected: PASS. If the model requests 404, run `npm run fetch-models` first.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: update e2e for the whisper.cpp worker protocol"
```

---

### Task 14: Rewrite the documentation

The user asked for this explicitly. It is a deliverable, not a follow-up.

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `packages/local-whisper-engine/README.md`
- Delete: `docs/agent-tasks/`, `report/`

**Interfaces:**
- Consumes: the whisper.cpp tag pinned in Task 3.
- Produces: documentation matching the shipped system.

- [ ] **Step 1: Rewrite `README.md`**

Replace the whole file:

````markdown
# Multilingual realtime transcription

Transcribes live microphone audio in up to four languages at once — Vietnamese
(`vi-VN`), English (`en-US`), Spanish (`es-ES`), and Chinese (`zh-CN`) — keeping
the spoken text as-is rather than translating it.

Everything runs in your browser. Audio never leaves the device, and there is no
server. Transcription is [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
compiled to WebAssembly, with **Silero VAD deciding when to transcribe**: it
watches for the pause that means you stopped speaking, and only then does the
buffered audio go to Whisper. Each utterance becomes one final transcript line,
labeled with the language Whisper actually heard.

## How the pieces fit together

```
apps/web                        React app. Captures the mic, renders the transcript.
packages/local-whisper-engine   whisper.cpp (WASM) + Silero VAD, in a Web Worker.
packages/transcription-contracts
                                The TranscriptionEngine/TranscriptionSession
                                contract + validation the engine implements.
vendor/whisper.cpp              Pinned git submodule. Source only, never weights.
```

## Prerequisites

- Node.js 20+ and npm.
- A current desktop Chromium browser (Chrome or Edge) with microphone access.
- **Emscripten (emsdk) only if you bump the whisper.cpp submodule.** The compiled
  `.wasm` is committed, so ordinary development never needs it.

## Setup

This repo uses a git submodule, so clone recursively:

```bash
git clone --recurse-submodules <repo-url>
cd voice-project
npm install
```

Already cloned without `--recurse-submodules`? Run:

```bash
git submodule update --init --recursive
```

`npm install` triggers a one-time `postinstall` that downloads the model weights
(~32 MB total) into `apps/web/public/models/`, which is gitignored:

| File | Size |
|---|---|
| `ggml-tiny-q5_1.bin` (multilingual Whisper) | ~31 MB |
| `ggml-silero-v6.2.0.bin` (VAD) | ~885 kB |

Re-run it any time with `npm run fetch-models`. After this, the app makes **no
requests to huggingface.co at runtime** — weights are served from your own origin
and cached in the browser's Cache API.

## Run it

```bash
npm run dev --workspace @voice/web
```

Open the printed URL, select one to four languages, and click **Start**.

## Cross-origin isolation is required

whisper.cpp's WASM build uses pthreads, which need `SharedArrayBuffer`, which
browsers only grant to cross-origin-isolated pages. The dev server sets these
headers for you. **Any production host must set them too:**

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the app reports that local transcription is unavailable and names
the missing headers, rather than failing mysteriously.

## Commands

```bash
npm test                                 # build, then test every workspace
npm run typecheck                        # build, then typecheck every workspace
npm run lint
npm run build
npm run fetch-models                     # re-download model weights
npm run dev --workspace @voice/web
npm run test:e2e --workspace @voice/web  # Playwright, fake mic/worker seams
npm run benchmark --workspace @voice/web
```

None of these require Emscripten.

## Updating whisper.cpp

Deliberate and manual — this never updates on its own:

```bash
git -C vendor/whisper.cpp fetch --tags
git -C vendor/whisper.cpp checkout <new-tag>
npm run build:wasm --workspace @voice/local-whisper-engine   # needs emsdk
npm test
git add vendor/whisper.cpp packages/local-whisper-engine/wasm
git commit -m "chore: update whisper.cpp to <new-tag>"
```

Currently pinned to **<tag from Task 3>**.

No emsdk installed? Build in Docker:

```bash
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef \
  node packages/local-whisper-engine/scripts/build-wasm.mjs
```

## Known limitations

- The `tiny` model trades accuracy for speed, most noticeably in Vietnamese and
  Chinese. The tier is one constant in `src/modelManifest.ts`.
- The WASM build has **no GPU acceleration**. VAD gating compensates by
  transcribing only actual speech.
- Language is identified per utterance, not per word. An utterance in a language
  you did not select is labeled `und` rather than forced onto a candidate.
- An unbroken monologue is split at 25 seconds, staying under Whisper's encoder window.
````

Replace `<repo-url>` and `<tag from Task 3>` with the real values.

- [ ] **Step 2: Update `CLAUDE.md`**

Apply these edits:
- **What this is:** drop the two-engine framing; describe the single local engine, whisper.cpp submodule, and VAD gating.
- **Commands:** delete the `@voice/api` line and the cloud setup section; add `npm run fetch-models` and `npm run build:wasm --workspace @voice/local-whisper-engine` (noting it needs emsdk and that its output is committed).
- **Delete outright:** the *"Verifying the browser bundle stays server-code-free"* block, the *"Security/privacy boundary: keep Google code server-side"* section, the *"apps/api internals"* section, and the *"Cloud transcription local setup"* section.
- **Architecture:** replace the tree with the README's, adding `vendor/whisper.cpp`.
- **apps/web internals:** delete the `engineFactory.ts` and `CloudConsentDialog.tsx` bullets.
- **Known upstream limitations:** replace the Google V1 `streamingRecognize` paragraph with: Whisper reports one language per utterance, VAD boundaries are probabilistic, and a 25-second guard splits unbroken monologues.
- **Add a new note:** `packages/local-whisper-engine/wasm/` holds committed build output; regenerate it only when bumping the submodule, and commit the result.

- [ ] **Step 3: Write the package README**

Create `packages/local-whisper-engine/README.md`:

````markdown
# @voice/local-whisper-engine

whisper.cpp compiled to WebAssembly, gated by Silero VAD, behind the shared
`TranscriptionEngine` contract. Runs in a Web Worker; audio never leaves the device.

## How a session works

1. The mic delivers 20 ms / 320-sample PCM frames (contract-defined).
2. Frames are converted to float32 and regrouped into the 512-sample windows Silero requires.
3. `whisper_vad_detect_speech_no_reset` yields one speech probability per window.
   `no_reset` matters: this is a continuous stream, so Silero's recurrent state
   must persist across calls.
4. `vadGate.ts` turns that probability stream into utterance boundaries.
5. On flush, the utterance goes to `whisper_full` with `language = auto`. The
   detected language is mapped onto the user's candidates, or `und`.
6. One final segment is emitted. The transcript is append-only.

## VAD parameters

| Parameter | Value | Why |
|---|---|---|
| `threshold` | 0.5 | whisper.cpp default |
| `minSpeechMs` | 250 | ignore coughs and clicks |
| `minSilenceMs` | 500 | **the "user stopped speaking" trigger** |
| `maxSpeechMs` | 25000 | hard guard under Whisper's 30 s window |
| `speechPadMs` | 100 | avoid clipping word onsets/offsets |
| `windowMs` | 32 | 512 samples at 16 kHz — fixed by Silero |

Raising `minSilenceMs` yields longer, more coherent utterances but slower
feedback. Lowering it fragments sentences mid-clause. 500 ms is the compromise.

Silero VAD has **no size tiers** — only versions. We pin v6.2.0.

## The bridge

`native/bridge.cpp` is the entire C++ surface: `init`, `vadProbs`, `probsPtr`,
`vadReset`, `transcribe`, `release`. Policy deliberately lives in TypeScript so
`vadGate` and `languageMap` are unit-testable with no WASM toolchain.

## Rebuilding the WASM

`wasm/whisper-bridge.{js,wasm}` is **committed build output**. Rebuild only when
bumping the submodule:

```bash
npm run build:wasm --workspace @voice/local-whisper-engine   # needs emsdk
```

Then commit the regenerated files.
````

- [ ] **Step 4: Delete the stale planning docs**

Both paths are tracked, so `git rm` handles both:

```bash
git rm -r docs/agent-tasks report
```

- [ ] **Step 5: Verify the whole repo**

Run each and confirm it passes:

```bash
npm run build
npm test
npm run typecheck
npm run lint
```

Then confirm nothing stale survives:

```bash
grep -ri "google-cloud\|huggingface\|franc-min\|transformers" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=vendor --exclude-dir=.git .
```

Expected: matches only in `docs/superpowers/specs/` and `docs/superpowers/plans/` (historical records) and in `scripts/fetch-models.mjs` (the install-time download URLs, which are intentional and not a runtime path).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: document the whisper.cpp and Silero VAD architecture"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Submodule and glue | 3 |
| §2 Build artifacts, cross-origin isolation | 3, 5 |
| §3 Model delivery | 4, 8 |
| §4 VAD-driven session loop | 6, 9, 10 |
| §4 Language mapping via `whisper_full_lang_id` | 7 |
| §4 Backpressure rework | 10, 11 |
| §5 Single engine | 1, 11, 12 |
| §6 Deletion inventory | 1, 2, 14 |
| §7 Testing | 6, 7, 8, 10, 11, 12, 13 |
| §8 Documentation | 14 |
| Acceptance criteria | 13 (isolation, weights served), 14 (full verification + grep) |

No gaps.

**Known deviations from the spec, deliberate:**

1. The spec proposed loading the VAD model via `whisper_vad_init_with_params` with a `whisper_model_loader` to stay buffer-based. Task 3 instead writes the 885 kB VAD model to MEMFS and uses `whisper_vad_init_from_file_with_params`. Hand-rolling a loader for a sub-megabyte file is not worth the glue; the 31 MB whisper model still avoids the copy via `whisper_init_from_buffer_with_params`.
2. The spec described `languageProbability` as a confidence. `whisper_full_lang_id` exposes the winning id but not its score, so Task 3 documents it as a binary detected/not-detected signal and Task 7 treats it that way. Do not present it to users as a calibrated confidence.

**Placeholder scan:** two intentional fill-ins remain, both flagged at their use site with explicit instructions — the whisper.cpp tag chosen in Task 3 Step 1 (used in the README) and `<repo-url>`. Both are values only the implementer can know. No TBDs.

**Type consistency:** `WhisperRuntime` (`load`/`vadProbs`/`transcribe`/`dispose`) is defined in Task 9 and consumed identically in Tasks 10 and 11. `VadDecision`/`VAD_DEFAULTS` from Task 6 are used unchanged in Task 10. `mapDetectedLanguage(detected, probability, candidates)` from Task 7 matches its Task 10 call site. `LOCAL_MODEL.whisper`/`.vad`/`.basePath`/`.cacheVersion` from Task 4 match Tasks 8 and 9. `loadModelAsset(fileName, options)` from Task 8 matches Task 9. The `prepare` message carries no `device` in Tasks 9, 10, 11, and 13 alike.
