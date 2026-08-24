# Canonical dev checkout integration

## Objective

Make `C:\Users\18472\dev\voice-project` the single working checkout for the Voice Project. Integrate the newer committed and uncommitted work from `C:\Users\18472\OneDrive\Tài liệu\Voice-project` without losing the destination-only work, then prepare a reviewable public-repository cleanup report.

## Current state

- The OneDrive branch is a direct descendant of the dev branch by 24 commits.
- Both checkouts contain uncommitted changes. Their web-transcription changes overlap and therefore need deliberate reconciliation.
- The OneDrive checkout is the current source of truth for the newer server, native-runtime, remote-engine, web, README, and documentation work.
- The dev checkout contains four destination-only web session changes and untracked generated files beneath the `whisper.cpp` submodule.

## Integration design

1. Create durable local backup references for the uncommitted state of both checkouts before changing either working tree.
2. Fast-forward the dev branch to the OneDrive committed head, preserving its existing commit sequence.
3. Apply the OneDrive work-in-progress as the primary implementation state, including the `pcm-worklet.js` public asset.
4. Reapply the dev-only work and resolve overlapping web-session changes explicitly, favoring the newer OneDrive implementation except where the dev-only change is still required and covered by tests.
5. Preserve the committed documentation history. Remove the accidental `docs/` ignore rule so future project documentation remains trackable.
6. Keep generated submodule output and downloaded models out of version control. Do not remove either source checkout, rewrite Git history, or push to GitHub during this integration.

## Validation and public-readiness review

After integration, rebuild the affected workspaces and run the relevant test suites, followed by the repository's normal build/test/typecheck commands where the local environment permits. Resolve integration regressions before reporting success.

Then inspect the result for public-repository concerns: secrets and machine-specific paths, ignored/generated artifacts, documentation accuracy, licensing/attribution, oversized files, and README clarity. Deliver findings and proposed cleanup changes for user review; do not publish or delete the OneDrive checkout as part of this work.

## Recovery

The original working states will remain reachable through named local backup branches. If an integration decision needs revisiting, the destination can be restored from its backup reference without relying on the OneDrive folder.
