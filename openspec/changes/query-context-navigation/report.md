# PR-03 delivery report — Query context and semantic navigation

## Baseline and preservation

Resumed the interrupted implementation rather than replacing it. Verified branch
HEAD **9a918c5d668ab4dd39dbf49008a3ab59d2695fba** (PR-00B). PR-01 was already
staged; PR-02 and interrupted PR-03 were unstaged/untracked. This task issued no
commit, branch change, reset, checkout or staging command, and made no dependency,
Rust, IPC or persisted-IR change.
The staged tree identity recorded during inspection is
**d3748f9e28bf751e68c5a28e5827f2c1fc8cdd26**, identical at final verification.

An external PR-01 commit occurred during validation: final HEAD is
**8d00ead29d7ce8dd93296a9ac3fbec029456f4fb**, with the PR-01 typed-descriptor
commit message and initial HEAD as its parent. The index now matches that commit
(no staged diff), without any index changes by this task. PR-02/03 working-tree
changes remain, as does an unrelated ignore-file edit observed at final inspection.
No external change was reset or reverted.

Read agent/rule guidance, Accepted ADR-0031/32/39/44/45/46/47, relevant merged
contracts and PR-00A/B/01/02 delivery reports. Reviewed the existing proposal →
specs → design → tasks packet. No new product decision or ADR is introduced.
The capability delta is merged into [Query navigation SoT](../../specs/query-navigation/spec.md).

## Delivered responsibilities

| Owner | Responsibility |
|---|---|
| [Navigation scenario](../../../src/app/queryNavigation.ts) | Frontend-only context transitions, explicit query/Join/Mapping/Matching commands, destination resolution and captured Join input revision validation |
| [App adapters](../../../src/App.tsx) | Current owner reads, one selection/editor hydration path, explicit Lens layout, centralized diagnostic cleanup and guarded async panel completion |
| [Matching session shape](../../../src/app/matching/types.ts) | Optional captured original host query/Join target, in process only |
| [Matching UI](../../../src/components/MatchingWorkspace.tsx) | Disabled unavailable-target action and readable explanation; no fallback to the current query |
| [Mapping editor](../../../src/components/KeyMapEditor.tsx:431) | Stable mounted Save API registration with current callback dispatch; no parent/editor render feedback loop |
| [Behavioral units](../../../src/app/queryNavigation.test.ts) | Commands, invalid destinations, original Join, dependency revisions, preserved export focus and context ABA/refusal semantics |
| [Electron navigation](../../../e2e/electron/query-navigation.spec.ts) | Original Join return with retained dirty draft; missing/changed targets; keyboard Show me, real preview and editor hydration; held diagnostic work across rapid query/tab changes; same-target sample dismissal |

Ordinary Explorer/query/step/graph selection, Help Lab Show me and comparison,
Matching Lens return and quality inspection share the semantic selection adapter.
Quality inspection authors its ephemeral query in the same event and applies that
exact destination; it does not resolve against whichever query was previously active.
Navigation never publishes export focus, replaces a project or resets draft owners.

Context includes project/query/step/view/mode, workspace and connection/source/path
identity plus a monotonically advancing revision. Render-only identical input
retains identity; explicit navigation advances it even for the same target. Async
schema, prepare/status/progress, diagnostics, diagnostic samples, Model and setup
handoffs reject changed contexts. The existing preview generation remains its
execution owner; there is no second scheduler, global store or bus.

Matching retains the original Join's project/query/index and structural input
signature, including upstream and transitive query dependencies. Changes to Join
semantics or missing dependencies refuse return. Map-body saves and changes after
the captured Join do not invalidate that target. Detached demos have no target.
The action validates both when rendered and when invoked.

## Preserved boundaries

- Typed workspace tabs and mounted separate Mapping/Matching owners remain in place.
- Reopening an existing Mapping activates its mounted editor without merging the
  persisted map over its draft. New editors still use the existing opening path.
- Project persistence/replacement stays in the [PR-02 controller](../../../src/app/projectController.ts)
  and [replacement-only reset](../../../src/app/projectSessionReset.ts).
- Help Lab Show me does not collapse layout or steal keyboard focus; explicit
  Matching Lens return retains its existing focused-layout behavior.
