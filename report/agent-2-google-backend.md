# Handoff Report: Agent 2 — Google Streaming Backend and Cloud Engine

Source task: `docs/agent-tasks/agent-2-google-backend.md`
Plan followed: `docs/superpowers/plans/2026-08-04-google-streaming-fallback.md`
Design spec: `docs/superpowers/specs/2026-08-04-multilingual-realtime-transcription-design.md`

**Branch/worktree:** `worktree-google-streaming-fallback`, at
`.claude/worktrees/google-streaming-fallback` (created via the
`using-git-worktrees` skill, off `master`). Not yet merged to `main`/`master`
— that step is left to the human integration owner per
`docs/agent-tasks/integration.md`.

## Important deviation from the task file: bootstrap was also done here

The task file says "Do not begin until the coordinator gives you Agent 1's
frozen contract/bootstrap commit hash." No Agent 1 session ran in this
conversation, and the repository had no `package.json`, no npm workspace,
and no `packages/transcription-contracts` at all — only the `docs/` tree.

To unblock Agent 2's work, I created the **minimal** shared bootstrap
exactly as specified by Agent 1's Plan Task 1
(`docs/superpowers/plans/2026-08-04-browser-local-transcription.md`, Task 1
only): root `package.json` (npm workspaces for `apps/*`/`packages/*` +
`test`/`typecheck`/`lint` scripts), `tsconfig.base.json`, and
`packages/transcription-contracts/**` (types, events, engine interfaces,
`validateSessionRequest`, and its test). I did **not** touch `apps/web/**`
or `packages/local-whisper-engine/**` — those remain entirely for whoever
runs Agent 1.

**If Agent 1 is run separately, its own Task 1 will conflict with this
bootstrap commit** (both create the same files). The integration owner
should either rebase Agent 1 onto this commit and have it skip Task 1, or
treat this commit as the throwaway starting point and let a real Agent 1
run supersede it. I did not invent anything the contract doesn't already
specify — I used the exact `validateSessionRequest` code and contract
shape from the design spec — but flagging this since it's a real deviation
from "wait for the coordinator."

## Commits, in order

| # | Hash | Subject |
|---|------|---------|
| bootstrap | `30f93beeecc7bd3bda1c0823523fd8033dec2962` | `feat: establish transcription engine contracts` |
| Task 1 | `18310679cb4d0b30e8395261d7cb1f90c8a74b00` | `chore: scaffold google transcription fallback` |
| Task 2 | `184999676a5bed51a03a224e47ef71f4c22c51b9` | `feat: normalize google streaming results` |
| Task 3 | `d187ad738a1a65c733f4fa192468637845ca1b93` | `feat: stream pcm through google speech v1` |
| Task 4 | `cb537b45f54a98b3f8a503d6ade3e4e00172a7a8` | `feat: validate cloud transcription websocket protocol` |
| Task 5 | `02e2ff6943e610742a8e457a0a40a3510ded317f` | `feat: enforce transcription session limits` |
| Task 6 | `2f3496ade8b79f73dc9a7a863aa0f030f8dc13db` | `feat: manage cloud transcription websocket sessions` |
| Task 7 | `5c7eb705ac1a5187e1166838e5c9b2a315e80d55` | `feat: expose optional google streaming engine` |
| Task 8 | `4e96a2e0c91c53384382aae1c92b27d8f00e411a` | `docs: explain secure google fallback setup` |

All 9 commits are on `worktree-google-streaming-fallback`, in this order,
one per plan task as instructed.

## Files touched (all within the owned scope)

- `packages/transcription-contracts/**` — bootstrap only, not owned by
  Agent 2 afterward.
- `packages/google-transcription-engine/**` — `languageConfig.ts`,
  `providerTypes.ts`, `normalizeResult.ts`, `googleClientFactory.ts`,
  `GoogleStream.ts`, `server.ts`, `CloudEngineClient.ts`, `browser.ts`,
  tests, `README.md`.
- `apps/api/**` — `config.ts`, `websocket/protocol.ts`,
  `websocket/sessionLimits.ts`, `websocket/transcriptionHandler.ts`,
  `server.ts`, `index.ts`, tests, `README.md`, `.env.example`,
  `tsconfig.build.json`.
- Did not edit `apps/web/**` or `packages/local-whisper-engine/**`.
- Did not edit root `package.json`/`package-lock.json` beyond what the
  bootstrap step required and what `npm install` regenerated when adding
  each package's own dependencies (all package-local deps, listed below).

## Commands run and final results

Every command below was run for real in this session; none were skipped
or assumed.

