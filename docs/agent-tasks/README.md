# Two-Agent Execution Runbook

Use these files as the copy-ready assignments for the two coding agents:

- `agent-1-browser-local.md` — shared bootstrap, existing-frontend wiring, microphone pipeline, and local Whisper.
- `agent-2-google-backend.md` — Node WebSocket API and optional Google streaming engine.
- `integration.md` — post-merge wiring and full verification owned by the coordinator with Agent 1.

## Required sequence

1. Place the completed React/Vite/TypeScript frontend at `apps/web` with `src/App.tsx` as its composition root.
2. Give Agent 1 its task file. Agent 1 completes only Plan Task 1 and publishes the contract/bootstrap commit hash.
3. Create two branches or worktrees from that hash:
   - `feature/browser-local-transcription`
   - `feature/google-streaming-fallback`
4. Agent 1 continues Tasks 2–9 while Agent 2 starts Tasks 1–8 in parallel.
5. Neither agent edits the other agent's paths. Neither changes `packages/transcription-contracts` after the bootstrap hash.
6. Merge both branches into a temporary integration branch.
7. Agent 1 performs the minimal cloud-factory wiring inside its owned frontend files after Agent 2's package is present.
8. Run all unit, contract, typecheck, lint, and browser tests from the repository root.

Follow `integration.md` for the exact post-merge changes and checks.

## Integration conflict policy

- The human integration owner resolves root `package.json` and lockfile changes.
- Contract changes stop both workstreams and require one coordinated contract commit.
- Agent 2 reports required root dependencies/scripts in its handoff instead of editing root files.
- Agent 1 preserves the existing frontend design and avoids unrelated component or styling changes.

## Final acceptance exercise

Run both engines against a licensed recording of:

```text
Xin chào. My name is Sang. Soy de Vietnam. 祝你有美好的一天。
```

Record first provisional latency, final latency, realtime factor, transcript accuracy, segment-language accuracy, peak memory, and dropped audio. Language labels may be `und` when uncertain; the transcript must preserve the original Unicode text.