- PR-00A acknowledged Save, source dirty-delta ownership and no-rollback semantics
  remain unchanged. PR-00B explicit non-writing demo and live-unavailable remain.
- No Compare, durable session restoration, new live acquisition or authoring format.

## Validation history and exact limits

Initial resumed validation: production build passed; **37 frontend unit files
passed**. First navigation Electron run: **2 passed, 3 failed (1.9m)**. Two expected
preview labels omitted the existing step identifier; the original-return case
expected an inspector heading after explicit Lens focus had hidden that inspector.
Assertions now use the visible Lens and exact existing preview label. No product
label or focused-layout behavior was changed to satisfy those assertions.

Next expanded run: **42 passed, 3 failed (4.2m)** across navigation, lifecycle,
typed tabs, Matching, Help Lab journey and mapping-create. Failures:

1. Mapping draft lifecycle test timed out waiting for its initial editable cell.
2. One navigation case timed out during initial lab preview setup, before target
   mutation/refusal assertions. It had passed in the earlier run.
3. The known mapping-create source-key case again failed at its expected renamed
   output in review, before creation. It remains a baseline failure, not repaired.

Trace artifacts had call logs but no DOM snapshots for the two setup failures;
their causes are not established. An early hypothesis that the first failure
proved an overwritten draft was incorrect: it failed before the first edit.
Independent code review identified unnecessary mounted-editor re-merging and
fixed that adapter conservatively; this is not claimed as a proven cause of that
particular timeout. Review also found mismatched cleanup/guard dependencies and
same-target sample re-entry; both now have explicit navigation regressions.

A subsequent validation invocation built/typechecked and ran units successfully,
but Electron collected no tests: CLI forwarding stripped an escape from a regex.
The next invocation used a plain-text exclusion instead. This failed invocation
is not a passing Electron run.

The next expanded run finished **50 passed, 1 failed (6.0m)**; all seven navigation
cases passed. The failure was the lifecycle held-preview regression waiting for
the hold to start. Its enabled assertion preceded the browser turn that armed and
clicked Recompute, so a scheduled render could disable the button in between.
The fixture now checks enabled, arms and clicks atomically, and releases in a
finally block. This is a harness-only correction, not a runtime lifecycle fix.
Argument forwarding also split that run's spaced exclusion: both mapping-create
cases 2 and 6 were omitted. The delivery run uses a single-token regex matching
only case 6. The earlier expanded run did execute and pass case 2.

The 52-case delivery attempt finished **50 passed, 2 failed**. All seven navigation
cases and the corrected lifecycle hold case passed. Both failures were in Mapping
tab setup; editor inputs disappeared and subsequent cleanup found the E2E hooks
removed. A repeated typed-tab diagnostic run with renderer error logging then
reproduced React maximum-update-depth errors with a stack pointing to Save API
registration. The [Mapping editor registration](../../../src/components/KeyMapEditor.tsx:431)
depended on App's changing inline callback, published a fresh API into parent
state, and consequently retriggered itself on each render. Registration is now
stable per mounted map/owner availability; its methods dispatch through current
callback refs, preserving the current editor and Save acknowledgement owner.
The repeated mounted-tab scenarios are the causal regression evidence for this
loop, not proof of the cause of every earlier uninstrumented setup timeout.
That pre-fix diagnostic run finished **9 passed, 6 failed (4.3m)** across three
repetitions of five typed-tab cases, with renderer stacks identifying the loop.

## Final verified results

| Gate | Actual result |
|---|---|
| Production build/typecheck | Passed; Vite 2.73s; existing large-chunk warning |
| All frontend units | **37 files passed** |
| Release host verification and E2E UI/typecheck | Passed through normal runner; existing native warnings and large-chunk warning |
| Expanded focused Electron, virtual display, one worker | **52 passed (3.0m)**; only known mapping-create case 6 excluded |
| Typed-tab renderer-loop regression, three complete repetitions | **15 passed (1.3m)** with renderer error logging; no renderer errors reported |
| Tracked and new-file whitespace | Passed; staged and unstaged diffs checked separately |
| Merged capability requirements | Exact match with reviewed delta |
| Native unit suites | Not rerun; no native source changes |

