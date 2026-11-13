# PR-02 delivery report — Query project lifecycle controller

Implemented **PR-02 only** on feature/matching. Initial HEAD was
**9a918c5d668ab4dd39dbf49008a3ab59d2695fba**, with PR-01 already staged, not a
clean checkout. That index was preserved; PR-02 changes remain unstaged/untracked.
No commits, PRs, branch changes, dependency, Rust, IPC or project-format changes.

Reviewed agent/rule requirements, relevant Accepted ADR-0031/32/44/45/46/47,
merged capability contracts and PR-00A/B/01 reports. Recorded proposal → specs →
design → tasks before runtime edits. No new product architecture decision.
Delivered delta is merged into [project lifecycle SoT](../../specs/project-lifecycle/spec.md).

## Before / after responsibilities

| File | Before | After |
|---|---|---|
| [App](../../../src/App.tsx) | Dirty baseline, persistence normalization, Save/Save As, permission/staging, Recent pruning, replacement reset and export-map refresh orchestration | Live-owner/effect adapters, chooser rendering and controller entry calls; existing reducer and document owners remain |
| [Controller](../../../src/app/projectController.ts) | Absent | Baseline, normalized snapshot, separate owner dirty reads, single-flight gates, Save acknowledgement, UID/path policy, Open/Recent/lab staging, committed application and guarded export refresh |
| [Session reset](../../../src/app/projectSessionReset.ts) | Inline incomplete reset in App | Explicit testable reset contract: typed navigation, old editor owners, selected query/step, preview/model/diagnostics/preparation/check state and project-owned lab task |
| [Existing lifecycle core](../../../src/app/projectLifecycle.ts) | Pure lab constructor, canonical fingerprint and permission/staging guard | **Unchanged**, reused by controller; not rewritten or replaced |
| [Controller units](../../../src/app/projectController.test.ts) | Absent | Deferred picker/write/load/MRU/export refresh races with independent project/draft/mutation owners |
| [Reset units](../../../src/app/projectSessionReset.test.ts) | Absent | Explicit setter contract, typed navigation destinations, Help Lab retention, stale request invalidation and task ownership |
| [Electron lifecycle](../../../e2e/electron/help-lab-switch.spec.ts) | Existing 13 mounted scenarios | Same scenarios plus deterministic held-preview completion proving failed Open remains visible |

The controller is not a thin wrapper around App orchestration: it owns the full
scenario and operation flags. It does not own a second copy of Project or
Workbench navigation. React refreshes live ports on render, and the reducer
revalidates application of saved snapshots and export-sync results. Mapping and
Matching documents/dirty state remain in their existing owners, not in tab metadata.

## Preserved and tightened contracts

- Save records the acknowledged submitted snapshot, never newer edits. Picker
  edits enter the submitted snapshot; edits during write or MRU persistence keep
  the current document dirty and stop Save-before-replace. A new-file Save As
  forks UID only when safely applied; same-file and Windows slash/case equivalents
  retain UID. Failed/cancelled writes do not publish path, identity or baseline.
- Open, Recent and labs use the unchanged replacement guard. Cancel/failure/late
  project or Mapping/Matching edits never reset sessions. Project Save cannot
  silently persist separate owner drafts. Project/editor/map/Confirm writes block
  replacement. Missing Recent pruning happens only after an attempted load.
- Lab construction remains independent/unsaved, retains global connections and
  explicit presets, initializes quality checks and starts flagship assistance only
  for the newly opened lab. Reopened ordinary files do not infer tutorial state.
- Successful replacement resets PR-01 typed navigation, old editor owners, preview
  snapshot/phase/sample mode/cache/timer, model/diagnostics/preparation progress,
  frozen checks and transient selections. Preview request generation is invalidated;
  preparation/status/diagnostic/model replies also check replacement generation.
- Startup restoration checks its initial snapshot rather than overwriting work
  begun during startup. Export-map refresh skips application if the document or
  replacement generation changed, rather than replacing a newer workspace.
- Project lifecycle errors are independent of preview error state. A background
  preview cannot erase a load/save failure; dismissal still uses the existing
  error banner. Successful replacement also clears old Query errors.
- ADR-0031 mutation ownership/cancellation is unchanged; no rollback is claimed.
  PR-00A typed save outcomes/acknowledgement and PR-00B explicit origin refusal
  are untouched. Detached demos cannot write; live UI retrieval stays unavailable.
  No store, router, event bus, job framework or additional persistence path.

