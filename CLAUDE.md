# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
this repository.

## What this is

A browser-only multilingual transcription app. It supports Vietnamese
(`vi-VN`), English (`en-US`), Spanish (`es-ES`), and Chinese (`zh-CN`) and keeps
speech in its original language.

There is one engine: whisper.cpp v1.9.2 compiled to WebAssembly. It runs in a
Web Worker, while Silero VAD v6.2.0 gates the continuous microphone stream into
utterances before inference. Audio and transcript text stay in the browser.
Model weights are fetched at install time, served from the app's own origin,
and never fetched from a third party during a transcription session.

This is an npm workspaces monorepo (`apps/*`, `packages/*`). One root
`npm install` covers every workspace and runs the checksum-verified model
fetcher.

## Commands

Run from the repository root unless noted:

```bash
npm install                                    # install workspaces and fetch ~32 MB of models
npm run fetch-models                           # verify/fetch models into apps/web/public/models
npm run dev --workspace @voice/web             # start the browser app
npm run build                                  # build all workspaces
npm test                                       # build, then test all workspaces
npm run typecheck                              # build, then typecheck all workspaces
npm run lint                                   # lint workspaces that define a lint script

npm test --workspace @voice/web                # web Vitest suite
npm run test:watch --workspace @voice/web      # web Vitest watch mode
npm run test:e2e --workspace @voice/web        # Playwright browser tests
npm run benchmark --workspace @voice/web       # synthetic UI lifecycle timing
```

Run a single Vitest file/case with the underlying runner from its workspace,
for example `npx vitest run path/to/file.test.ts`. Run a single Playwright case
from `apps/web` with `npx playwright test -g "<name>"`.

`packages/transcription-contracts/dist/` is committed and consumed directly by
the other workspaces. After editing `packages/transcription-contracts/src/**`,
run:

```bash
npm run build --workspace @voice/transcription-contracts
```

The root `test` and `typecheck` scripts already build first.

`npm run build:wasm --workspace @voice/local-whisper-engine` requires exactly
Emscripten 6.0.6 and is not part of normal development. The generated
`packages/local-whisper-engine/wasm/whisper-bridge.{js,wasm}` files are committed
build output. Regenerate and commit them only when deliberately bumping the
`vendor/whisper.cpp` submodule. README files contain the pinned Docker rebuild
command for hosts without emsdk.

The benchmark emits `TRANSCRIPTION_LIFECYCLE_TIMING` from injected worker
events. It times Start-to-provisional and Start-to-final UI rendering; it is not
an audio-inference, realtime-factor, language-ID, or accuracy benchmark. The
current recorded run is:

```text
TRANSCRIPTION_LIFECYCLE_TIMING {"firstProvisionalUiMs":1219,"finalUiMs":1303,"scope":"synthetic worker events; audio inference and accuracy are not measured"}
```

## Architecture

```text
apps/web/
  React/Vite UI, microphone capture, 16 kHz PCM framing, and session state
packages/transcription-contracts/
  Shared TypeScript engine/session contracts and validators
packages/local-whisper-engine/
  Worker controller, Silero VAD gate, language mapping, and C++/WASM bridge
  wasm/
    Committed browser build output
scripts/fetch-models.mjs
  Install-time, checksum-verified model download
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
the contracts package, and then update the local engine and web adapter.

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
- `src/features/transcription/TranscriptionAdapter.tsx` constructs the one local
  engine and bridges its events into React UI state.
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
- Install-time model source URLs belong in `scripts/fetch-models.mjs`; the
  browser runtime should refer only to same-origin `/models/...` paths.