The 52-case run comprises **7 navigation + 13 lifecycle + 5 typed tabs + 6 Matching
+ 10 Help Lab journey + 5 mapping-create + 6 execution-state** cases. It includes
real offline previews, held sample completion, editor key hydration, dirty draft
retention, safe replacement, local Mapping save/reopen, non-writing demo/live
unavailable and preview cancellation/stale-result regressions.

Executed production build and frontend units through the normal npm scripts.
The normal Electron entry point ran these seven files with one worker and the
single-token exclusion pattern **6.*source.key.to**:
[navigation](../../../e2e/electron/query-navigation.spec.ts),
[lifecycle](../../../e2e/electron/help-lab-switch.spec.ts),
[tabs](../../../e2e/electron/workspace-tabs.spec.ts),
[Matching](../../../e2e/electron/matching-save.spec.ts),
[journey](../../../e2e/electron/help-lab-journey.spec.ts),
[mapping-create](../../../e2e/electron/mapping-create.spec.ts), and
[execution states](../../../e2e/electron/execution-states.spec.ts).
Then reran only the typed-tab file with three repetitions and one worker. Both
invocations used an isolated virtual display. Exact runner arguments appear in
the raw logs; a worker host-build skip follows entry-point host verification.

Local evidence, not repository artifacts:
[build](../../../../../../tmp/pr03-build-delivery.log),
[units](../../../../../../tmp/pr03-unit-delivery.log),
[52-case Electron](../../../../../../tmp/pr03-electron-complete.log),
[15-case repeated tabs](../../../../../../tmp/pr03-tabs-verified.log),
[exit status](../../../../../../tmp/pr03-complete-status.log),
[pre-fix renderer-loop diagnostic](../../../../../../tmp/pr03-tabs-diagnostic.log),
[initial navigation run](../../../../../../tmp/pr03-electron-navigation.log),
[first expanded run](../../../../../../tmp/pr03-electron-focused.log),
[held-preview timeout](../../../../../../tmp/pr03-electron-verified.log), and
[pre-fix 52-case run](../../../../../../tmp/pr03-electron-delivery.log).

## Baseline failures and manual gaps

The historical broad baseline is **33 passed, 2 failed, 2 skipped**. This change
does not claim to make the full broad suite green. The flagship comparison case
at [journey line 128](../../../e2e/electron/help-lab-journey.spec.ts:128) passed in
the expanded run, but no isolated before/after causal experiment establishes
that PR-03 fixed its historical failure. The [mapping-create case](../../../e2e/electron/mapping-create.spec.ts:291)
reproduced its known failure and is excluded explicitly from the final focused run.

No human visual review, cross-platform/focus/accessibility audit, actual live
PostgreSQL acquisition, external LLM, crash/restart recovery or own-data end-to-end
export validation is claimed. Revision signatures describe frontend definitions,
not external file contents or database snapshots. Held async sample tests prove
those mounted handoffs, not every host reply branch. Missing-target tests inject
project changes through existing E2E-only hooks. Dirty Matching fixture state is
explicitly discarded only after assertions to unblock teardown; production
beforeunload and Save semantics are untouched.

## PR-04 extraction handoff — not implemented here

- Extract the next execution/preview scenario behind narrow current-owner ports;
  preserve existing request generations, host lanes, cancel and sample/full policy.
  Context is a navigation staleness token, not a job system or persisted document.
- Reuse the semantic navigation commands and selection adapter. Do not add a
  second hydration path or route explicit same-target navigation through an
  identity-preserving render transition.
- Keep central transient cleanup aligned with all context invalidations, including
  view/tab ABA. Test late success/error/progress and same-target re-entry explicitly.
- Keep mounted editor API registration stable across parent navigation renders;
  use current callback dispatch for capture/settlement rather than re-registering
  a new API into parent state on each callback identity change.
- Preserve typed navigation, PR-02 controller/reset and separate Mapping/Matching
  ownership; do not move draft or Save acknowledgement into navigation/context.
- Keep new quality inspection construction separate from resolution of an existing
  query. Do not apply a previous active query when an inspection query is authored.
- Retain explicit unavailable target explanations, demo non-write/live unavailable
  and save acknowledgement. No new live acquisition is authorized by this slice.
- Carry both historical baseline failures independently; passing comparison once
  is not causal proof. Investigate setup timeouts with richer snapshots if repeated.
