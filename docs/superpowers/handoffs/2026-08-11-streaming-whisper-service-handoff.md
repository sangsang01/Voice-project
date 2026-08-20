# Streaming Whisper Service Handoff

Date: 2026-08-11

## Workspace

- Worktree: `C:\Users\18472\OneDrive\TaÌ€i liÃªÌ£u\Voice-project\.worktrees\streaming-whisper-service`
- Branch: `codex/streaming-whisper-service`
- Base branch before implementation work: `migration/whisper-cpp-vad`
- Architecture spec: `docs/superpowers/specs/2026-08-11-streaming-whisper-service-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-11-streaming-whisper-service.md`

## Current State

Implementation has completed Tasks 1-5 from the plan. Task 6 is next.

Recent commits:

```text
3566736 fix: stop scheduler from re-finalizing on stop after speech already ended
4860157 feat: schedule rolling transcript revisions
033e4da feat: bound remote audio backpressure
841eb33 docs: add streaming whisper handoff
6ef7b12 feat: add remote whisper engine lifecycle
db1c95b feat: validate streaming control messages
eb5bc36 feat: add streaming PCM wire codec
744da1e chore: ignore local worktrees
```

`git status --short` is clean as of this update. Full-repo `npm run build && npm test` is green across all 6 workspaces (305 tests).

## Completed Work

### Task 1: Binary PCM Protocol Package

Commit: `eb5bc36 feat: add streaming PCM wire codec`

Added `@voice/streaming-protocol` with:

- Exact 656-byte PCM frame codec.
- Header constants for protocol version, message type, header bytes, and total message bytes.
- Little-endian encode/decode for sequence, start time, and 320 signed 16-bit samples.
- Tests for round trip, byte layout, malformed frame rejection, and encoder input rejection.

Verification:

```powershell
npm test --workspace @voice/streaming-protocol
npm run build --workspace @voice/streaming-protocol
```

Passed: 2 protocol test files after Task 2, 22 tests total.

### Task 2: Control/Event Types And Validators

Commit: `db1c95b feat: validate streaming control messages`

Added:

- `ClientControl` and `ServerMessage` wire types.
- `validateClientControl`, `validateServerMessage`, and `parseJsonMessage`.
- Top-level key rejection for wire messages only.
- `validateSessionRequest` delegation for `session.start`.
- Engine event validation for all current event discriminants.
- Nested event/segment extension fields are preserved, not stripped.

Important review fixes already applied:

- Preserve nested `engine.event` and `segment` objects instead of rebuilding them.
- Allow empty warning/error message strings because the contract requires `string`, not nonempty.
- Validate nested `engine.event.sessionId` as nonempty.
- Expanded validator tests to cover every event variant, invalid variants, nested extras, top-level extra keys, empty session/model strings, and invalid ACKs.

Verification:

```powershell
npm test --workspace @voice/streaming-protocol
npm run build --workspace @voice/streaming-protocol
npm run typecheck --workspace @voice/streaming-protocol
```

Passed: 22 tests.

### Task 3: Remote Whisper Engine Lifecycle

Commit: `6ef7b12 feat: add remote whisper engine lifecycle`

Added `@voice/remote-whisper-engine` with:

- Injectable WebSocket seam in `src/socket.ts`.
- `RemoteWhisperEngine` implementing `TranscriptionEngine`.
- `prepare()` socket setup with `voice-transcription.v1` subprotocol.
- Optional token provider added as `access_token` query parameter.
- `inspect()` rejects insecure non-loopback `ws:` endpoints.
- `open()` sends `session.start` and resolves after matching `session.accepted`.
- Session event delivery, first-subscriber replay of synthetic `listening`, listener exception isolation.
- Simple PCM push path using `encodePcmMessage`.
- `stop()`, `cancel()`, socket close, and `dispose()` terminal behavior.
- Shared engine contract suite with fake socket.

Important review fixes already applied:

- Malformed server message during pending `open()` now rejects the pending open instead of hanging.
- Synthetic `listening` uses a separate sequence cursor so a valid server event with sequence `0` is delivered.
- `prepare()` rejects while a session is pending open or active.
- Concurrent same-session `prepare()` coalesces; concurrent different-session `prepare()` rejects.
- `dispose()` during in-flight `prepare()` cannot leave a live socket installed on a disposed engine.
- Added tests for nonmatching-session event filtering and listener exception isolation.

Verification:

```powershell
npm test --workspace @voice/remote-whisper-engine
npm run typecheck --workspace @voice/remote-whisper-engine
npm run build --workspace @voice/remote-whisper-engine
```

Passed: 18 tests.

Final focused review for Task 3 returned:

```text
Critical: None.
Important: None.
Ready to merge? Yes.
```

### Task 4: Credit-Based Audio Backpressure

Commit: `033e4da feat: bound remote audio backpressure`

Modified `packages/remote-whisper-engine/src/RemoteWhisperEngine.ts`:

- `RemoteSession` now tracks `lowestUnackedSequence`, `highestSentSequence`, and a `Set<number>` of outstanding sequences, plus a `maxUnacknowledgedFrames` limit and a `getBufferedAmount()` callback into the owning engine's socket.
- `push()` rejects with `{ accepted: false, reason: "backpressure" }` when outstanding count reaches the limit, or when `socket.bufferedAmount > 1_048_576`, or while terminal/closing. `encodePcmMessage` (via `sendFrame`) is only reached after those checks pass.
- New `receiveAck(throughSequence)` on `RemoteSession`, routed from a new `audio.ack` branch in `RemoteWhisperEngine.handleSocketMessage`. Duplicate/regressing ACKs (`throughSequence < lowestUnackedSequence`) are no-ops. An ACK beyond `highestSentSequence` calls `fail("INTERNAL", ...)`, which is fatal for the session.
- Engines constructed without `maxUnacknowledgedFrames` get `Number.POSITIVE_INFINITY`, preserving prior unbounded behavior.

Important ordering detail: `highestSentSequence`/`outstandingSequences` are updated *before* calling `sendFrame()`, not after — the shared contract test's fake socket ACKs synchronously inside `send()`, so updating bookkeeping after the send would let the synchronous ACK arrive while `highestSentSequence` was still stale, incorrectly triggering the fatal "beyond highest sent sequence" path.

Verification:

```powershell
npx vitest run test/backpressure.test.ts --dir packages/remote-whisper-engine
npm test --workspace @voice/remote-whisper-engine
npm run typecheck --workspace @voice/remote-whisper-engine
npm run build --workspace @voice/remote-whisper-engine
```

Passed: 24 tests (6 new backpressure tests + 18 prior).

Code review verdict: Ready to merge. No Critical or Important issues. Minor/optional notes (not applied, low priority):
- `highestSentSequence` isn't rolled back if `sendFrame()` returns `false` (send failure) — harmless in practice since a send failure usually precedes connection teardown.
- The `{ accepted: false, reason: "backpressure" }` literal repeats 4 times in `push()`; could extract a small helper.

### Task 5: Pure Server Session Scheduler

Commits: `4860157 feat: schedule rolling transcript revisions`, `3566736 fix: stop scheduler from re-finalizing on stop after speech already ended`

Added `apps/transcription-server/` (`@voice/transcription-server`):

- `src/runtime.ts`: `StreamingRuntime`/`StreamingRuntimeSession`/`VadUpdate`/`DecodeResult` — the native-independent seam a future N-API whisper.cpp/Silero adapter (Task 9) will implement.
- `src/vadGate.ts` and `src/languageMap.ts`: verbatim ports of `packages/local-whisper-engine/src/worker/vadGate.ts` and `.../segmentation/languageMap.ts` (same logic/defaults, tests ported alongside).
- `src/sessionScheduler.ts`: new `SessionScheduler` class. Turns `runtime.push(frame)` VAD boundary updates into a `decodeIntervalMs` (default 750ms) cadence of provisional decodes plus a final decode on speech end. Emits `segment.upsert` events with `id: "${sessionId}:${ordinal}"`, monotonically incrementing `revision` per utterance, `{tag:"und"}` language for provisional segments, and `mapDetectedLanguage(...)` for final segments. Only one decode is ever in flight (`decoding` flag); ticks that land while busy coalesce into a single follow-up decode (`tickPending`); speech-end always supersedes a pending provisional (`finalRequested` clears `tickPending`). `stop()` drains active speech into one final decode before resolving; `cancel()` suppresses emission of any decode already in flight. `finishUtterance()` retains a trailing `overlapMs` (default 500ms) tail of buffered frames across utterance boundaries for onset continuity.

Verification:

```powershell
npm test --workspace @voice/transcription-server
npm run typecheck --workspace @voice/transcription-server
npm run build --workspace @voice/transcription-server
npm run build
npm test
```

Passed: 32 tests in the new workspace (10 scheduler + 12 vadGate + 7 languageMap — final counts after the review fixup added 2 regression tests); 305 tests across the whole repo; full build clean.

Code review verdict (first pass): "With fixes" — found one **Critical** bug, since fixed:

- `stop()` originally gated the drain-final decode on `this.speaking || this.frames.length > 0`. Because `finishUtterance()` deliberately retains a trailing overlap tail of frames after every completed utterance, `frames.length` is almost always > 0, so `stop()` re-finalized (duplicate or phantom `isFinal: true` segment) on two ordinary flows: a silent session that never detected speech, and a session that already finalized naturally just before `stop()` was called. Fixed by gating on `this.speaking` alone (commit `3566736`), with two new regression tests (`does not finalize on stop when pushed audio never crossed the speech threshold`, `does not emit a second phantom final when stop is called after an utterance already finalized`) confirmed red against the buggy version before the fix landed.

