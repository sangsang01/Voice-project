# Localhost multilingual transcription

This app transcribes live microphone audio in a recent desktop Chromium browser.
It supports Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`), and
Chinese (`zh-CN`) and keeps speech in its original language.

There are two modes:

```text
Live (this PC): microphone -> ws://127.0.0.1:8787 -> warm native Whisper -> provisional/final revisions -> UI
Offline local: microphone -> browser Worker -> WASM tiny Whisper -> final-only text
```

**Live (this PC)** is the default. Audio stays on this machine: the browser
sends PCM to a loopback WebSocket, and a Node process runs whisper.cpp through
a native addon. The server does not persist transcripts and does not bind off
loopback.

**Offline local** is the browser-only fallback. whisper.cpp v1.9.2 compiled to
WebAssembly runs in a Web Worker, with Silero VAD v6.2.0 gating utterances.
Use it when the transcription server is not running. WASM inference is
CPU-only; there is no GPU acceleration on that path.

Browser WASM `tiny` weights are downloaded during `npm install` into
`apps/web/public/models/` and served from the app origin. Server models are a
separate fetch into `apps/transcription-server/models/`. A transcription
session does not fetch models from a third-party host.

Ordinary `npm install` does **not** compile the native addon.

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, and session state
  Live (this PC) uses remote-whisper-engine; Offline local uses the WASM worker
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/streaming-protocol/
  656-byte PCM codec, JSON control/event types, loopback URL rule
packages/remote-whisper-engine/
  Browser TranscriptionEngine over ws://127.0.0.1 (subprotocol voice-transcription.v1)
apps/transcription-server/
  Loopback WebSocket gateway, VAD, rolling decode, one warm native handle
packages/native-whisper-addon/
  Node-API whisper.cpp + Silero runtime (explicit build:native, not npm install)
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed whisper.cpp bridge build output used by the browser
scripts/fetch-models.mjs
  Install-time, checksum-verified browser model download into apps/web/public/models/
vendor/whisper.cpp/
  Git submodule pinned to whisper.cpp v1.9.2
```

The microphone produces 20 ms frames of 16 kHz mono PCM (320 samples,
little-endian). Live mode ships those frames as 656-byte WebSocket messages.
The native process runs Silero VAD, emits provisional revisions while speech
is open, and upserts a final after trailing silence. Offline local groups the
same PCM into Silero windows in the Worker and emits final-only segments.

## Prerequisites

- Node.js 20.19+, 22.12+, or 24+, and npm.
- Git with submodule support.
- A current desktop Chromium browser (Chrome or Edge) with microphone access,
  WebAssembly SIMD, and cross-origin isolation.
- For Live (this PC) on Windows: CMake and a C++17 toolchain (Visual Studio
  Build Tools or LLVM). The checkout path may contain spaces (`Tài liệu`).
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

`npm install` runs the browser model fetcher through `postinstall`. It
downloads about 32 MB of weights into the gitignored `apps/web/public/models/`
directory:

| File | Purpose | Approximate size |
| --- | --- | ---: |
| `ggml-tiny-q5_1.bin` | Quantized multilingual Whisper model (Offline local) | 31 MB |
| `ggml-silero-v6.2.0.bin` | Silero VAD v6.2.0 | 885 kB |

Downloads are checked against pinned SHA-256 hashes. Re-run the browser fetch
with `npm run fetch-models`; already-valid files are reused. That command does
not download server `small`/`base` weights.

## Live (this PC) on Windows

From the repository root, in PowerShell. Set the model env vars in the same
terminal that starts the server.

```powershell
npm install
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
$env:VOICE_MODEL_PATH = Join-Path (Get-Location) "apps\transcription-server\models\ggml-small.bin"
$env:VOICE_VAD_MODEL_PATH = Join-Path (Get-Location) "apps\transcription-server\models\ggml-silero-v6.2.0.bin"
npm run dev:transcribe
```

Wait until the server log prints `listening on ws://127.0.0.1:8787` (that is
the warm load). In a second terminal:

```powershell
npm run dev:web
```

