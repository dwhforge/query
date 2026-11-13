# PR-01 delivery report — Typed workspace tabs

Implemented PR-01 only. No commit, branch operation, Rust/IPC or persisted project
format change. Initial checkout was clean at **9a918c5d668ab4dd39dbf49008a3ab59d2695fba
(PR-00B)**, rather than the anticipated dirty PR-00A/00B tree. Both prior slices
are preserved. Reviewed agent rules, Accepted ADR-0031/32/44/45/46/47, relevant
merged contracts and both prior delivery reports. Focused proposal → specs →
design → tasks recorded before runtime edits. No new product decision/ADR.

Completed delta is merged into [workspace-tabs SoT](../../specs/workspace-tabs/spec.md).

## Before / after responsibilities

| File | Before | After |
|---|---|---|
| [App](../../../src/App.tsx) | Overloaded active string, reserved service names, raw map IDs, Matching prefix and inline close/fallback | Typed navigation value, transition applier, existing owner-derived dirty confirmation and existing Join/Lens return effects |
| [Tab transitions](../../../src/app/workbench/tabs.ts) | Absent | Small pure navigation-only union, kind-tagged tuple keys, open/activate/close/reset; no documents, effects, dirty store or framework |
| [Transition units](../../../src/app/workbench/tabs.test.ts) | Absent | Collision/escaping, duplicate open, unknown activation, dirty cancel/discard, active/inactive close, neighbor fallback, immutable reset |
| [Electron tabs](../../../e2e/electron/workspace-tabs.spec.ts) | Absent | Five real mounted UI lifecycle cases using the existing isolated harness |
| [OpenSpec packet](proposal.md) and [index](../../README.md) | No PR-01 contract | Focused reviewed scope, completed tasks, merged contract and evidence |

Mapping documents and dirty-delta/editor APIs remain in the existing App-owned
Mapping sessions. Matching documents, execution mode, decisions, filters and
save ownership remain in the existing Matching sessions/services. Query is the
single existing Pipeline canvas, not one new tab per selected query. Existing
query selection remains separate. Navigation tracks identities only.

Render order, styles and hidden-mounted panel pattern are retained. Help Lab
remains available, including after project reset; quality keeps its existing
conditional availability/destination. Opening reserved-looking IDs no longer
collides with canvas/services/Matching. Existing Mapping next/previous neighbor
fallback and Matching-to-canvas return remain. Mapping dirty close is now guarded
at every App close entry, including tab chrome; Escape now correctly dispatches
Matching to its own guarded closer rather than treating it as a Mapping ID.

Two narrow E2E-only hooks open an existing Mapping through its ordinary editor
entry and expose map/dirty snapshots, without exposing editor APIs or changing
save policy. The existing Matching injection hook is unchanged in authority.

## Preserved contracts

- PR-00A: only acknowledged persistence/verified no-op settles decisions; failed
  drafts remain retryable; Mapping Save is not project-file Save.
- ADR-0047/PR-00B: live UI retrieval remains explicitly unavailable. Demo opens
  separately, detached, labelled and non-writing. Fixture provenance cannot write.
  Navigation never reconstructs, relabels or copies a Matching session.
- ADR-0031: existing cancellation, stale-result and in-flight write ownership;
  no mutation rollback claim. Close cannot create a new persistence path.
- ADR-0032: scenario-local pure functions, no store/plugin/router/event bus.
- ADR-0044: mounted in-process draft retention and dirty lifecycle warning;
  no automatic accept/Save/Apply or restart persistence claim.
- ADR-0045: reset only in successful existing project application; replacement
  Cancel/load failure retain tabs and drafts; existing Save/Discard/Cancel stays.
- ADR-0046: Help Lab assistance/hints and canvas return effects remain local.

## Exact validation evidence