## Exact validation evidence

| Gate | Final result |
|---|---|
| Production build/typecheck | Passed; existing large-chunk warning; 14.45s |
| All frontend units | **36 files passed**, including both new files, existing lifecycle, tabs and Matching units |
| Release host verification + E2E UI/typecheck | Passed via normal Electron entry point; existing native warnings and large-chunk warning |
| Focused Electron, virtual display, one worker | **24 passed (1.7m)**: lifecycle 13 + workspace tabs 5 + Matching 6 |
| Whitespace | Passed; final documentation merge checked separately at delivery |
| Native unit suites | Not run: no crate source changed; Electron runner still verified the release host |

Commands executed:

```sh
npm run build
npm run test:unit
xvfb-run -a npm run test:e2e:electron -- e2e/electron/help-lab-switch.spec.ts e2e/electron/workspace-tabs.spec.ts e2e/electron/matching-save.spec.ts --workers=1
git diff --check
```

Unit cases cover slow Save/Save As and picker edits, cancelled/failed saves,
same/new-file UID, Save/Discard/Cancel for Open and labs, late project and both
draft-owner edits, mutation busy gates, single-flight operations, Recent pruning,
successful Save followed by failed lab load, connection changes during save,
obsolete write replies, late export sync and startup snapshot drift. Reset tests
exercise normal/flagship/quality/other-lab destinations and explicit cleared state.

Run history is retained, not presented as all-green from the outset:

1. Initial typecheck found unused moved imports and a remaining dialog reference;
   corrected the adapters. The next build found two new test fixture typing
   mistakes; corrected without dependency/tsconfig changes. Units already passed.
2. First focused Electron: **22 passed, 2 failed**, both missing-file error-text
   waits (Open/Discard and Open-after-Save). Existing background preview success
   cleared the shared error state. Added lifecycle-owned error adapter state and
   a deterministic held-preview regression.
3. Next focused run: **23 passed, 1 failed**. Original load-error assertions passed;
   the new test raced its hold against Playwright click stability (automatic preview
   disabled Recompute). Arming and dispatching the button in one browser turn fixed
   the harness, not runtime behavior.
4. Final run with unchanged runtime and corrected harness: **24 passed**.

Local evidence (not repository artifacts):
[production build](../../../../../../tmp/pr02-build-verified.log),
[units](../../../../../../tmp/pr02-unit-verified.log),
[final Electron](../../../../../../tmp/pr02-electron-final.log),
[first Electron](../../../../../../tmp/pr02-electron.log),
[second Electron](../../../../../../tmp/pr02-electron-verified.log).

## Limits and manual gaps

The broad Electron suite was **not rerun**. Its documented baseline remains
**33 passed, 2 failed, 2 skipped**; Help Lab comparison and mapping-create target-key
failures are not fixed here. This report does not claim broad-suite green.

Deferred IPC unit ports provide deterministic concurrency evidence, not real
PostgreSQL race coverage. No human visual/cross-platform smoke, actual live row
retrieval, external LLM, crash/restart restoration or full own-data/export journey
is claimed. Diagnostics/preparation/model generation guards are typechecked and
covered by mounted smoke, not each individually held in Electron. Matching smoke
uses existing explicit synthetic dirty/evidence hooks; injected Matching decisions
are explicitly discarded after assertions so beforeunload does not block teardown.
Production beforeunload and save policy are unchanged.

## PR-03 integration notes — not implemented here

- Original-query/Lens navigation remains PR-03. Use PR-01 descriptors/transitions
  for navigation and current Query selection separately; do not reconstruct a
  persisted Project to navigate or call replacement/reset for a tab change.
- Use this controller for actual project replacement and project-file persistence.
  Supply fresh owner reads and keep reducer updates pure; no second dirty store.
- Keep Mapping/Matching dirty and save acknowledgement in their owners. Navigation
  is not evidence of persistence, run origin, accepted decisions or live retrieval.
- Preserve generation checks and reset only on committed replacement. Do not
  reintroduce workspace-wide asynchronous sync over concurrent edits or let
  background previews clear project lifecycle errors.
- Keep explicit non-writing demo origin and live-unavailable behavior. Any later
  live acquisition needs actual plan-bound rows and existing stale-context checks.
- Retain explicit dirty Matching cleanup in Electron tests and report broad
  baseline failures independently of focused success.
