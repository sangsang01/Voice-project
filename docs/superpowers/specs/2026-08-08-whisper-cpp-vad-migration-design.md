# whisper.cpp + Silero VAD Migration Design

**Date:** 2026-08-08

**Supersedes:** parts of `2026-08-04-multilingual-realtime-transcription-design.md`
(the local engine's runtime, the model-caching story, the language-labeling
strategy, and the two-engine provider abstraction).

## Purpose

Replace the local transcription engine's runtime. Today `packages/local-whisper-engine`
loads `onnx-community/whisper-small` through `@huggingface/transformers`, pulling
~240 MB from HuggingFace and transcribing on a fixed 8-second timer. This migration
vendors **whisper.cpp as a git submodule** (source only, never weights), compiles it
to WebAssembly, and puts **Silero VAD in charge of deciding when to transcribe**.

It also collapses the application to a single engine: the Google Cloud path is
removed entirely.

## Goals

- Vendor whisper.cpp's source as a submodule under our own version control, updated
  manually and deliberately — never automatically.
- Transcribe on speech boundaries detected by Silero VAD, not on a fixed timer.
- Serve model weights from our own origin. No HuggingFace request on the runtime path.
- Cut the local model download from ~240 MB to ~32 MB by moving to the `tiny` tier.
- Label each utterance using whisper's own language ID instead of text heuristics.
- Leave the codebase materially smaller than it started.

## Non-goals

- Changing the PCM frame contract (320 samples / 20 ms / 16 kHz stays exactly as-is).
- Translation, diarization, word-level language ID, or transcript persistence.
- Fine-tuning or converting models ourselves.
- Preserving the cloud engine in any form.

## Decisions taken (with the alternatives that lost)

| Decision | Chosen | Rejected |
|---|---|---|
| Where whisper.cpp runs | Browser, compiled to WASM | Native Node sidecar (needs a C++ toolchain per user); VAD-only submodule keeping transformers.js |
| Weight delivery | `postinstall` fetch → self-hosted, gitignored | Committing 32 MB via git-lfs; browser downloading from HF on first run |
| Transcript shape | One final segment per VAD utterance | Utterance + live partials; single rolling revised segment |
| Cleanup scope | Local cleanup **and** full cloud-engine removal | Local-only cleanup; no cleanup |

### Consequences accepted

- **WebGPU is given up.** The whisper.cpp WASM build is SIMD + threads only. VAD gating
  (transcribing only real speech rather than every 8-second window) is expected to more
  than compensate, but on weak hardware this is the primary risk.
- **`tiny` is materially less accurate than `small`**, particularly for `vi-VN` and
  `zh-CN`. The tier is a single manifest constant so it can be raised later.
- **Cross-origin isolation becomes a hosting requirement** (see §2).
- **Removing the cloud engine is not cheaply reversible** and deletes roughly half the
  existing test suite. This was chosen explicitly.

## Verified upstream facts

These were confirmed against upstream before designing, not recalled:

- whisper.cpp ships exactly two Silero VAD models — `ggml-silero-v5.1.2.bin` and
  `ggml-silero-v6.2.0.bin`, both ~885 kB. **Silero VAD has no size tiers**, so a
  "small" VAD is not selectable; the only choice is version. We take **v6.2.0**.
- The VAD C API is: `whisper_vad_init_from_file_with_params`, `whisper_vad_init_with_params`,
  `whisper_vad_detect_speech`, `whisper_vad_detect_speech_no_reset`, `whisper_vad_reset_state`,
  `whisper_vad_n_probs`, `whisper_vad_probs`, `whisper_vad_segments_from_probs`,
  `whisper_vad_segments_from_samples`, `whisper_vad_free`.
- `whisper_vad_params` = `{ threshold, min_speech_duration_ms, min_silence_duration_ms,
  max_speech_duration_s, speech_pad_ms, samples_overlap }`.
- The WASM build is `emcmake cmake .. && make -j`; `-DWHISPER_WASM_SINGLE_FILE=OFF`
  emits a separate `.wasm` instead of base64-embedding it in the JS.

## Architecture

```text
vendor/whisper.cpp/                  submodule, pinned to a release tag, NEVER patched
packages/local-whisper-engine/
  native/bridge.cpp                  our Embind glue (~150 lines)
  native/CMakeLists.txt              add_subdirectory(vendor/whisper.cpp)
  wasm/whisper-bridge.{js,wasm}      COMMITTED build output
  src/worker/vadGate.ts              pure state machine (no WASM)
  src/worker/localWhisper.worker.ts  session loop
apps/web/public/models/*.bin         gitignored, fetched by postinstall
packages/transcription-contracts/    retained; sheds cloud-specific pieces
```

### §1 Submodule and glue

`vendor/whisper.cpp` is a submodule pinned to a release tag. It carries **zero patches**,
so updating is exactly:

```bash
git -C vendor/whisper.cpp fetch --tags
git -C vendor/whisper.cpp checkout <tag>
git add vendor/whisper.cpp
npm run build:wasm --workspace @voice/local-whisper-engine
```

`bridge.cpp` exposes a deliberately minimal Embind surface:

```
init(modelBuffer, vadBuffer) -> handle
vadProbs(samples: Float32Array) -> Float32Array
transcribe(samples: Float32Array) -> { text, langId, langProb, t0Ms, t1Ms }
free()
```

**Policy lives in TypeScript; C++ owns only inference.** This is what allows the VAD
state machine to be unit-tested without a WASM toolchain.

Models load via `whisper_init_from_buffer` and the VAD loader variant
(`whisper_vad_init_with_params` with a `whisper_model_loader`) so no MEMFS copy is made.

### §2 Build artifacts and cross-origin isolation

`npm run build:wasm` produces `wasm/whisper-bridge.js` and `wasm/whisper-bridge.wasm`.
**Both are committed to the repository**, matching the existing convention of committing
`dist/`. Consequently `npm install`, `npm test`, `npm run build`, and `npm run typecheck`
never require Emscripten. emsdk is needed only when bumping the submodule.

Build flags: SIMD enabled, pthreads enabled, `-DWHISPER_WASM_SINGLE_FILE=OFF`.

Pthreads require `SharedArrayBuffer`, which requires cross-origin isolation. Therefore:

- The Vite dev server sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Production hosting must set the same two headers; this is documented in the README.
- `inspectLocalCapabilities` — currently dead code — is repurposed as the real
  precondition check. If `crossOriginIsolated` is false or WASM SIMD is unavailable,
  `engine.inspect()` returns `{ available: false, reason }` through the existing contract.

All app assets are same-origin, so `require-corp` breaks nothing.

### §3 Model delivery

A root `postinstall` runs `scripts/fetch-models.mjs`, which downloads once into
`apps/web/public/models/` (gitignored):

| File | Source | Size |
|---|---|---|
| `ggml-tiny-q5_1.bin` | `ggerganov/whisper.cpp` | ~31 MB |
| `ggml-silero-v6.2.0.bin` | `ggml-org/whisper-vad` | 885 kB |

The model must be **multilingual `tiny`, never `tiny.en`**, since the app supports
`vi-VN`, `en-US`, `es-ES`, and `zh-CN`.

The script verifies SHA-256, skips work if the file is already present and valid, and
fails loudly rather than leaving a truncated file. At runtime the worker fetches
`/models/*.bin` from its own origin through a small Cache API wrapper keyed by
filename + version, which supplies download-progress events and survives HTTP cache
eviction. This wrapper replaces `src/cache/modelCache.ts`, which was never called by
anything.

### §4 The VAD-driven session loop

Frames arrive unchanged: 320 samples, 20 ms, 16 kHz, `pcm_s16le`. The worker converts to
float32 and regroups into the 512-sample (32 ms) windows Silero requires, then feeds
`whisper_vad_detect_speech_no_reset` and reads `whisper_vad_probs`.

`vadGate.ts` is a pure function of the probability stream:

```text
idle ──speech ≥ 250ms──> speaking ──silence ≥ 500ms──> FLUSH ──> idle
                             └─────── 25s elapsed ───> FLUSH (guard)
```

| Parameter | Value | Rationale |
|---|---|---|
| `threshold` | 0.5 | whisper.cpp default |
| `min_speech_duration_ms` | 250 | ignore coughs, clicks, door slams |
| `min_silence_duration_ms` | 500 | **the "user stopped speaking" trigger** |
| `speech_pad_ms` | 100 | avoid clipping word onsets/offsets |
| `max_speech_duration_s` | 25 | hard guard, safely under Whisper's 30 s window |

On flush, the buffered utterance (speech plus padding) goes to `whisper_full` with
**`language = "auto"`**. We then read `whisper_full_lang_id()` and its probability:

- detected language is among the session's candidate languages → label it, with confidence
- otherwise → label `und`

This is strictly better than both prior behaviors: the worker currently hardcodes
`candidateLanguages[0]` on every segment, and `languageLabeler.ts` guessed from decoded
text with franc-min. Whisper's own acoustic language ID replaces both. This is the
substantive reason `languageLabeler.ts` and the `franc-min` dependency are deleted rather
than merely unwired.

Each flush emits exactly one `segment.upsert` with a fresh ordinal and `isFinal: true`.
The transcript is append-only; no segment is ever revised.

**Backpressure.** The `windowFrames`/rolling-drain machinery is removed. The worker keeps
a bounded queue of utterances awaiting transcription; when queue depth exceeds 3, or total
buffered audio exceeds 60 s, `push()` returns `{ accepted: false, reason: "backpressure" }`
and the existing `credit` message releases main-thread capacity as utterances complete.
The contract's backpressure semantics are unchanged — only what drives them changes.

### §5 Collapsing to a single engine

- `apps/web/src/features/transcription/engineFactory.ts` is deleted. `SessionController`
  already defaults to `new LocalWhisperEngine()`.
