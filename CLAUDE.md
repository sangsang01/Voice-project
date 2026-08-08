# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multilingual realtime transcription app: transcribes live microphone audio in up
to four languages at once (`vi-VN`, `en-US`, `es-ES`, `zh-CN`), keeping spoken text
as-is rather than translating it. Two interchangeable transcription engines sit
behind one shared contract:

- **Local (default).** Quantized Whisper running entirely in-browser
  (WebGPU, falling back to WebAssembly). Audio never leaves the device.
- **Cloud (opt-in).** Audio streams to a self-hosted WebSocket gateway
  (`apps/api`), which forwards it to Google Cloud Speech-to-Text. Requires
  running `apps/api` and Google credentials; never enabled by default and
  always requires an explicit on-screen consent click before use.

This is an npm workspaces monorepo (`apps/*`, `packages/*`); one `npm install`
at the repo root covers everything.

## Commands

Run from the repository root unless noted:

```bash
npm install                                    # one install covers apps/* and packages/*
npm test                                       # builds, then runs tests across all workspaces (188 tests)
npm run typecheck                              # builds, then typechecks all workspaces
npm run lint                                   # lints all workspaces
npm run build                                  # builds all workspaces

npm run dev --workspace @voice/web             # start the web app (local engine, no other setup needed)
npm run start --workspace @voice/api           # start the optional cloud gateway (needs .env + Google ADC)

npm test --workspace @voice/web                # single workspace test run (vitest run)
npm run test:watch --workspace @voice/web      # vitest watch mode
npm run test:e2e --workspace @voice/web        # Playwright e2e (fake mic/worker seams, no real mic needed)
npm run benchmark --workspace @voice/web       # Playwright, prints a TRANSCRIPTION_BENCHMARK JSON record
```

