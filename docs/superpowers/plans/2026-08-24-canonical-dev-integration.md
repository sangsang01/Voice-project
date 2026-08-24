# Canonical Dev Checkout Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all committed and working OneDrive-project work into `C:\Users\18472\dev\voice-project`, preserving the existing dev-only work and producing a verified, reviewable public-repo cleanup audit.

**Architecture:** The OneDrive checkout is a committed descendant of the original dev head, so retain that history with a local merge into the dev checkout. Before merging, turn each working tree's uncommitted state into an isolated, named local backup commit. Apply the OneDrive snapshot first, then layer and reconcile the older dev snapshot using tests as the arbiter for overlapping web-transcription behavior.

**Tech Stack:** Git, npm workspaces, TypeScript, Vitest, Playwright, React/Vite, Node-API/whisper.cpp.

---

## File map

- Create: `docs/superpowers/audits/2026-08-24-public-readiness.md` — findings and recommended remediation after integration.
- Modify: `.gitignore` — retain standard local/artifact exclusions without ignoring project documentation.
- Modify: `README.md`, `apps/transcription-server/README.md`, and `packages/remote-whisper-engine/README.md` — import the OneDrive documentation state.
- Modify: `apps/transcription-server/src/**`, `apps/transcription-server/test/**`, and committed `apps/transcription-server/dist/**` — import and verify the newer loopback/native runtime work.
- Modify: `apps/web/**` — import the OneDrive live-caption implementation and reconcile the destination-only session behavior.
- Modify: `packages/native-whisper-addon/**` and `packages/remote-whisper-engine/**` — import newer native/remote engine changes and committed build output.
- Create: `apps/web/public/pcm-worklet.js` — checked-in browser audio-worklet asset from the OneDrive worktree.
- Preserve but do not track: `vendor/whisper.cpp/bindings/java/bin/**`, downloaded model directories, and `node_modules/**`.

### Task 1: Snapshot both existing working trees

**Files:**
- Modify: Git refs only in both local repositories.
- Preserve: `C:\Users\18472\OneDrive\Tài liệu\Voice-project` working state.
- Preserve: `C:\Users\18472\dev\voice-project` working state.

- [ ] **Step 1: Verify the expected heads and dirty file lists before writing backup commits.**

Run:

```powershell
$src = 'C:\Users\18472\OneDrive\Tài liệu\Voice-project'
$dst = 'C:\Users\18472\dev\voice-project'
git -C $src rev-parse HEAD
git -C $dst rev-parse HEAD
git -C $src status --short
git -C $dst status --short
```

Expected: OneDrive resolves to `b9902db...`; dev resolves to the local documentation commit based on `f8a47fc...`; both report the previously inventoried working changes.

- [ ] **Step 2: Save the OneDrive work-in-progress on a named local safety branch.**

Run:

```powershell
$src = 'C:\Users\18472\OneDrive\Tài liệu\Voice-project'
git -C $src switch -c codex/backup-onedrive-wip-20260824
git -C $src add -A
git -C $src commit -m 'backup: snapshot OneDrive worktree before dev integration'
git -C $src status --short
```

Expected: a new local commit captures the OneDrive source, tests, documentation, `.gitignore` change, removed nested lockfile, and `apps/web/public/pcm-worklet.js`; the source worktree is clean.