- `packages/transcription-contracts` is **retained**. Its types plus `validatePcmFrame` and
  `validateSessionRequest` are the genuine seam between worker, engine, and UI, and
  `testing/contractSuite.ts` still earns its place validating the one remaining engine.
  It sheds only cloud-specific pieces.
- The security/privacy boundary documented in `CLAUDE.md` (keeping `@google-cloud/speech`
  out of the browser bundle) becomes moot and is removed along with its verification step.

### §6 Deletion inventory

| Category | Removed |
|---|---|
| Workspaces | `apps/api/`, `packages/google-transcription-engine/` |
| Dependencies | `@huggingface/transformers`, `franc-min`, `@google-cloud/speech`, `ws` |
| Already-dead code | `src/cache/modelCache.ts`, `src/segmentation/languageLabeler.ts`, and their tests |
| Obsoleted by VAD | `windowFrames` logic, the rolling-revision transcribe path, `modelManifest.ts`'s HF fields |
| Cloud UI | `CloudConsentDialog.tsx`, `engineFactory.ts`, cloud branches in `sessionReducer`/`App`, cloud e2e paths |
| Docs | cloud sections of `CLAUDE.md` and `README.md`, `docs/agent-tasks/`, `report/` |

`inspectLocalCapabilities` is **not** deleted — it is rewritten (§2) into the precondition
check it was always meant to be.

### §7 Testing

The existing `WhisperRuntime` fake-seam pattern carries over unchanged: the worker
controller is driven against a fake runtime, so session-lifecycle tests need no WASM.

- `vadGate.test.ts` — new. The gate is pure, so synthetic probability sequences cover
  every transition exhaustively: blip below `min_speech_duration_ms`, normal utterance,
  silence exactly at threshold, the 25 s guard firing mid-speech, back-to-back utterances.
- `localWhisper.worker.test.ts` — updated for per-utterance segments and the new
  backpressure trigger.
- Language mapping — new tests covering detected-in-candidates, detected-outside-candidates
  (`und`), and low-probability detection.
- Playwright e2e — exercises the real WASM module against a short fixed audio fixture.
- Deleted: all `apps/api` tests, all `google-transcription-engine` tests,
  `languageLabeler.test.ts`, `modelCache.test.ts`, cloud-consent e2e.

`npm test` must remain runnable with no Emscripten toolchain installed. This is a hard
acceptance criterion, verified on Windows.

### §8 Documentation updates (required deliverable)

Documentation is part of "done", not a follow-up:

- **`README.md`** — rewritten: what the app is now (single local engine), the submodule
  clone step (`git clone --recurse-submodules`, and `git submodule update --init` for
  existing clones), the postinstall model fetch, the COOP/COEP hosting requirement, the
  manual whisper.cpp update procedure, and the emsdk-only-for-rebuilds note. All cloud
  setup instructions removed.
- **`CLAUDE.md`** — architecture map, commands, and build-order notes updated; the
  Google/browser security-boundary section and its `grep` verification removed; a new
  note that `wasm/` artifacts are committed and regenerated only on submodule bumps.
- **`packages/local-whisper-engine/README.md`** — VAD parameters and their tuning
  rationale, the bridge API surface, and how to rebuild the WASM.

## Risks

1. **Accuracy regression from `small` → `tiny`**, worst for `vi-VN` and `zh-CN`. Mitigation:
   the tier is one manifest constant. Measure with the existing benchmark harness before
   and after; if unacceptable, raise to `base` (~57 MB q5_1).
2. **Loss of GPU acceleration.** Mitigation: VAD gating removes most wasted inference.
   The existing `DEGRADED_PERFORMANCE` warning path stays as the user-visible signal.
3. **COOP/COEP misconfiguration in production** silently disables threading. Mitigation:
   `inspect()` reports it as an explicit unavailable-reason rather than degrading quietly.
4. **Emscripten build reproducibility.** Mitigation: pin the emsdk version in the build
   script and record it in the package README, since the committed artifacts are what
   actually ship.
5. **Cloud removal is irreversible in practice.** Mitigation: it is removed in its own
   commit, so the revert is a single `git revert`.

## Acceptance criteria

- `git clone --recurse-submodules && npm install && npm run dev` works with no Emscripten,
  no Google credentials, and no manual model download.
- No network request to `huggingface.co` occurs during a transcription session.
- Speaking, pausing ~0.5 s, then speaking again produces two separate final segments.
- A 30-second monologue with no pause produces segments via the 25 s guard, none dropped.
- Each segment carries either a candidate language tag with confidence, or `und`.
- `npm test`, `npm run typecheck`, and `npm run lint` pass at the repo root on Windows.
- `grep -ri "google-cloud\|huggingface\|franc-min" --exclude-dir=node_modules --exclude-dir=vendor .`
  returns nothing outside this spec and git history.
- README, CLAUDE.md, and the package README reflect the new system.
