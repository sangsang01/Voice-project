# Multilingual transcription (online real-time + offline local)

This app transcribes live microphone audio for Vietnamese (`vi-VN`), English
(`en-US`), Spanish (`es-ES`), and Chinese (`zh-CN`) and keeps speech in its
original language. It supports two explicit modes:

```text
Online real-time: microphone -> WSS -> native GPU Whisper -> revisions -> browser
Offline local:    microphone -> browser Worker -> WASM Whisper -> final-only browser text
```

**Online real-time** is the default when `VITE_TRANSCRIPTION_WS_URL` is set. Audio
leaves the device over authenticated WebSocket TLS; the server runs whisper.cpp
with Silero VAD, emits provisional segment revisions while you speak, and
finalizes after trailing silence. Audio and transcripts stay in memory for the
session and are not persisted by default.

**Offline local** keeps microphone audio and transcript text in the browser. It
uses whisper.cpp v1.9.2 compiled to WebAssembly plus Silero VAD v6.2.0 in a Web
Worker, and emits final-only segments (no rolling provisional revisions).

Browser WASM model weights are downloaded during `npm install`, served from the
app's own origin, and cached with the Cache API. A local transcription session
does not fetch models from a third-party host. Server GPU model weights are
provisioned separately (see below).

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, mode selection, session state
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/streaming-protocol/
  voice-transcription.v1 wire schemas and 656-byte PCM codec
packages/remote-whisper-engine/
  Browser WebSocket TranscriptionEngine for online real-time mode
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed whisper.cpp bridge build output used by the browser
packages/native-whisper-addon/
  N-API loader + native whisper.cpp/Silero runtime for the server
apps/transcription-server/
  WSS gateway, admission, session scheduler, decoder pool, metrics
scripts/fetch-models.mjs
  Install-time, checksum-verified browser model download into apps/web/public/models/
vendor/whisper.cpp/
  Git submodule pinned to whisper.cpp v1.9.2
```

The microphone always produces 20 ms frames of 16 kHz mono PCM (320 samples).
Online mode encodes each frame as a fixed 656-byte binary WebSocket message.
Offline mode keeps the same frames inside the browser Worker.

## Prerequisites

- Node.js 20.19+, 22.12+, or 24+, and npm.
- Git with submodule support.
- A current desktop Chromium browser (Chrome or Edge) with microphone access.
  Offline local also needs WebAssembly SIMD and cross-origin isolation.
- For online real-time development: a running transcription server with a
  provisioned multilingual model (native addon for real decode; ordinary unit
  tests inject a fake runtime instead of loading `.node`).
- For production GPU serving: CUDA-capable host/image, native addon build, and
  provisioned multilingual server models.
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

`npm install` runs the browser model fetcher through `postinstall`. It downloads
about 32 MB of weights into the gitignored `apps/web/public/models/` directory:

| File | Purpose | Approximate size |
| --- | --- | ---: |
| `ggml-tiny-q5_1.bin` | Quantized multilingual Whisper model (offline local) | 31 MB |
| `ggml-silero-v6.2.0.bin` | Silero VAD v6.2.0 | 885 kB |

Downloads are checked against pinned SHA-256 hashes. Re-run the fetch manually
with `npm run fetch-models`; already-valid files are reused.

Root `npm run build` compiles workspaces in a fixed order so a clean checkout
never depends on stale generated declarations: contracts → streaming-protocol →
local-whisper-engine → remote-whisper-engine → native-whisper-addon (TypeScript
loader only) → transcription-server → web. Ordinary builds do **not** compile
the native C++ addon or require a GPU.

## Modes and environment

### Online real-time (browser)

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_TRANSCRIPTION_WS_URL` | Yes for online mode | WebSocket endpoint (`wss:` in production; `ws://127.0.0.1:...` only for loopback development) |
| `VITE_TRANSCRIPTION_TOKEN_URL` | No | Token endpoint; defaults to `/api/transcription-token` |

When `VITE_TRANSCRIPTION_WS_URL` is unset, the UI defaults to **Offline local**
and disables **Online real-time**.

### Transcription server

| Variable | Required | Purpose |
| --- | --- | --- |
| `VOICE_MODEL_PATH` | Yes | Path to multilingual Whisper weights (basenames matching `*.en.bin` / `*.en-*` are rejected) |
| `VOICE_VAD_MODEL_PATH` | Yes | Path to Silero VAD weights |
| `VOICE_PORT` | Yes | HTTP/WebSocket listen port |
| `VOICE_MAX_SESSIONS` | Yes | Fixed warm decoder pool size / admission capacity |
| `VOICE_ALLOWED_ORIGINS` | Yes | Comma-separated browser origin allowlist |
| `VOICE_AUTH_TOKEN` | Yes when auth is required | Shared bearer token compared to the client token |
| `VOICE_BIND_HOST` | No | Defaults to `0.0.0.0`; use `127.0.0.1` for loopback development |
| `VOICE_REQUIRE_AUTH` | No | Defaults on; set `0` only with loopback bind |
| `VOICE_THREADS` | No | Native decode threads (default `4`) |
| `VOICE_USE_GPU` | No | Defaults on; set `0` to force CPU |
| `VOICE_METRICS_PATH` | No | Append-only JSONL metrics sink (no audio/transcript content) |