- [ ] **Step 3: Save the dev-only work-in-progress on a named local safety branch.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst switch -c codex/backup-dev-wip-20260824
git -C $dst add apps/web/src/features/transcription/TranscriptionAdapter.test.tsx apps/web/src/features/transcription/TranscriptionAdapter.tsx apps/web/src/features/transcription/sessionController.test.ts apps/web/src/features/transcription/sessionController.ts
git -C $dst commit -m 'backup: snapshot dev web worktree before OneDrive integration'
git -C $dst status --short
```

Expected: a second new local commit captures only the four dev-only web changes. The nested `vendor/whisper.cpp` generated files remain untracked and are not staged.

- [ ] **Step 4: Confirm both recovery branches are reachable.**

Run:

```powershell
git -C 'C:\Users\18472\OneDrive\Tài liệu\Voice-project' log -1 --oneline codex/backup-onedrive-wip-20260824
git -C 'C:\Users\18472\dev\voice-project' log -1 --oneline codex/backup-dev-wip-20260824
```

Expected: each command prints the matching `backup:` commit.

### Task 2: Integrate committed OneDrive history into dev

**Files:**
- Modify: Git history in `C:\Users\18472\dev\voice-project`.
- Preserve: source commit history through `b9902db`.

- [ ] **Step 1: Fetch the source backup reference into the dev repository without adding a persistent remote.**

Run:

```powershell
$src = 'C:\Users\18472\OneDrive\Tài liệu\Voice-project'
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst fetch $src '+refs/heads/codex/backup-onedrive-wip-20260824:refs/heads/codex/source-onedrive-wip-20260824'
git -C $dst log -1 --oneline codex/source-onedrive-wip-20260824
```

Expected: dev can resolve the source backup commit locally, with no new `remote` listed in `git -C $dst remote -v`.

- [ ] **Step 2: Merge the newer committed source head into the dev branch.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst switch migration/whisper-cpp-vad
git -C $dst merge --no-ff b9902dbd39d9a309fc1152d2eac3ffcfeb2b4b65 -m 'merge: integrate committed OneDrive voice project work'
git -C $dst log --oneline -3
```

Expected: a merge commit keeps the OneDrive feature and documentation commits plus the already-committed dev integration design. No files should be conflicted.

- [ ] **Step 3: Verify the baseline integration before applying either working snapshot.**

Run:

```powershell
git -C 'C:\Users\18472\dev\voice-project' status --short
git -C 'C:\Users\18472\dev\voice-project' diff --check
```

Expected: no tracked changes and no whitespace errors.

### Task 3: Apply and reconcile the working snapshots

**Files:**
- Modify: `.gitignore`.
- Modify: all files contained in `codex/source-onedrive-wip-20260824`.
- Modify: the four web files in `codex/backup-dev-wip-20260824`.
- Create: `apps/web/public/pcm-worklet.js`.

- [ ] **Step 1: Apply the OneDrive snapshot without committing it.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst cherry-pick --no-commit codex/source-onedrive-wip-20260824
git -C $dst status --short
```

Expected: source WIP changes are staged. `apps/web/public/pcm-worklet.js` is present and staged; no conflict markers exist.

- [ ] **Step 2: Reapply the dev-only web snapshot and resolve overlaps.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst cherry-pick --no-commit codex/backup-dev-wip-20260824
git -C $dst diff --name-only --diff-filter=U
```

Expected: Git may report conflicts in `TranscriptionAdapter.tsx`, its test, or session-controller files. Resolve every conflict by preserving the OneDrive live-engine structure and incorporating dev-only lifecycle/teardown safeguards only where compatible; then stage each resolved file with `git add`.

- [ ] **Step 3: Correct the public-repository ignore policy.**

Edit `.gitignore` so that it retains these source-state exclusions:

```gitignore
node_modules/
dist/
.vite/
*.log
.env
.env.*
.claude/
.worktrees/
*.node
.DS_Store
Thumbs.db
apps/web/public/models/
apps/transcription-server/models/
apps/transcription-server/benchmark-results/
```

Do not include a `docs/` rule. This preserves documentation tracking while excluding secrets, build output, downloaded models, and operating-system clutter.