Minor/optional notes from review (not applied, low priority):
- `now` is part of `SessionSchedulerOptions` (per the plan's exact shape) but unused by the scheduler today — documented with a one-line comment as reserved for a later task's metrics/timestamping.
- Final-segment language mapping always passes a hardcoded confidence of `1` to `mapDetectedLanguage`, since `DecodeResult` carries no confidence field yet — worth revisiting when Task 9's native adapter can report real detection confidence.
- `StreamingRuntimeSession.close()` is never called from `SessionScheduler` — session/runtime lifecycle ownership is expected to belong to the Task 6 gateway.

## Known Warnings

Existing repo verification may print non-fatal warnings:

- Vite chunk size warning for the web bundle.
- jsdom/canvas warning: `Not implemented: HTMLCanvasElement's getContext() method`.

These were present in baseline checks and are not caused by Tasks 1-5.

## Next Task

Start with Task 6 from the implementation plan (`docs/superpowers/plans/2026-08-11-streaming-whisper-service.md`):

```text
Task 6: Add WebSocket admission and gateway handling
```

Files:

- Create: `apps/transcription-server/src/admission.ts`
- Create: `apps/transcription-server/src/gateway.ts`
- Create: `apps/transcription-server/src/metrics.ts`
- Create: `apps/transcription-server/src/main.ts`
- Test: `apps/transcription-server/test/gateway.test.ts`
- Test: `apps/transcription-server/test/metrics.test.ts`
- Modify: `package.json` / `package-lock.json` (add `ws` and `@types/ws` to `@voice/transcription-server`)

Task 6 requirements (see the plan file for full detail):

- Write red integration tests using a **real loopback `ws` server** on port `0` with an injected fake runtime. Cover: accepted `session.start`, binary PCM decode and ACK, one active session per socket, stop/cancel, malformed JSON, malformed 656-byte PCM, sequence gaps, origin rejection, capacity rejection before acceptance, and admission capacity released on close.
- A metrics test that records queue delay, decode duration, audio duration, real-time factor, model, result kind, and opaque session ID, then serializes the record and proves it contains **no sample buffers or transcript text**.
- `AdmissionPool` (exact shape given in the plan): `reserve()` returns a release closure or `undefined` at capacity; the closure is idempotent.
- `createTranscriptionGateway({ server, runtime, capacity, allowedOrigins, authenticate })`: requires subprotocol `voice-transcription.v1`; validates the first text message as `session.start`; reserves capacity **before** `runtime.open`; emits `session.accepted` only afterward; validates every binary frame with `decodePcmMessage`; emits `audio.ack` after the scheduler (built in Task 5 — reuse `SessionScheduler`) accepts it; normalizes errors to contract codes; closes with application close code `4000` after the terminal event.
- Read `access_token` from the upgrade request URL, strip it before any request logging, pass it to `authenticate(token)` (`{ accountId: string }` or throws).
- `main.ts` reads `VOICE_MODEL_PATH`, `VOICE_VAD_MODEL_PATH`, `VOICE_PORT`, `VOICE_ALLOWED_ORIGINS`, `VOICE_MAX_SESSIONS`; missing production values fail startup with one explicit error.
- `metrics.ts` exports a `MetricsSink` interface and a JSON-lines implementation. Its API must accept no text/PCM fields — numeric timings and enums only, so content logging is impossible through this path.

Suggested commands:

```powershell
npx vitest run test/gateway.test.ts --dir apps/transcription-server
npm test --workspace @voice/transcription-server
npm run build --workspace @voice/transcription-server
```

## Process Notes For Next Agent

- Continue using the implementation plan task-by-task.
- Follow TDD for every new behavior: write the failing test, observe red, implement, verify green — including for the fake-runtime/fake-clock test scaffolding itself, not just production code. (Task 5's post-review fixup was a real defect the initial test suite missed; adding a regression test and confirming it reproduces red against the pre-fix code before re-fixing is the standard to hold.)
- Keep review checkpoints after each task: spec compliance first, then code quality. Use the `superpowers:requesting-code-review` skill's subagent-dispatch pattern — it caught a real Critical bug in Task 5 that all automated tests had missed.
- Do not modify `vendor/whisper.cpp`.
- Keep `SessionRequest` and `PcmFrame` unchanged.
- Ordinary tests/builds must not require GPU, CMake, or native binaries.
- Task 6 should reuse `SessionScheduler` (from Task 5) as the transcript-revision engine per WebSocket session, not reimplement its logic in the gateway.
- If working in this same OneDrive-hosted worktree, note the real path (`C:\Users\18472\OneDrive\Tài liệu\Voice-project\.worktrees\streaming-whisper-service`) has a non-ASCII directory name that breaks some tools (Read/Write/Grep can fail with "File does not exist" even when `git`/PowerShell see it fine — apparently a Unicode normalization mismatch between two look-alike `Tài liệu` folders under OneDrive). Get the Windows 8.3 short path once via `cmd /c "for %A in (\"<real path>\") do @echo %~sA"` and use that short path (e.g. `C:\Users\18472\OneDrive\TAILIU~1\VOICE-~1\WORKTR~1\STREAM~1`) for all Bash/Read/Write/Edit calls for the rest of the session.

