# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
this repository.

## What this is

A multilingual transcription app with two explicit modes:

```text
Online real-time: microphone -> WSS -> native GPU Whisper -> revisions -> browser
Offline local:    microphone -> browser Worker -> WASM Whisper -> final-only browser text
```

Supported languages: Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`),
and Chinese (`zh-CN`). Speech stays in its original language.

Online mode streams 16 kHz PCM over `voice-transcription.v1` WebSockets to
`apps/transcription-server`, which runs a warm native whisper.cpp + Silero pool
and emits provisional segment revisions, then finals after silence. Offline mode
keeps audio in the browser with whisper.cpp v1.9.2 WASM and Silero VAD v6.2.0.
Browser model weights are fetched at install time from the app origin; server
models are provisioned separately. Audio/transcripts are in-memory only by
default (no persistence).

This is an npm workspaces monorepo (`apps/*`, `packages/*`). One root
`npm install` covers every workspace and runs the checksum-verified browser
model fetcher.

## Commands

Run from the repository root unless noted:

```bash
npm install                                    # install workspaces and fetch ~32 MB browser models
npm run fetch-models                           # verify/fetch models into apps/web/public/models
npm run dev --workspace @voice/web             # start the browser app
npm run build                                  # build all workspaces in explicit order
npm test                                       # build, then test all workspaces
npm run typecheck                              # build, then typecheck all workspaces
npm run lint                                   # lint workspaces that define a lint script

npm test --workspace @voice/web                # web Vitest suite
npm run test:watch --workspace @voice/web      # web Vitest watch mode
npm run test:e2e --workspace @voice/web        # Playwright browser tests
npm run benchmark --workspace @voice/web       # synthetic UI lifecycle timing

# Server / native (not part of ordinary CI)
npm run fetch-models --workspace @voice/transcription-server -- --model small
npm run build:native --workspace @voice/native-whisper-addon
npm run benchmark --workspace @voice/transcription-server -- --model small
```

Run a single Vitest file/case with the underlying runner from its workspace,
for example `npx vitest run path/to/file.test.ts`. Run a single Playwright case
from `apps/web` with `npx playwright test -g "<name>"`.

### Explicit build order

Root `build` is ordered so a clean checkout never consumes stale declarations:

1. `@voice/transcription-contracts`
2. `@voice/streaming-protocol`
3. `@voice/local-whisper-engine`
4. `@voice/remote-whisper-engine`
5. `@voice/native-whisper-addon` (TypeScript loader only)
6. `@voice/transcription-server`
7. `@voice/web`

`test` and `typecheck` already run `build` first. Ordinary builds do not invoke
CMake, load a native `.node` binary, or require a GPU. Injected fake runtimes
cover the native path in unit tests.

Committed `dist/` trees for TypeScript packages are consumed directly by other
workspaces. After editing `packages/transcription-contracts/src/**` (or other
shared packages), rebuild that package (or run root `npm run build`).

`npm run build:wasm --workspace @voice/local-whisper-engine` requires exactly
Emscripten 6.0.6 and is not part of normal development. The generated
`packages/local-whisper-engine/wasm/whisper-bridge.{js,wasm}` files are committed
build output. Regenerate and commit them only when deliberately bumping the
`vendor/whisper.cpp` submodule. Do not patch `vendor/whisper.cpp`; server C++
glue lives under `packages/native-whisper-addon/`. README files contain the
pinned Docker rebuild command for hosts without emsdk.

The web benchmark emits `TRANSCRIPTION_LIFECYCLE_TIMING` from injected worker
events. It times Start-to-provisional and Start-to-final UI rendering; it is not
an audio-inference, realtime-factor, language-ID, or accuracy benchmark. The
current recorded run is:

```text
TRANSCRIPTION_LIFECYCLE_TIMING {"firstProvisionalUiMs":1219,"finalUiMs":1303,"scope":"synthetic worker events; audio inference and accuracy are not measured"}
```

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, online/offline mode selection
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/streaming-protocol/
  Wire schemas and 656-byte PCM codec for voice-transcription.v1
packages/remote-whisper-engine/
  Browser WebSocket TranscriptionEngine (online real-time)
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed browser build output
packages/native-whisper-addon/
  N-API TypeScript loader + cmake-js native whisper/Silero runtime
apps/transcription-server/
  WSS gateway, admission, scheduler, warm decoder pool, metrics
scripts/fetch-models.mjs
  Install-time, checksum-verified browser model download
vendor/whisper.cpp/
  Git submodule pinned to whisper.cpp v1.9.2
```

### Engine contract

`packages/transcription-contracts/src/engine.ts` defines the browser engine
boundary used by both remote and local engines:

```ts
interface TranscriptionEngine {
  inspect(): Promise<EngineInspection>;
  prepare(request: SessionRequest): Promise<void>;
  open(request: SessionRequest): Promise<TranscriptionSession>;
  dispose(): Promise<void>;
}
interface TranscriptionSession {
  push(frame: PcmFrame): PushResult;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  subscribe(listener: EngineEventListener): () => void;
}
```

Change this contract first when changing cross-package session behavior, rebuild
the contracts package, then update local engine, remote engine, and web adapter.

### Online real-time flow

1. `apps/web` captures 16 kHz mono audio in 20 ms / 320-sample PCM frames.
2. `RemoteWhisperEngine` opens `voice-transcription.v1`, authenticates, and
   starts one session per socket.
3. Each frame is encoded as a fixed 656-byte binary message; `audio.ack`
   through-sequence semantics drive client backpressure.
4. The server VAD gates speech while the scheduler issues coalesced rolling
   provisional decodes, then a final decode after trailing silence.
5. Native model handles serialize one decode at a time; the pool leases warm
   handles and replaces unhealthy ones.
6. Multilingual models only — names ending in `.en` are rejected.

### Offline local engine flow

1. `apps/web` captures the same 16 kHz / 320-sample PCM frames.
2. `LocalWhisperEngine` owns the module worker and enforces session lifecycle and
   backpressure.
3. The worker converts PCM to float32 and regroups it into 512-sample / 32 ms
   Silero windows.
4. The native bridge preserves Silero's recurrent state and returns one speech
   probability per window.
5. `vadGate.ts` confirms speech, waits for trailing silence, pads the boundary,
   and flushes an utterance to `whisper_full`.
6. `languageMap.ts` maps Whisper's acoustic language result to a selected
   candidate or `und`, and the worker emits a final transcript segment.

The C++ surface in `packages/local-whisper-engine/native/bridge.cpp` is
deliberately small. Buffering, VAD policy, language policy, timeout handling,
and event sequencing remain in TypeScript so they can be unit-tested without a
WASM toolchain.

### apps/web internals

- `src/features/transcription/sessionController.ts` and `sessionReducer.ts`
  drive the session state machine and transcript state.
- `src/features/transcription/audio/` contains microphone capture and the
  AudioWorklet pipeline that creates contract-shaped PCM frames.
- `src/features/transcription/TranscriptionAdapter.tsx` constructs remote
  (default when `VITE_TRANSCRIPTION_WS_URL` is set) or local engines and bridges
  events into React UI state. Mode labels are **Online real-time** and
  **Offline local**.
- `vite.config.ts` supplies COOP/COEP headers for development and preview.
  Production hosting must send the same headers for offline WASM.

### Environment and privacy

- Browser: `VITE_TRANSCRIPTION_WS_URL`, optional `VITE_TRANSCRIPTION_TOKEN_URL`.
- Server: `VOICE_MODEL_PATH`, `VOICE_VAD_MODEL_PATH`, `VOICE_PORT`,
  `VOICE_MAX_SESSIONS`, `VOICE_ALLOWED_ORIGINS`, `VOICE_AUTH_TOKEN` (when auth
  required), optional `VOICE_BIND_HOST`, `VOICE_REQUIRE_AUTH`, `VOICE_THREADS`,
  `VOICE_USE_GPU`, `VOICE_METRICS_PATH`.
- Loopback development may disable auth only on `127.0.0.1` / `::1` /
  `localhost`. Production uses authenticated `wss:` plus origin allowlisting.
- No default persistence of audio or transcripts. Metrics/logs omit content.
- iPhone Safari scope is foreground-only. Siri/App Intents is a future entry
  point, not implemented here.

### packages/local-whisper-engine internals

- `src/LocalWhisperEngine.ts` owns worker startup, session backpressure, cleanup,
  and the shared engine contract.
- `src/worker/localWhisper.worker.ts` owns continuous buffering, VAD-driven
  utterance flushes, inference timeouts, and emitted engine events.
- `src/worker/vadGate.ts` is the pure, deterministic speech-boundary state
  machine.
- `src/worker/bridgeRuntime.ts` loads same-origin assets, copies samples into the
  WASM heap, and invokes the bridge with one inference thread. Real Chromium e2e
  testing showed nested pthread `whisper_full` stalling; keep the one-thread
  choice until a replacement has real-browser evidence.
- `native/bridge.cpp` wraps whisper.cpp and Silero VAD through embind. Neither
  path enables GPU acceleration.
- `wasm/` contains committed output generated from the pinned submodule and
  Emscripten toolchain.

## VAD and language limitations

- Whisper reports one language per utterance, not per word. Intra-utterance
  code-switching is therefore approximate, and unmatched language results map
  to `und`.
- VAD boundaries are probabilistic. Noise, overlapping speakers, quiet speech,
  and pauses can split or merge utterances.
- A 25-second guard force-splits an unbroken monologue below Whisper's 30-second
  encoder window.
- The offline quantized `tiny` model and CPU-only WASM build trade accuracy and
  latency for a small browser download. Do not imply GPU acceleration for the
  local engine or treat the synthetic lifecycle benchmark as inference
  performance. Server GPU tier selection remains pending a real reference-GPU
  comparison.

## Repository hygiene

- Preserve `docs/superpowers/` as historical design/implementation records.
- Preserve `.superpowers/` handoff and ledger state when present.
- Do not stage unrelated dirt inside `vendor/whisper.cpp`.
- Install-time browser model source URLs belong in `scripts/fetch-models.mjs`;
  the browser runtime should refer only to same-origin `/models/...` paths.
- Server model URLs/digests belong in the transcription-server provisioning
  scripts; never configure English-only `.en` Whisper weights.
