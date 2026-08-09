# @voice/local-whisper-engine

This package implements the shared `TranscriptionEngine` contract with
whisper.cpp v1.9.2 compiled to WebAssembly and Silero VAD v6.2.0. It runs in a
Web Worker; microphone audio and transcript text never leave the browser.

The browser loads model files from the application's own `/models` path. The
root install script downloads and verifies those files before the app runs, so
a transcription session performs no third-party model fetch.

## Session flow

1. The web microphone pipeline pushes 20 ms frames containing 320 samples of
   16 kHz mono signed PCM.
2. The worker converts each frame to normalized float32 and carries partial
   data across pushes until it has one or more 512-sample Silero windows.
3. The bridge calls `whisper_vad_detect_speech_no_reset`. Keeping the VAD state
   is important for a continuous microphone stream; the returned probabilities
   describe consecutive 32 ms windows rather than unrelated clips.
4. `vadGate.ts` converts the probabilities into deterministic utterance
   boundaries. Audio stays buffered until the gate flushes on trailing silence,
   an explicit stop, or the maximum-duration guard.
5. The selected, padded utterance goes to `whisper_full` with translation off
   and automatic acoustic language detection.
6. `languageMap.ts` maps the detected language to one of the request's candidate
   languages or `und`. The worker emits one final, append-only segment.
7. Transcribed audio is trimmed and buffer credit returns to the browser-side
   session. Stop drains pending speech; cancel aborts and releases the session.

## VAD parameters

The shipped defaults in `src/worker/vadGate.ts` are:

| Parameter | Exact value | Rationale |
| --- | ---: | --- |
| `threshold` | `0.5` | A Silero probability at or above this value counts as speech. |
| `minSpeechMs` | `250` ms | Rejects short clicks, coughs, and isolated probability spikes. |
| `minSilenceMs` | `500` ms | Treats sustained trailing silence as the end of an utterance without cutting most clause pauses. |
| `maxSpeechMs` | `25_000` ms | Force-flushes unbroken speech below Whisper's 30-second encoder window. |
| `speechPadMs` | `100` ms | Keeps context around both detected edges to reduce clipped word onsets and endings. |
| `windowMs` | `32` ms | Fixed by 512 samples at the 16 kHz input rate. |

Raising `minSilenceMs` produces longer utterances and slower feedback. Lowering
it makes feedback faster but increases mid-sentence fragmentation. The 500 ms
default is the current compromise. VAD remains probabilistic: noise, pauses,
overlapping speakers, and quiet speech can change the detected boundaries.

Silero VAD has versions rather than model-size tiers; this package pins v6.2.0.

## WASM bridge API

`native/bridge.cpp` is the complete C++/embind surface:

| Method | Purpose |
| --- | --- |
| `init(modelPtr, modelLen, vadPath, nThreads)` | Loads Whisper from the supplied WASM heap buffer and Silero from MEMFS with GPU use disabled. |
| `vadProbs(samplesPtr, sampleCount)` | Runs stateful Silero VAD and returns the number of available probabilities. |
| `probsPtr()` | Returns the temporary pointer to the probability vector; JavaScript copies it before the next VAD call. |
| `vadReset()` | Resets Silero's recurrent state when explicitly requested. |
| `transcribe(samplesPtr, sampleCount, nThreads)` | Runs greedy, non-translating, single-segment `whisper_full` and returns text plus the detected language. |
| `release()` | Frees both native contexts. |

Policy stays in TypeScript: buffering, VAD thresholds, utterance boundaries,
candidate-language mapping, timeouts, backpressure, and event sequencing are
unit-testable without compiling WASM.

The 30-second inference watchdog runs in `LocalWhisperEngine` on the main-window
event loop. The worker reports inference start and finish around the synchronous
Embind call; if `whisper_full` blocks, the main window can still terminate that
worker and emit a fatal `TIMEOUT`. A timer inside the inference worker cannot
provide that guarantee because the synchronous WASM call blocks its event loop.

The Emscripten output supports pthreads, but the browser runtime currently calls
both bridge initialization and inference with one thread. Real Chromium e2e
testing found nested pthread `whisper_full` stalling after a VAD flush, while
the one-thread call completed through the same real WASM path. Do not increase
that count without real-browser evidence. This build has no GPU acceleration.

## Committed WASM and reproducible rebuilds

`wasm/whisper-bridge.js` and `wasm/whisper-bridge.wasm` are committed build
output. Ordinary installs, builds, and tests consume them as-is. Regenerate
them only when deliberately updating the `vendor/whisper.cpp` submodule, which
is currently pinned to v1.9.2.

The rebuild script rejects every Emscripten version except 6.0.6:

```bash
npm run build:wasm --workspace @voice/local-whisper-engine
```

When local emsdk is unavailable, run the same script in the digest-pinned image.

Bash:

```bash
docker run --rm --mount "type=bind,src=$PWD,dst=/src" -w /src \
  emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef \
  node packages/local-whisper-engine/scripts/build-wasm.mjs
```

PowerShell:

```powershell
docker run --rm --mount "type=bind,src=$((Get-Location).Path),dst=/src" -w /src `
  emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef `
  node packages/local-whisper-engine/scripts/build-wasm.mjs
```

After either rebuild, review and commit the regenerated `.js` and `.wasm`
files together with the new submodule pointer.
