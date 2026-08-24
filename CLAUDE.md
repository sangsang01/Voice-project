# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
this repository.

## What this is

A multilingual transcription app with two modes:

```text
Live (this PC): microphone -> ws://127.0.0.1:8787 -> warm native Whisper -> provisional/final revisions -> UI
Offline local: microphone -> browser Worker -> WASM tiny Whisper -> final-only text
```

It supports Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`), and
Chinese (`zh-CN`) and keeps speech in its original language.

Live mode is a two-process loopback path: the browser sends 16 kHz PCM to
`apps/transcription-server` on `ws://127.0.0.1:8787` (subprotocol
`voice-transcription.v1`), and one warm native whisper.cpp handle returns
provisional then final revisions. The server binds loopback only, does not
persist transcripts, and rejects `.en` models.

Offline local is the existing WASM path: whisper.cpp v1.9.2 in a Web Worker,
Silero VAD v6.2.0 gating utterances, final-only text. Use it when the
transcription server is not running. Do not imply GPU acceleration for WASM.

This is an npm workspaces monorepo (`apps/*`, `packages/*`). One root
`npm install` covers every workspace and fetches **browser** WASM tiny into
`apps/web/public/models/`. It does **not** compile the native addon. Server
models are a separate fetch into `apps/transcription-server/models/`.

## Commands

Run from the repository root unless noted:

```bash
npm install                                    # install workspaces; fetch browser WASM models only
npm run fetch-models                           # verify/fetch models into apps/web/public/models
npm run dev:web                                # start the browser app
npm run dev:transcribe                         # start the loopback transcription server
npm run build                                  # build workspaces in dependency order
npm test                                       # build, then test all workspaces
npm run typecheck                              # build, then typecheck all workspaces
npm run lint                                   # lint workspaces that define a lint script

npm test --workspace @voice/web                # web Vitest suite
npm run test:watch --workspace @voice/web      # web Vitest watch mode
npm run test:e2e --workspace @voice/web        # Playwright browser tests
npm run benchmark --workspace @voice/web       # synthetic UI lifecycle timing
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
npm run benchmark --workspace @voice/transcription-server
```

Run a single Vitest file/case with the underlying runner from its workspace,
for example `npx vitest run path/to/file.test.ts`. Run a single Playwright case
from `apps/web` with `npx playwright test -g "<name>"`.

Committed `dist/` trees are consumed directly by other workspaces
(`transcription-contracts`, `streaming-protocol`, `remote-whisper-engine`,
`native-whisper-addon` TypeScript, `transcription-server`,
`local-whisper-engine`). After editing those packages' `src/**`, rebuild them
(or run the root `build` script). The root `test` and `typecheck` scripts
already build first.

`npm run build:wasm --workspace @voice/local-whisper-engine` requires exactly
Emscripten 6.0.6 and is not part of normal development. The generated
`packages/local-whisper-engine/wasm/whisper-bridge.{js,wasm}` files are committed
build output. Regenerate and commit them only when deliberately bumping the
`vendor/whisper.cpp` submodule. README files contain the pinned Docker rebuild
command for hosts without emsdk.

The web benchmark emits `TRANSCRIPTION_LIFECYCLE_TIMING` from injected worker
events. It times Start-to-provisional and Start-to-final UI rendering; it is not
an audio-inference, realtime-factor, language-ID, or accuracy benchmark. The
current recorded run is:

```text
TRANSCRIPTION_LIFECYCLE_TIMING {"firstProvisionalUiMs":1219,"finalUiMs":1303,"scope":"synthetic worker events; audio inference and accuracy are not measured"}
```

## Live (this PC) operator sequence

Windows PowerShell, from the repo root. Quote paths if the checkout contains
spaces (`Tài liệu`).

1. `npm install`
2. `npm run build:native --workspace @voice/native-whisper-addon`
3. `npm run fetch-models --workspace @voice/transcription-server -- --model small`
4. Set `VOICE_MODEL_PATH` and `VOICE_VAD_MODEL_PATH` to those files
5. `npm run dev:transcribe` (warm load; wait until the log says
   `listening on ws://127.0.0.1:8787`)
6. `npm run dev:web` and press Start

Native Windows build needs CMake plus a C++17 toolchain (Visual Studio Build
Tools or LLVM). Default CPU. `VOICE_USE_GPU=1` only after a CUDA/Vulkan
compile.

