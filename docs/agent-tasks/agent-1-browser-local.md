# Agent 1 Task: Existing Frontend Wiring and Local Whisper

You own the shared bootstrap, `apps/web/**`, and `packages/local-whisper-engine/**` for the multilingual realtime transcription MVP.

Read these documents completely before editing:

1. `docs/superpowers/specs/2026-08-04-multilingual-realtime-transcription-design.md`
2. `docs/superpowers/plans/2026-08-04-browser-local-transcription.md`
3. `docs/agent-tasks/README.md`

## Mandatory workflow

1. Use the repository's `using-git-worktrees` workflow before feature work if you are not already in an isolated worktree.
2. Use test-driven development: write each specified failing test, run it and confirm the expected failure, add the minimum implementation, then rerun it.
3. Complete Plan Task 1 first and commit it separately.
4. Send the Task 1 commit hash to the coordinator so Agent 2 can branch from the frozen contract.
5. Continue Plan Tasks 2–9 on `feature/browser-local-transcription`.
6. Commit after every numbered plan task using the specified commit message.

## Constraints

- Preserve the existing frontend's visual design, routing, and unrelated behavior.
- Put new browser behavior under `apps/web/src/features/transcription/**`.
- Limit `apps/web/src/App.tsx` to the smallest composition change necessary.
- Do not edit `apps/api/**` or `packages/google-transcription-engine/**`.
- Do not change the contract after publishing the Task 1 hash without stopping and coordinating with Agent 2.
- Local inference and audio conversion must not run on the React thread.
- Never upload audio unless the user explicitly approves the cloud confirmation modal.
- Never claim word-level language certainty; use `und` when the selected-language scorer is uncertain.

## Required handoff

Return:

- Every commit hash in order
- Commands run and their final results
- Browser/WebGPU environment used for the manual check
- Measured local first-segment latency and realtime factor
- Known accuracy or low-end-device limitations
- Exact frontend files changed for wiring

