# Streaming Whisper Service Handoff

Date: 2026-08-11

## Workspace

- Worktree: `C:\Users\18472\OneDrive\Tài liệu\Voice-project\.worktrees\streaming-whisper-service`
- Branch: `codex/streaming-whisper-service`
- Base branch before implementation work: `migration/whisper-cpp-vad`
- Architecture spec: `docs/superpowers/specs/2026-08-11-streaming-whisper-service-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-11-streaming-whisper-service.md`

## Current State

Implementation has completed Tasks 1-3 from the plan. Task 4 is next.

Recent commits:

```text
6ef7b12 feat: add remote whisper engine lifecycle
db1c95b feat: validate streaming control messages
eb5bc36 feat: add streaming PCM wire codec
744da1e chore: ignore local worktrees
```

`git status --short` was clean before this handoff file was added.

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

## Known Warnings

Existing repo verification may print non-fatal warnings:

- Vite chunk size warning for the web bundle.
- jsdom/canvas warning: `Not implemented: HTMLCanvasElement's getContext() method`.

These were present in baseline checks and are not caused by Tasks 1-3.

## Next Task

Start with Task 4 from the implementation plan:

```text
Task 4: Add credit-based audio backpressure
```

Files:

- Modify `packages/remote-whisper-engine/src/RemoteWhisperEngine.ts`
- Add `packages/remote-whisper-engine/test/backpressure.test.ts`
- Update generated `packages/remote-whisper-engine/dist/*` after build if continuing the existing committed-dist convention.

Task 4 requirements:

- With `maxUnacknowledgedFrames: 2`, first two `push()` calls are accepted, third returns `{ accepted: false, reason: "backpressure" }`.
- `audio.ack` through sequence `0` permits one more frame.
- Duplicate/regressing ACKs do not add credit.
- ACK beyond highest sent sequence is a fatal protocol error.
- Maintain `lowestUnackedSequence`, `highestSentSequence`, and a `Set<number>` of outstanding sequences.
- Call `encodePcmMessage(frame)` only after capacity validation.
- Reject push when `socket.bufferedAmount > 1_048_576`.
- Remove all outstanding sequences `<= throughSequence` on valid ACK.
- Terminal sessions consistently return `{ accepted: false, reason: "backpressure" }`.

Suggested commands:

```powershell
npx vitest run test/backpressure.test.ts
npm test --workspace @voice/remote-whisper-engine
npm run typecheck --workspace @voice/remote-whisper-engine
npm run build --workspace @voice/remote-whisper-engine
```

## Process Notes For Next Agent

- Continue using the implementation plan task-by-task.
- Follow TDD for every new behavior: write the failing test, observe red, implement, verify green.
- Keep review checkpoints after each task: spec compliance first, then code quality.
- Do not modify `vendor/whisper.cpp`.
- Keep `SessionRequest` and `PcmFrame` unchanged.
- Ordinary tests/builds must not require GPU, CMake, or native binaries.
- Task 4 should build on the current `RemoteSession` state machine rather than rewriting it.
