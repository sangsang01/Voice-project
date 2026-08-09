# Browser-only multilingual transcription

This app transcribes live microphone audio in a recent desktop Chromium browser.
It supports Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`), and
Chinese (`zh-CN`) and keeps speech in its original language.

There is one transcription engine: [whisper.cpp v1.9.2](https://github.com/ggml-org/whisper.cpp)
compiled to WebAssembly, with Silero VAD v6.2.0 deciding when an utterance is
ready to transcribe. The engine runs in a Web Worker. Microphone audio and
transcript text stay in the browser; there is no transcription server or
runtime upload path.

Model weights are downloaded during `npm install`, served by the web app from
its own origin, and cached with the browser Cache API. A transcription session
does not fetch models from a third-party host.

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, and session state
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed whisper.cpp bridge build output used by the browser
scripts/fetch-models.mjs
  Install-time, checksum-verified model download into apps/web/public/models/
vendor/whisper.cpp/
  Git submodule pinned to whisper.cpp v1.9.2
```

The microphone produces 20 ms frames of 16 kHz mono PCM. The worker converts
them to float32, groups them into Silero's 512-sample windows, and turns the
speech probabilities into utterance boundaries. Completed utterances go
through the whisper.cpp WASM bridge, which emits final transcript segments and
one detected language per utterance.

## Prerequisites

- Node.js 20.19+, 22.12+, or 24+, and npm.
- Git with submodule support.
- A current desktop Chromium browser (Chrome or Edge) with microphone access,
  WebAssembly SIMD, and cross-origin isolation.
- Docker, or Emscripten 6.0.6 on `PATH`, only when deliberately rebuilding the
  committed WASM artifacts.

## Clone and install

Clone recursively so the whisper.cpp submodule is populated:

```bash
git clone --recurse-submodules <repository-url>
cd voice-project
npm install
```

If the repository was cloned without submodules, initialize them before
building:

```bash
git submodule update --init --recursive
npm install
```

`npm install` runs the model fetcher through `postinstall`. It downloads about
32 MB of weights into the gitignored `apps/web/public/models/` directory:

| File | Purpose | Approximate size |
| --- | --- | ---: |
| `ggml-tiny-q5_1.bin` | Quantized multilingual Whisper model | 31 MB |
| `ggml-silero-v6.2.0.bin` | Silero VAD v6.2.0 | 885 kB |

Downloads are checked against pinned SHA-256 hashes. Re-run the fetch manually
with `npm run fetch-models`; already-valid files are reused.

## Run locally

```bash
npm run dev --workspace @voice/web
```

Open the printed Vite URL, allow microphone access, select one to four candidate
languages, and click **Start**. Vite's development server supplies the required
cross-origin-isolation headers.

## Production hosting

Build the static web app with:

```bash
npm run build
```

Deploy `apps/web/dist/` on a host that sends both headers on the document and
application assets:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The WASM build uses pthread support and therefore requires
`SharedArrayBuffer`, which Chromium exposes only to a cross-origin-isolated
page. With `Cross-Origin-Embedder-Policy: require-corp`, any cross-origin assets
you add must also opt in through CORS or an appropriate
`Cross-Origin-Resource-Policy` header. Without isolation the app reports that
local transcription is unavailable.

## Commands

Run these from the repository root:

```bash
npm install                                    # install all workspaces and fetch models
npm run fetch-models                           # verify/fetch the two model files
npm run dev --workspace @voice/web             # start the browser app
npm run build                                  # build every workspace
npm test                                       # build, then test every workspace
npm run typecheck                              # build, then typecheck every workspace
npm run lint                                   # lint workspaces that define a lint script
npm run test:e2e --workspace @voice/web        # Playwright browser tests
npm run benchmark --workspace @voice/web       # synthetic UI lifecycle timing only
```

`npm run benchmark --workspace @voice/web` prints a
`TRANSCRIPTION_LIFECYCLE_TIMING` record from injected worker events. It measures
the UI lifecycle from Start to provisional/final rendering. It does **not** run
audio inference and does not measure model speed, realtime factor, language
identification, or transcription accuracy. A current example run is:

```text
TRANSCRIPTION_LIFECYCLE_TIMING {"firstProvisionalUiMs":1219,"finalUiMs":1303,"scope":"synthetic worker events; audio inference and accuracy are not measured"}
```

## Updating whisper.cpp and the WASM bridge

The submodule and committed WASM output never update automatically. On a
deliberate upstream bump:

```bash
git -C vendor/whisper.cpp fetch --tags
git -C vendor/whisper.cpp checkout <new-tag>
npm run build:wasm --workspace @voice/local-whisper-engine
npm test
git add vendor/whisper.cpp packages/local-whisper-engine/wasm
git commit -m "chore: update whisper.cpp to <new-tag>"
```

The local rebuild command requires Emscripten 6.0.6. If it is unavailable,
reproduce the build with the pinned container image.

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

Review and commit both regenerated files in
`packages/local-whisper-engine/wasm/`. Do not rebuild them during ordinary
install, test, or application work.

## Known limitations

- The quantized `tiny` model favors download size and speed over accuracy,
  especially for accented speech, Vietnamese, and Chinese.
- Inference is CPU WebAssembly with no GPU acceleration. The runtime currently
  invokes the bridge with one inference thread because nested Chromium pthread
  inference stalled in real browser testing; slower devices can have noticeable
  latency.
- Whisper reports one language per utterance, not per word. Code-switching
  inside one utterance is not identified precisely, and speech outside the
  selected candidate languages is labeled `und`.
- Silero VAD boundaries are probabilistic. Noise, overlapping speakers, short
  pauses, and very quiet speech can merge, split, or miss utterances.
- An uninterrupted utterance is force-split at 25 seconds to stay below
  Whisper's 30-second encoder window.
- Microphone capture requires browser permission, and the shipped build targets
  current desktop Chromium rather than every browser or mobile device.
- This app is not a safety-, medical-, legal-, or accessibility-critical
  transcription guarantee.