Open the printed Vite URL, allow microphone access, select one to four
candidate languages, leave **Live (this PC)** selected, and click **Start**.
Vite's development server supplies the required cross-origin-isolation
headers. The browser Origin defaults to `http://localhost:5173`; the server
allows that origin via `VOICE_ALLOWED_ORIGINS`.

The server binds loopback only (`VOICE_HOST` default `127.0.0.1`,
`VOICE_PORT` default `8787`). It does not persist captions. `.en` model paths
are rejected. `VOICE_THREADS` defaults to 4. `VOICE_USE_GPU` is `0`/`1` and
defaults to `0`; set `1` only after compiling the addon with CUDA or Vulkan.

A native decode timeout closes the handle (abort callback, join the current
ggml graph) and reloads weights once. That is recovery only.

For CI or a demo without the C++ binary:

```powershell
$env:VOICE_FAKE_RUNTIME = "1"
npm run dev:transcribe
```

## Offline local

When the transcription server is not running, select **Offline local** in the
UI and click **Start**. The browser Worker loads same-origin WASM `tiny`
weights and emits final-only text. No loopback socket is opened.

## Production hosting

Build the static web app with:

```bash
npm run build
```

That script builds workspaces in dependency order (contracts, protocol, local
engine, remote engine, native TypeScript loader, transcription server, web).
It still does not compile the native `.node` addon.

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
`Cross-Origin-Resource-Policy` header. Without isolation, Offline local
reports that local transcription is unavailable. Live (this PC) still needs
the loopback server on the same machine; this repo does not ship a remote
hosted decoder.

## Commands

Run these from the repository root:

```bash
npm install                                    # install all workspaces; fetch browser WASM models only
npm run fetch-models                           # verify/fetch browser models into apps/web/public/models
npm run dev:web                                # start the browser app
npm run dev:transcribe                         # start the loopback transcription server
npm run build                                  # build every workspace in dependency order
npm test                                       # build, then test every workspace
npm run typecheck                              # build, then typecheck every workspace
npm run lint                                   # lint workspaces that define a lint script
npm run test:e2e --workspace @voice/web        # Playwright browser tests
npm run benchmark --workspace @voice/web       # synthetic UI lifecycle timing only
npm run benchmark --workspace @voice/transcription-server
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
```

`npm run benchmark --workspace @voice/web` prints a
`TRANSCRIPTION_LIFECYCLE_TIMING` record from injected worker events. It measures
the UI lifecycle from Start to provisional/final rendering. It does **not** run
audio inference and does not measure model speed, realtime factor, language
identification, or transcription accuracy. A current example run is:

```text
TRANSCRIPTION_LIFECYCLE_TIMING {"firstProvisionalUiMs":1219,"finalUiMs":1303,"scope":"synthetic worker events; audio inference and accuracy are not measured"}
```

The transcription-server benchmark talks to an already-running live server.
`--model` only labels the JSON. To change the model: fetch weights, set
`VOICE_MODEL_PATH` / `VOICE_VAD_MODEL_PATH`, restart the server, then rerun
the benchmark. Gates: `firstPartialP95Ms` ≤ 1500, `refreshP95Ms` ≤ 1000,
`finalAfterSilenceP95Ms` ≤ 1500. If CPU `small` fails, rerun with
`--model base` after pointing the server at `ggml-base.bin`. Do not change
the code default.

The benchmark client Origin is `VOICE_ORIGIN` (default
`http://localhost:5173`).

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
install, test, or application work. Do not patch `vendor/whisper.cpp` for the
native addon.

## Known limitations

- Live (this PC) uses server `small` (or operator-selected `base`/`medium`)
  on this machine's CPU unless the addon was compiled for GPU. Offline local
  uses quantized WASM `tiny`, which favors download size over accuracy,
  especially for accented speech, Vietnamese, and Chinese.
- WASM inference is CPU WebAssembly with no GPU acceleration. The runtime
  currently invokes the bridge with one inference thread because nested
  Chromium pthread inference stalled in real browser testing; slower devices
  can have noticeable latency.
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