`VOICE_FAKE_RUNTIME=1` skips the native addon (CI/demo). A native decode
timeout recycles the handle: `close()` joins the current ggml graph via the
abort callback, then reloads weights once (recovery only).

Server benchmark `--model` only labels the JSON. Changing model requires
fetch → set `VOICE_MODEL_PATH` / `VOICE_VAD_MODEL_PATH` → restart the server
→ then `npm run benchmark --workspace @voice/transcription-server`. Gates:
`firstPartialP95Ms` ≤ 1500, `refreshP95Ms` ≤ 1000,
`finalAfterSilenceP95Ms` ≤ 1500. If CPU `small` fails, the operator reruns
with `--model base`; do not silently change the code default.

Client Origin env is `VOICE_ORIGIN`; server is `VOICE_ALLOWED_ORIGINS`.
Defaults both `http://localhost:5173`. `VOICE_THREADS` defaults to 4.
`VOICE_HOST` default `127.0.0.1`, `VOICE_PORT` default `8787`.

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, and session state
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/streaming-protocol/
  656-byte PCM codec, JSON control/event types, loopback URL rule
packages/remote-whisper-engine/
  Browser TranscriptionEngine over the loopback WebSocket
apps/transcription-server/
  Loopback gateway, session scheduling, mapping native results to EngineEvent
packages/native-whisper-addon/
  Persistent whisper.cpp + Silero Node-API addon (build:native, not npm install)
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed browser build output
scripts/fetch-models.mjs
  Install-time, checksum-verified browser model download
vendor/whisper.cpp/
  Git submodule pinned to whisper.cpp v1.9.2
```

### Engine contract

`packages/transcription-contracts/src/engine.ts` defines the browser engine
boundary:

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
the contracts package, and then update the local engine, remote engine, and web
adapter.

### Live path (two processes)

1. `apps/web` captures 16 kHz mono audio in 20 ms / 320-sample PCM frames.
2. With **Live (this PC)** selected, `RemoteWhisperEngine` opens
   `ws://127.0.0.1:8787` using subprotocol `voice-transcription.v1` and sends
   656-byte PCM messages. One session per socket. Credit comes from
   `audio.ack` (`throughSequence` is cumulative).
3. `apps/transcription-server` admits the Origin
   (`VOICE_ALLOWED_ORIGINS`), keeps one warm native handle, runs Silero VAD,
   and schedules rolling provisional decodes plus a final after silence.
4. `packages/native-whisper-addon` owns the whisper.cpp / Silero contexts.
   Process start is the warm load. A timeout closes the handle and reloads
   once; healthy `stop`/`cancel` call `reset()`, not unload.
5. If the server is down, the UI **Offline local** path uses
   `LocalWhisperEngine` instead.

### Local engine flow

1. `apps/web` captures 16 kHz mono audio in 20 ms / 320-sample PCM frames.
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

The C++ surface in `native/bridge.cpp` is deliberately small. Buffering, VAD
policy, language policy, timeout handling, and event sequencing remain in
TypeScript so they can be unit-tested without a WASM toolchain.

### apps/web internals

- `src/features/transcription/sessionController.ts` and `sessionReducer.ts`
  drive the session state machine and transcript state.
- `src/features/transcription/audio/` contains microphone capture and the
  AudioWorklet pipeline that creates contract-shaped PCM frames.
- `src/features/transcription/TranscriptionAdapter.tsx` constructs either the
  remote engine (Live) or the local WASM engine (Offline local) and bridges
  events into React UI state.
- `vite.config.ts` supplies COOP/COEP headers for development and preview.
  Production hosting must send the same headers.

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
- The quantized `tiny` model and CPU-only WASM build trade accuracy and latency
  for a small browser download. Do not imply GPU acceleration or treat the
  synthetic lifecycle benchmark as inference performance.

## Repository hygiene

- Preserve `docs/superpowers/` as historical design/implementation records.
- Preserve `.superpowers/` handoff and ledger state when present.
- Do not stage unrelated dirt inside `vendor/whisper.cpp`.
- Install-time **browser** model source URLs belong in `scripts/fetch-models.mjs`;
  the browser runtime should refer only to same-origin `/models/...` paths.
  Server model URLs belong in `apps/transcription-server/scripts/fetch-server-models.mjs`.