- [ ] **Step 4: Confirm the desired working tree contents before creating the integration commit.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst diff --cached --check
git -C $dst diff --cached --name-status
git -C $dst -C vendor/whisper.cpp status --short
```

Expected: the staged list contains the integration files and `apps/web/public/pcm-worklet.js`, does not contain `vendor/whisper.cpp/bindings/java/bin/**`, and contains no whitespace errors.

- [ ] **Step 5: Commit the reconciled integration.**

Run:

```powershell
git -C 'C:\Users\18472\dev\voice-project' commit -m 'feat: integrate OneDrive live transcription work'
git -C 'C:\Users\18472\dev\voice-project' show --stat --oneline --summary HEAD
```

Expected: the commit records the source work-in-progress plus reconciled dev-only lifecycle work. The original snapshots remain available on their backup branches.

### Task 4: Build and test the integrated repository

**Files:**
- Modify: generated committed `dist/**` only if rebuilding changes output.
- Test: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`.
- Test: `apps/web/src/features/transcription/sessionController.test.ts`.
- Test: `apps/transcription-server/test/*.test.ts`.
- Test: `packages/remote-whisper-engine/test/RemoteWhisperEngine.test.ts`.

- [ ] **Step 1: Install workspace dependencies from the canonical dev checkout.**

Run:

```powershell
npm install
```

Expected: dependencies install from the root lockfile; no nested `apps/web/package-lock.json` is recreated.

- [ ] **Step 2: Build workspace packages in dependency order.**

Run:

```powershell
npm run build
```

Expected: exits with status 0. If committed build output changes, inspect and include only output produced by the imported source changes.

- [ ] **Step 3: Run focused web lifecycle tests.**

Run:

```powershell
npx vitest run apps/web/src/features/transcription/TranscriptionAdapter.test.tsx apps/web/src/features/transcription/sessionController.test.ts
```

Expected: all focused tests pass; failures in overlap areas are resolved before broader testing.

- [ ] **Step 4: Run remote engine and server tests.**

Run:

```powershell
npx vitest run packages/remote-whisper-engine/test/RemoteWhisperEngine.test.ts apps/transcription-server/test
```

Expected: all tests pass and cover the imported wire protocol, runtime, scheduling, and language-mapping changes.

- [ ] **Step 5: Run the repository test and typecheck commands.**

Run:

```powershell
npm test
npm run typecheck
```

Expected: both commands exit with status 0. Record any environment-only blocker separately rather than masking it.

- [ ] **Step 6: Commit generated output only when it changed because of the integration.**

Run:

```powershell
git status --short
git diff --check
```

Expected: either a clean tree or a narrowly scoped set of regenerated committed `dist/**` files. Commit such files with `git commit -am 'chore: rebuild integrated workspace outputs'` only after confirming their source counterparts are already in the integration commit.

### Task 5: Produce the public-readiness audit without publishing

**Files:**
- Create: `docs/superpowers/audits/2026-08-24-public-readiness.md`.
- Review: `.gitignore`, `.gitattributes`, `README.md`, `LICENSE*`, package manifests, Git-tracked large files, and git history for credentials.

- [ ] **Step 1: Scan tracked content for likely credentials and machine-specific paths.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
rg -n --hidden --glob '!node_modules/**' --glob '!vendor/whisper.cpp/**' '(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|C:\\Users\\|/Users/)' $dst
```

Expected: no credentials. Review any machine-path matches and classify them as intentional documentation, replaceable configuration, or removal candidates.

- [ ] **Step 2: Identify tracked large files and public metadata gaps.**

Run:

```powershell
$dst = 'C:\Users\18472\dev\voice-project'
git -C $dst ls-files -z | ForEach-Object { $_ -split "`0" } | Where-Object { $_ } | ForEach-Object { $path = $_; $item = Get-Item -LiteralPath (Join-Path $dst $path); if ($item.Length -gt 5MB) { "{0:N1} MB | {1}" -f ($item.Length / 1MB), $path } }
Get-ChildItem -LiteralPath $dst -File -Filter 'LICENSE*'
```

Expected: no downloaded models or other avoidable large assets are tracked. The license command reports an existing license or identifies a portfolio-publication decision for the user.

- [ ] **Step 3: Write a ranked audit that separates safe cleanup from user decisions.**

Create `docs/superpowers/audits/2026-08-24-public-readiness.md` with sections for verified status, blocking issues, recommended safe cleanups, user decisions (license, visibility, screenshots/demo), and commands run. Do not remove files, alter Git remotes, or push during this task.

- [ ] **Step 4: Review the audit and integration state with the user.**

Run:

```powershell
git -C 'C:\Users\18472\dev\voice-project' status --short
git -C 'C:\Users\18472\dev\voice-project' log --oneline -8
```

Expected: report the canonical dev path, backup branch names, verification results, audit findings, and any decisions needed before cleanup or publication.

## Plan self-review

- Spec coverage: Tasks 1–3 preserve both working trees, integrate committed and uncommitted OneDrive work, reconcile dev-only work, include `pcm-worklet.js`, and correct the accidental documentation ignore rule. Task 4 validates the integrated software. Task 5 covers the agreed public-readiness review without publishing or deleting the OneDrive checkout.
- Placeholder scan: no unresolved placeholders or deferred implementation markers remain.
- Consistency: all Git commands use the same canonical dev destination and the two named source/dev backup branches; nested submodule artifacts are explicitly excluded throughout.