To run a single test file/case, use the underlying test runner directly inside
the workspace directory, e.g. `npx vitest run path/to/file.test.ts` (apps/web,
apps/api, packages/*) or `npx playwright test -g "<name>"` (apps/web e2e).

**Build order matters.** `packages/transcription-contracts` ships a committed
`dist/` that other workspaces consume directly. If you edit
`packages/transcription-contracts/src/**`, rebuild it before other workspaces
will pick up the change: `npm run build --workspace @voice/transcription-contracts`.
The root `test`/`typecheck` scripts already run `npm run build` first for this
reason.

**Verifying the browser bundle stays server-code-free** (the cloud engine's
Google SDK usage must never reach the browser):

```bash
npm run build --workspace @voice/web
grep -r "google-cloud" apps/web/dist/   # must print nothing
```

`apps/api` and `packages/google-transcription-engine` tests run entirely
against injected fakes (`test/helpers/*`) — no network access or Google
credentials needed.

## Architecture

```
apps/web        React app. Captures the mic, renders the transcript, and
                 chooses which engine to run against (local or cloud).
packages/local-whisper-engine
                 In-browser Whisper (WebGPU/WASM), runs in a Web Worker.
packages/google-transcription-engine
                 Two entrypoints: /browser (WebSocket client, no Google SDK)
                 and /server (wraps @google-cloud/speech; apps/api only).
apps/api         Optional Node WebSocket gateway. Only place that ever
                 talks to Google or holds Google credentials.
packages/transcription-contracts
                 The shared TranscriptionEngine/TranscriptionSession
                 TypeScript contract + validation both engines implement.
```

### The shared engine contract

Both engines implement the exact same `TranscriptionEngine` contract
(`packages/transcription-contracts/src/engine.ts`):

```ts
interface TranscriptionEngine {
  inspect(): Promise<EngineInspection>;      // { available, reason? }
  prepare(request: SessionRequest): Promise<void>;
  open(request: SessionRequest): Promise<TranscriptionSession>;
  dispose(): Promise<void>;
}
interface TranscriptionSession {
  push(frame: PcmFrame): PushResult;         // { accepted: true } | { accepted: false, reason: "backpressure" }
  stop(): Promise<void>;
  cancel(): Promise<void>;
  subscribe(listener: EngineEventListener): () => void;
}
```

Because both engines honor this contract, `apps/web` never has special-case
logic per engine — it just constructs whichever one the user picked. The
single place that choice is made is
`apps/web/src/features/transcription/engineFactory.ts`. When adding a new
engine or changing session behavior, change the contract in
`packages/transcription-contracts` first (rebuild it), then update both
engines to match.

### Security/privacy boundary: keep Google code server-side

`@google-cloud/speech` must only ever be imported by `apps/api` (specifically
`apps/api/src/index.ts`, via `createProductionSpeechClientFactory` from
`@voice/google-transcription-engine/server`). The browser only ever imports
`@voice/google-transcription-engine/browser` (`CloudEngineClient`), which
speaks WebSocket/JSON to the gateway and never touches the Google SDK or
credentials. This split is enforced by convention, not by tooling — always
verify with the `grep -r "google-cloud" apps/web/dist/` check above after
touching anything in this area.

The gateway (`apps/api`) never persists audio or transcript text; its only
logging is session IDs, durations, frame counts, and generic error codes. It
ships with **no authentication of its own** — it's meant for local dev or a
deployment already sitting behind auth (reverse proxy, authenticated LB).

### apps/api internals

- `src/config.ts` — reads/validates env limits (idle timeout, hard timeout,
  max buffered audio, max concurrent sessions); invalid config refuses to
  start rather than running with a weaker limit.
- `src/websocket/protocol.ts` — authoritative validation for the WebSocket
  JSON + binary protocol (`session.start`/`session.stop`/`session.cancel`/
  `session.ping`, fixed 640-byte PCM frames).
- `src/websocket/sessionLimits.ts`, `src/websocket/transcriptionHandler.ts` —
  per-connection session lifecycle and enforcement of the config limits.
- `src/server.ts` / `src/index.ts` — server wiring; `index.ts` is the only
  file that constructs the real Google client.

### apps/web internals

- `src/features/transcription/engineFactory.ts` — chooses local vs. cloud engine.
- `src/features/transcription/sessionController.ts` + `sessionReducer.ts` —
  drive a transcription session's state machine against whichever engine
  was constructed.
- `src/features/transcription/audio/` — `microphone.ts` (getUserMedia),
  `pcm.ts`/`pcm-worklet.ts` (AudioWorklet PCM framing to match the 640-byte/
  20ms frame contract both engines expect).
- `src/features/transcription/CloudConsentDialog.tsx` — the mandatory
  on-screen consent step before any audio can be routed to the cloud engine.
- `src/features/transcription/TranscriptionAdapter.tsx` — bridges engine
  events into UI state.

### Known upstream limitations worth knowing before changing language handling

Both engines produce window-level provisional/final segments, not
guaranteed word-level language ID, and label a segment `und` when confidence
is insufficient. Google's V1 `streamingRecognize` in particular: reports one
language per result (no true intra-sentence code-switching detection),
reuses transcript confidence as a rough stand-in for language confidence,
approximates segment start time from the previous result's end time, and
caps `alternativeLanguageCodes` at three — which is why the app limits
language selection to four candidates total (one primary + three
alternatives). Full detail in `apps/api/README.md` and
`packages/google-transcription-engine/README.md`.

## Cloud transcription local setup (only needed to touch that path)

```bash
gcloud auth application-default login          # writes local ADC, never commit it
cp apps/api/.env.example apps/api/.env         # set ALLOWED_ORIGINS to the web app's origin
npm run start --workspace @voice/api           # logs {"event":"listening","port":8080}
```

Then in the web app, click **Use cloud transcription**, accept the consent
dialog. `VITE_TRANSCRIPTION_WS_URL` (in `apps/web/.env.local`) overrides the
default `ws://localhost:8080` gateway address.

## Docs

- `docs/agent-tasks/` — the original two-agent execution runbook (task specs
  and integration plan) used to build this project's engines in parallel.
  Historical/planning context, not living documentation.
- `report/` — agent completion reports referenced from project memory.