Production accepts authenticated `wss:` connections with an origin allowlist.
Development may use unauthenticated `ws:` only when bound to loopback
(`127.0.0.1` / `::1` / `localhost`); non-loopback unauthenticated binding is
refused. Audio and transcripts remain in memory and are released when the
session ends. Persistence is disabled by default. Logs and metrics use opaque
session IDs, timings, sizes, model version, and error codes only.

### Server models and native build

```bash
npm run fetch-models --workspace @voice/transcription-server -- --model small
# or
npm run fetch-models --workspace @voice/transcription-server -- --model medium

npm run build:native --workspace @voice/native-whisper-addon
npm run build:cuda-image --workspace @voice/transcription-server
npm run benchmark --workspace @voice/transcription-server -- --model small
```

English-only model basenames matching `*.en.bin` / `*.en-*` are prohibited. GPU
tier selection (`small` vs
`medium`) requires a real labeled benchmark on the reference GPU; until that
comparison runs, no production model tier is accepted from this worktree. See
`apps/transcription-server/README.md`.

## Run locally

Offline local only:

```bash
npm run dev --workspace @voice/web
```

Online real-time (loopback example): provision server models, build the native
addon when you want real Whisper, set the server env vars above with
`VOICE_BIND_HOST=127.0.0.1`, start the server, then start the web app with
`VITE_TRANSCRIPTION_WS_URL` pointing at the loopback WebSocket URL.

The browser always fetches a short-lived token from
`VITE_TRANSCRIPTION_TOKEN_URL` (default `/api/transcription-token`) before
opening the socket. That endpoint is **not** shipped in this repo — for local
online mode you must either:

1. Keep auth enabled (`VOICE_REQUIRE_AUTH` unset/on), set matching
   `VOICE_AUTH_TOKEN`, and serve a tiny token JSON endpoint that returns
   `{ "token": "<same value>" }` (Vite middleware, reverse proxy, or a
   one-line static handler), or
2. Point `VITE_TRANSCRIPTION_TOKEN_URL` at whatever issues that JSON.

Setting `VOICE_REQUIRE_AUTH=0` on loopback only skips **server** token
verification; the web client still requires a successful token fetch, so
option 1 or 2 remains necessary. Ordinary unit tests inject a fake native
runtime and do not load a `.node` binary.

Open the printed Vite URL, allow microphone access, select one to four candidate
languages, choose **Online real-time** or **Offline local**, and click **Start**.
Vite's development server supplies the cross-origin-isolation headers needed for
offline WASM.

## Client scope

The first client is the responsive web app on desktop browsers and iPhone Safari
while the page is in the foreground. Background mobile capture is not promised.
A future thin iOS companion may expose a Siri / App Intents entry point such as
"Start live transcript"; that remains a future entry point and is not
implemented in this repository.

## Production hosting

Build with:

```bash
npm run build
```

Deploy `apps/web/dist/` on a host that sends both headers on the document and
application assets (required for offline local WASM / `SharedArrayBuffer`):

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve the transcription server behind TLS so browsers use `wss:`. Keep
`VOICE_ALLOWED_ORIGINS` and short-lived session tokens aligned with the web
origin. With `Cross-Origin-Embedder-Policy: require-corp`, any cross-origin
assets you add must also opt in through CORS or an appropriate
`Cross-Origin-Resource-Policy` header.

## Commands

Run these from the repository root:

```bash
npm install                                    # install all workspaces and fetch browser models
npm run fetch-models                           # verify/fetch browser model files
npm run dev --workspace @voice/web             # start the browser app
npm run build                                  # build every workspace in explicit order
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

Do not patch `vendor/whisper.cpp` for the server path; native glue lives under
`packages/native-whisper-addon/`. The local WASM rebuild command requires
Emscripten 6.0.6. If it is unavailable, reproduce the build with the pinned
container image.

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

- Online mode sends audio off-device; use TLS, origin allowlisting, tokens, and
  the no-persistence policy. Offline mode keeps audio in the browser.
- The offline quantized `tiny` model favors download size and speed over
  accuracy, especially for accented speech, Vietnamese, and Chinese.
- Offline inference is CPU WebAssembly with no GPU acceleration and currently
  one inference thread after real Chromium pthread stalls.
- Whisper reports one language per utterance, not per word. Code-switching
  inside one utterance is not identified precisely, and speech outside the
  selected candidate languages is labeled `und`.
- Silero VAD boundaries are probabilistic. Noise, overlapping speakers, short
  pauses, and very quiet speech can merge, split, or miss utterances.
- An uninterrupted utterance is force-split at 25 seconds to stay below
  Whisper's 30-second encoder window.
- iPhone Safari support is foreground-only; Siri/App Intents is a future entry
  point only.
- This app is not a safety-, medical-, legal-, or accessibility-critical
  transcription guarantee.
