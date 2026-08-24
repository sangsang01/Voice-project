# Public-repository readiness audit — 2026-08-24

## Scope and baseline

- Audited tracked content at `0d7c3b0a7f683929cd1a51e3bfb13234c79afaa1` (`codex/canonical-dev-integration`) in a clean linked worktree.
- This is a read-only publication audit apart from adding this report. It did not change source code, ignore rules, remotes, repository visibility, or the `vendor/whisper.cpp` submodule working data; it did not publish or push anything, and it did not delete any checkout or files.
- The repository had 235 tracked files. The history credential-pattern scan used `git log --all` at audit time and covered 110 commits across local refs: the 108 commits reachable from baseline `0d7c3b0` plus two additional commits reachable only from local backup/source WIP refs. It was not a HEAD-only scan.

## Verified status

- **Credentials:** No credentials were identified by the scans described below. Baseline tracked content and the 110-commit all-local-ref history scan had zero matches for private-key headers and the selected high-confidence AWS, GitHub, Google API, Stripe, and Slack token patterns. No tracked `.env`, `.pem`, `.key`, `.p12`, or `.pfx` file was found.
- **Size and generated-dependency inventory:** No tracked blob exceeds 5 MiB. No tracked model file, `node_modules`, or benchmark-result path was found. Model and benchmark directories are ignored.
- **Build outputs:** 80 tracked paths are under `dist/` across `apps/transcription-server` and six packages. `.gitattributes` explicitly normalizes LF for committed `dist/` output in three packages, which is evidence that at least part of this is intentional.
- **Documentation:** The root `README.md` is a substantive local-demo guide (setup, architecture, limitations, and commands). Its tracked text contains no image/video references, so the repository currently has no README screenshots or recorded-demo media.
- **Package metadata:** The root workspace package is `voice-project` with `"private": true`; that prevents npm publication, but does not prevent public GitHub visibility.
- **Repository configuration:** `git remote -v` produced no entries. This checkout is not configured with a GitHub destination.
- **Legal/community files:** There is no root `LICENSE`, `NOTICE`, `CODE_OF_CONDUCT`, or `CONTRIBUTING` file. The sole tracked filename matching the legal-file inventory is a web-test fixture (`apps/web/tests/fixtures/LICENSE.md`), not repository licensing.
- **Submodule:** `.gitmodules` pins `vendor/whisper.cpp` to `https://github.com/ggml-org/whisper.cpp` at `306c88f4d1286aec1bf96e544632897886af5501`; its working tree is uninitialized here. Its upstream license and attribution/distribution obligations must be verified at that pinned revision before release.

## Blocking issues

- **Technical blockers found by this audit: none.** The credential/private-key scans found no credentials, and the tracked-file inventory found no oversized model, dependency, or benchmark artifact that blocks publication.
- **User-controlled release prerequisites:** Before presenting the repository as public/open source, select and add a root license, verify the pinned `whisper.cpp` submodule's license and attribution/distribution obligations for the intended release, and choose the GitHub destination and visibility. These are release decisions outside the scope of this audit, not defects that this audit changed.

## Issues and recommended safe cleanups

None of the findings is a confirmed leaked credential. The following are safe, reviewable publication-hygiene improvements:

1. **Provide a tracked template intentionally.** `.gitignore` contains `.env.*`, so `git check-ignore -v --no-index .env.example` shows that `.env.example` would be ignored. If configuration guidance is needed, add a sanitized template and an explicit `!.env.example` exception; never place real values in it.
2. **Decide a policy for committed `dist/`.** Keep it only where consumers genuinely need repository-built artifacts, document the rationale, and ensure build output is reproducible; otherwise remove it in a separately reviewed cleanup. The current ignore rule does not untrack existing `dist/` files.
3. **Review machine-specific documentation before public launch.** The current `docs/superpowers/plans/2026-08-24-canonical-dev-integration.md` and `docs/superpowers/specs/2026-08-24-canonical-dev-integration-design.md` contain `C:\\Users\\18472` and OneDrive paths. They are not credentials, but they reveal local environment details. The generated `packages/local-whisper-engine/wasm/whisper-bridge.js` contains the generic Emscripten value `/home/web_user`, not a personal path. Redact or retain the two internal documents deliberately; removing them from current files does not erase earlier commits without a separate history-rewrite decision.
4. **Add optional contributor-facing files.** A concise `CONTRIBUTING` guide and code of conduct improve outside contribution expectations but are not prerequisites for a portfolio repository.

## User decisions required before public publication

These are release decisions, not changes made by this audit:

1. **License:** Choose and add a root license. Without one, the code remains under default copyright despite a public repository. Confirm that the chosen license is compatible with all direct dependencies and the pinned `whisper.cpp` submodule requirements.
2. **GitHub destination and visibility:** Choose the owner/repository and public versus private visibility, then configure or create the remote outside this audit. No remote exists in this checkout.
3. **Demo assets:** Decide whether to add a short sanitized recording and/or screenshots. The README is explicit that this is a two-process localhost demo with no deployed URL; screenshots or a recording would help reviewers evaluate it without local native setup. Check any transcript, microphone, account, and file-path content before sharing.
4. **Personal narrative:** The README describes the author's family immigration motivation. Confirm that this is intended for public distribution.
5. **Machine-path history:** Decide whether the two current internal docs may remain public. If not, decide separately whether current-file cleanup is sufficient or a history rewrite is warranted.

## Integration-verification context

The following results were supplied as the integration verification context for this audit and were not re-run by this documentation-only task:

- `npm install` and build completed.
- Focused tests: 69 web lifecycle, 14 remote, and 95 server tests passed.
- Root test run: 373 passed and 1 skipped.
- Root typecheck passed.
- Dependency audit reported 3 vulnerabilities. This audit makes no claim about their severity or fixability.
- The expected jsdom canvas/WebGL warnings were observed during verification.

## Scan coverage and commands

All scans used Git-tracked content and did not traverse ignored `node_modules` or submodule working data.

```powershell
# Current tracked snapshot: high-confidence credentials/private keys and local paths
git grep -I -n -E -e '<private-key-or-token-pattern>' HEAD --
git grep -I -n -E -e '([A-Za-z]:\\Users\\|/Users/|/home/|\\home\\)' HEAD --

# Original all-local-ref history scan (110 commits at audit time): introductions or removals matching the same patterns
git log --all --format='%H' -G '<private-key-or-token-pattern>'

# Inventory and repository metadata
git ls-tree -r -l HEAD
git ls-files
git check-ignore -v --no-index .env.example
git remote -v
git submodule status
```

Patterns covered private-key headers (including OpenSSH), AWS access-key prefixes, GitHub token formats, Google API-key prefixes, Stripe secret-key formats, and Slack token formats. Pattern scanning cannot prove the absence of an obfuscated or nonstandard secret; it supports the limited conclusion above that no credentials were identified in the baseline tracked snapshot or the original 110-commit all-local-ref history scan.

## Publication assessment and priority

**No credential or oversized-artifact publication blocker was identified.** A public GitHub launch still needs an explicit license and destination/visibility decision; without a root license it should not be represented as open source. Before sharing widely, prioritize the machine-path review and a sanitized demo asset, then decide the ongoing `dist/` policy and whether to add a tracked `.env.example`.