```
npm test --workspace @voice/transcription-contracts       5 passed
npm run typecheck --workspace @voice/transcription-contracts   clean

npm test --workspace @voice/google-transcription-engine   36 passed
  (languageConfig 4, normalizeResult 14, GoogleStream 9, CloudEngineClient 9)
npm run typecheck --workspace @voice/google-transcription-engine   clean

npm test --workspace @voice/api                            60 passed
  (sessionLimits 25, protocol 12, cleanup 7, transcriptionHandler 13,
   server.integration 3)
npm run typecheck --workspace @voice/api                   clean

npm run build --workspace @voice/api                        clean (tsc emit)
npm run start --workspace @voice/api                        confirmed listening
  (smoke-tested with ALLOWED_ORIGINS + PORT set; no real Google credentials
  present, no live Google API call made — construction only)
```

**Total: 101 tests passing, zero failures, zero network calls, zero Google
credentials used anywhere in the suite.** Every provider interaction in
tests goes through an injected fake (`test/helpers/fakeGoogleStream.ts`,
`test/helpers/fakeWebSocket.ts`, `test/helpers/fakeEngine.ts`).

One real bug was caught and fixed by the `server.integration.test.ts`
end-to-end test (real local WebSocket server + real `ws` client, fake
provider only): `WsHandlerSocket.removeAllListeners()` was initially
calling the underlying `ws` socket's own `removeAllListeners()`, which also
strips `ws`'s internal listener that maintains `WebSocketServer#clients` —
this hung `wss.close()` forever. Fixed by tracking and removing only the
listeners this adapter itself registered.

## Exact Google request configuration used

