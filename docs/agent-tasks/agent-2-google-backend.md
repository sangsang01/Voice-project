# Agent 2 Task: Google Streaming Backend and Cloud Engine

You own `apps/api/**` and `packages/google-transcription-engine/**` for the optional realtime cloud fallback.

Do not begin until the coordinator gives you Agent 1's frozen contract/bootstrap commit hash. Create `feature/google-streaming-fallback` from that exact commit.

Read these documents completely before editing:

1. `docs/superpowers/specs/2026-08-04-multilingual-realtime-transcription-design.md`
2. `docs/superpowers/plans/2026-08-04-google-streaming-fallback.md`
3. `docs/agent-tasks/README.md`

## Mandatory workflow

1. Use the repository's `using-git-worktrees` workflow before feature work if you are not already in an isolated worktree.
2. Use test-driven development exactly as the plan specifies.
3. Complete Plan Tasks 1–8 in order.
4. Commit after every numbered plan task using the specified commit message.
5. Use an injected fake Google client for all automated tests; tests must pass without network access or credentials.

## Constraints

- Do not edit root workspace files, `packages/transcription-contracts/**`, `apps/web/**`, or `packages/local-whisper-engine/**`.
- Report required root dependencies and scripts to the integration owner in your handoff.
- Use Google Cloud Speech-to-Text V1 `streamingRecognize` with 16-kHz mono LINEAR16 audio.
- Map the first selected language to `languageCode` and at most three remaining languages to `alternativeLanguageCodes`.
- Keep Application Default Credentials and Google SDK instances on the server.
- Export separate `/server` and `/browser` package entrypoints; the browser entrypoint must not import `@google-cloud/speech`.
- Never accept credential material from the WebSocket client.
- Require an exact `ALLOWED_ORIGINS` match and keep the paid gateway disabled on public deployments until user authentication is added.
- Never store or log audio or transcript text.
- Enforce the thirty-second idle timeout, ten-minute hard timeout, fixed frame size, bounded buffering, and concurrent-session limit.
- Close the Google stream, WebSocket listeners, timers, and registry entry exactly once on every terminal path.

## Required handoff

Return:

- Every commit hash in order
- Commands run and their final results
- Exact Google request configuration used
- Root dependencies/scripts the coordinator must add
- Local ADC setup instructions
- Security and cleanup checks performed
- Known Google multilingual/code-switching limitations
