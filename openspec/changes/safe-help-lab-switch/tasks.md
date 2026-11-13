# Tasks: Safe Help Lab switch

## Review and diagnosis

- [x] Compare executor branch with brief baseline; identify ADR-0013 conflict
- [x] Record product-owner acceptance of ADR-0045 with Save / Discard / Cancel
- [x] Review updated proposal → delta specs → design → tasks
- [x] Read safety-relevant contracts; audit constructors, global merges, draft/save signals and transitions
- [x] Record Open/Recent/demo differences; New is not a user-facing operation in this baseline
- [x] Reproduce pre-fix replacement and inherited save target in isolated Electron; capture before screenshot

## Implementation

- [x] Establish project dirty comparison against successful load/save baselines
- [x] Share replacement permission and staged commit across Help Lab, Open and Open Recent
- [x] Add accessible Save / Discard / Cancel dialog with Mapping/Matching draft disclosure
- [x] Return explicit save outcomes; cancel or fail without replacing the current project
- [x] Construct independent labs through existing project helpers, preserving globals and advanced presets
- [x] Keep offline flagship DuckDB routing and dirty-join focus
- [x] Guard late load replies and in-flight project/map writes; protect export replies by identity
- [x] Keep existing failed-recent pruning; Cancel and Save failure do not prune
- [x] Commit canvas drag-stop positions immediately so Save/switch sees the edit

## Validation and closure

- [x] UI build and all 29 unit-test files pass
- [x] Final 13-scenario Help Lab Electron regression suite passes
- [x] Run broader Electron suite; record 14 passed, 1 failed, 2 skipped at that revision
- [x] Reproduce the broader mapping-create failure on unmodified HEAD in a separate worktree
- [x] Run all three requested Rust package suites and record failures, not assumed passes
- [x] Capture before/after screenshots and automated acceptance table
- [x] Document scope, exact results, known limitations and manual coverage gaps
- [x] Merge delivered delta into Help Lab capability source of truth; close implementation change

See the [report](report.md). Closing this implementation change does not claim
all repository tests are green or that a human completed the full flagship journey.
Live PostgreSQL, a real Matching decision session, cross-platform visual checks,
and held-host race E2E remain explicit follow-up coverage, not passed checks.