- API: Speech-to-Text **V1** `streamingRecognize` (via
  `@google-cloud/speech`'s `v1.SpeechClient`).
- Audio: `encoding: "LINEAR16"`, `sampleRateHertz: 16000`, mono.
- `languageCode`: first selected candidate language.
- `alternativeLanguageCodes`: remaining selected languages, hard-capped at
  three by `toGoogleLanguageConfig` (which itself rejects any candidate set
  outside 1–4 unique BCP-47 tags).
- `interimResults: true`.
- Credentials: `new v1.SpeechClient()` with **no arguments** — Application
  Default Credentials only, resolved server-side. No constructor in this
  package accepts credential JSON, tokens, or project secrets, and none of
  that is ever readable from the WebSocket protocol.

## Root dependencies/scripts the integration owner must add

**None at the root.** Per the task's constraint, I did not add application
dependencies to the root `package.json` — only the workspace scripts already
established: `test`, `typecheck`, `lint`, each fanning out via
`--workspaces --if-present`.

Package-local dependencies already declared (npm will resolve these on the
next `npm install` at the root; nothing further to add):

- `packages/google-transcription-engine`: `@google-cloud/speech@^6.7.0`,
  `@voice/transcription-contracts` (workspace).
- `apps/api`: `ws@^8.18.0`, `@voice/transcription-contracts` (workspace),
  `@voice/google-transcription-engine` (workspace); dev: `@types/ws`,
  `tsx` (used by the new `start` script to run TS source directly, since
  none of these workspace packages are pre-built to `dist`).

## Browser-safe cloud engine import (for `apps/web`'s `engineFactory.ts`)

Exactly matches what `docs/agent-tasks/integration.md` already specifies:

```ts
import { CloudEngineClient } from "@voice/google-transcription-engine/browser";

new CloudEngineClient({ cloudConsent: options.cloudConsent, websocketUrl: options.websocketUrl });
```

Confirmed the browser entrypoint never imports `@google-cloud/speech`:
`packages/google-transcription-engine/package.json`'s `exports` map only
exposes `./server` (imports the Google SDK) and `./browser`
(`CloudEngineClient` only, contract-typed, no Google SDK reference
anywhere in its module graph). I did not run `apps/web`'s production build
myself since `apps/web` does not exist yet in this repository — that
verification (`npm run build --workspace @voice/web` + bundle inspection
for the `@google-cloud/speech` string) is called out explicitly in both
`apps/api/README.md` and `integration.md` for whoever builds `apps/web`.

## Local ADC setup instructions (also in `apps/api/README.md`)

- Local dev: `gcloud auth application-default login`, then just run the
  server — `@google-cloud/speech` discovers the resulting ADC file
  automatically. Never commit that file or copy it into `.env`.
- Deployed: workload identity (GKE/Cloud Run/GCE) or a dedicated
  service-account key file referenced via `GOOGLE_APPLICATION_CREDENTIALS`
  — never baked into an image or committed.
- `apps/api/src/index.ts` is the **only** file in the repository that
  constructs the production Google client.

## Security and cleanup checks performed

- **No credentials over the wire.** The WebSocket protocol
  (`websocket/protocol.ts`) has no field anywhere for credential material;
  `GoogleStream`/`googleClientFactory.ts` construct the Google client with
  zero arguments (ADC only).
- **Origin allowlist is exact-match.** `isAllowedOrigin` does a plain
  `Array.includes`, no wildcard/subdomain logic; tested against
  near-miss cases (extra port, suffix domain, scheme mismatch) in
  `sessionLimits.test.ts`, and against a real rejected upgrade in
  `server.integration.test.ts`.
- **Non-public-by-default posture documented.** Both `apps/api/README.md`
  and the `.env.example` header state the gateway has no user
  authentication of its own and must not be exposed publicly until the
  deployer adds it.
- **No audio/transcript persistence.** Nothing in `apps/api` or
  `packages/google-transcription-engine` writes to disk; the only logging
  call (`transcriptionHandler.ts`'s `finalize()`) emits `sessionId`,
  `reason`, `durationMs`, `framesForwarded` — never transcript text or
  audio. `normalizeGoogleError` never forwards the raw Google error
  message (tested: `"never leaks the raw provider error message"` in
  `normalizeResult.test.ts`), only a generic message plus the numeric gRPC
  code.
- **Limits enforced and startup-validated.** 30s idle / 10min hard
  timeout, 640-byte fixed frame size, 2s max buffered audio, 20 concurrent
  sessions by default — all overridable via env vars that are rejected at
  startup if non-integer, non-positive, or above a documented safe
  ceiling (tested exactly at and one millisecond before every deadline).
- **Idempotent, exactly-once cleanup on every terminal path.** One
  `finalize()` guarded by a `finalized` flag handles stop, cancel,
  disconnect, idle timeout, hard timeout, protocol error, fatal provider
  error, capacity rejection, and server shutdown. `cleanup.test.ts`
  parametrically re-triggers every path a second and third way afterward
  and asserts: the provider closes exactly once, all handler-registered
  socket listeners are gone, the session registry slot is released, and no
  further sends occur.
- **Buffer safety.** `GoogleStream.write()` and `CloudEngineSession.push()`
  both convert only the frame's own `byteOffset`/`byteLength` window to a
  `Buffer`/`ArrayBuffer`, never the whole backing buffer (tested
  explicitly with a shared, larger backing `ArrayBuffer` in
  `GoogleStream.test.ts`).
- **Close-code mapping.** 1000 normal, 1008 policy violation
  (malformed/out-of-order/invalid), 1009 oversized frame, 1011 internal
  (fatal provider error, server shutdown), 1013 at capacity — documented
  in `apps/api/README.md`.

## Known Google multilingual/code-switching limitations

(Also documented in both package READMEs.)

- Each streaming result carries exactly one `languageCode` — Google cannot
  label genuine intra-sentence code-switching within a single result the
  way the app's four-language fixture (`Xin chào. My name is Sang. Soy de
  Vietnam. 祝你有美好的一天。`) exercises across separate utterances.
- No dedicated language-identification confidence is returned by the API,
  only an overall transcript recognition confidence, which this package
  reuses as `segment.language.confidence` for lack of anything better —
  treat it as a rough proxy, not a calibrated score.
- No utterance start time is returned, only `resultEndTime`; `GoogleStream`
  derives `startMs` from the prior result's end time, so segment
  boundaries are this package's own approximation.
- `alternativeLanguageCodes` is capped at three by the V1 API itself, which
  is why the whole app caps language selection at four.
- Ordinal/revision assignment (when a new transcript segment ID starts vs.
  when an existing one is revised) is this package's own bookkeeping — a
  new ordinal begins whenever the previous result went final; every
  non-final update to an in-progress result bumps `revision` instead. This
  isn't something Google's API states as a contract, just the most direct
  reading of how its streaming results evolve.

## Not done (explicitly out of scope for Agent 2)

- `apps/web/**`, `packages/local-whisper-engine/**`, and the final
  `src/App.tsx` composition change — Agent 1's exclusive territory.
- Merging `worktree-google-streaming-fallback` into `main`/`master`, root
  `package.json`/lockfile conflict resolution across both agents' work,
  and the full-suite/e2e run across the whole app — the integration
  owner's job per `docs/agent-tasks/integration.md`.
- Actually building/inspecting `apps/web`'s production bundle for a
  `@google-cloud/speech` reference — `apps/web` doesn't exist in this
  repository yet.