| Gate | Result |
|---|---|
| Production build/typecheck | Passed; existing large-chunk warning; final build 7.00s |
| All frontend units | **34 files passed**, including new navigation units and existing Matching persistence/demo-live tests |
| Release host + E2E UI/typecheck | Passed through normal Electron runner; existing native warnings and large-chunk warning |
| Verified focused Electron | **24 passed (1.7m)** under isolated virtual display, single worker |
| Whitespace | Passed before final documentation merge; checked again at delivery |

Commands used: normal npm build, frontend unit runner, then the normal Electron
entry point with the three focused spec paths. Worker host-build skip means the
entry point had already rebuilt/verified release host, not an omitted host build.

Focused Electron breakdown:

- **5 new workspace-tab cases**: reserved-looking map/service/Matching identity,
  duplicate opening, component-local filter/error retention across switches,
  inactive close, dirty Mapping Cancel/discard and neighbor/canvas fallback,
  dirty Matching button/Escape Cancel/discard, project replacement Cancel/Discard
  with both dirty owners, Help Lab retention, quality switch/Escape/reset.
- **6 existing Matching cases**: missing target/id, actual seed failure and retry,
  actual local save/project reopen, explicit detached non-writing demo and live
  unavailable behavior, fixture-provenance refusal.
- **13 existing safe replacement cases**: Save/Discard/Cancel, first-save picker,
  persistence/load failures, Open/Open Recent, Mapping draft retention, Save As.

Run history is not hidden:

1. First focused run: **22 passed, 1 failed**. New switching test matched all
   retained hidden Mapping filter inputs; scoped selector to the visible input.
   No runtime change was needed.
2. Second run after adding quality coverage: **23 passed, 1 failed**. Existing
   safe-switch load-failure-after-Save test timed out on missing-file error text.
   It passed in the first run. No cause or unrelated fix is claimed.
3. Verification rerun with unchanged runtime/tests: **24 passed**. The transient
   failure remains a stability observation, not proof the race cannot recur.

Local logs: [build](../../../../../../tmp/pr01-build-final.log),
[units](../../../../../../tmp/pr01-unit-final.log),
[verified Electron](../../../../../../tmp/pr01-electron-verified.log),
[first Electron attempt](../../../../../../tmp/pr01-electron.log), and
[second Electron attempt](../../../../../../tmp/pr01-electron-final.log).
Logs and exit-marker files are local evidence, not committed artifacts.

## Limits and manual gaps

The full broad E2E suite was not rerun. Its documented baseline remains **33
passed, 2 failed, 2 skipped**; flagship comparison and mapping-create target-key
failures are not fixed here. No human visual/cross-platform smoke, live retrieval,
real PostgreSQL warehouse race, external LLM, crash/restart restoration, full
own-data/export journey or special concurrent in-flight tab-close test is claimed.
Mapping edits in Electron are real seed-grid edits. Matching lifecycle tests use
explicit synthetic dirty state; real demo review/save protections remain covered
by the existing six cases. Test teardown explicitly clears injected Matching dirty
state before Electron close; production beforeunload protection is unchanged.

## PR-02 integration notes (not implemented)

- Use typed descriptors/transitions, not raw IDs or reserved string conventions.
  Keep the single canvas descriptor distinct from selected query identity.
- Keep document/session construction and persistence in existing owners; do not
  turn navigation membership into another Mapping or Matching store.
- Open identity and owner together, remove owner only after accepted close, and
  reset only after successful project replacement. Preserve inactive mounts and
  the existing map neighbor / Matching canvas / Join-Lens return behaviors.
- Dirty state is supplied by owners at close time, never copied into navigation.
  Keep Matching execution mode/provenance and PR-00A save acknowledgement intact.
- Future live acquisition still needs actual plan-bound rows and existing stale
  context checks; typed tabs neither authorize nor implement retrieval.
- Retain explicit dirty Matching teardown in additional Electron cases. Keep the
  observed safe-switch error-text timing issue visible if expanding test scope.
