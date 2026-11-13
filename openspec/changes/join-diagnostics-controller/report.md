# PR-04B — Join diagnostics / prepare ownership

## Baseline and scope

Starting HEAD was **e30220ac98a86a1c5a7bb8799217c2441fc49a02**, the external
PR-04A commit, parented by PR-03 **87b97353f1ede5dd402d861ab6d08414a9215526**.
The working tree and index were clean. The previously reported preview work and
ignore-file edits were already incorporated; neither was reverted or rewritten.
No stage, commit, reset, checkout or index write was performed.

Delivered requirements are merged into the [Join capability contract](../../specs/join-diagnostics/spec.md).

Read agent rules, Accepted ADR-0031/0032/0041/0044/0045/0046/0047, merged capability
contracts and preceding preview/navigation/lifecycle/tabs/demo/live/Save reports.
Recorded proposal → spec → design → tasks before runtime edits. No new product
decision, ADR, Rust, IPC schema, dependency, persisted IR, store or bus.

## Before / after responsibilities

Before, App owned seven Join view states, context cleanup, prepared-status reads,
two panel async bodies, three numeric progress pollers, sample sequencing and
sample errors. Project replacement reached through seven separate Join setters.
Progress cleanup shared the same setter with quality/export operations.

| Owner after extraction | Responsibility |
|---|---|
| [Join controller](../../../src/app/joinDiagnostics/controller.ts:46) | Panel prepare/diagnostics, existing request-generation guard, key validation, prepared/reload status, analysis cancellation/preemption, request-local polling, finite clamped numeric progress, error/cancel classification, sample intent sequencing, sample view and local reset |
| [React adapter](../../../src/app/joinDiagnostics/useJoinDiagnostics.ts:7) | Stable construction, current-input/effect refs, external-store subscription, layout-time context cleanup/status, render-time stale masking and context/lease-bound Lens busy reporting |
| [App adapter](../../../src/App.tsx:1090) | Current project/context and narrow effects; render existing state; compose Join progress over independently owned quality/export progress |
| [App domain projection](../../../src/App.tsx:2509) | Left-before-Join, right object/reference and through-Join output workspace transformations; no sample async lifecycle or setters |
| [Replacement adapter](../../../src/App.tsx:3015) / [reset](../../../src/app/projectSessionReset.ts:49) | One resetJoin port on committed replacement, independent from preview and Mapping/Matching resets |
| [Existing Join Lens](../../../src/components/JoinLens.tsx) | Unchanged UI and internal prepare/side-sample/fuzzy/explanation behavior; only its parent busy/progress mirror is extracted |
| [Existing preview owner](../../../src/app/queryPreview/controller.ts) | Unchanged debounce, snapshot, sample/full, cache, refresh and ordinary-preview cancel; no Join implementation moved into it |
| Other App owners | Schema inference/editor hydration, Model SQL, quality check/remap transformations, export, mounted Mapping and Matching state/persistence remain separate |

App diff is **46 added / 397 removed** (net 351 fewer lines). The controller is
202 lines and hook 42 lines. This is lifecycle ownership, not a helper-only split.
There is no bag of App state setters in either extracted module.

## Preserved and tightened contracts

- Existing typed bridge calls, sources/connections order, project reference
  context, force/reload hints and explicit full-input diagnostics remain.
- Analysis still preempts ordinary preview locally and uses existing host cancel;
  host Preview/Analysis/Mutation lanes and IPC correlation are untouched. Cancel
  is interruption/stale-result refusal, never rollback of committed map writes.
- Both request generation and current QueryContext gate success/error/finally.
  Same-context newer analysis cannot be finished by an older request. Navigation
  context remains only a transient stale token, not an execution scheduler.
- Prepared-status and sample intents have independent counters. Starting new
  analysis invalidates prior status/sample work. Sample clearing invalidates an
  outstanding sample. Neither embedded nor fetched samples enter preview cache.
- Poll lifetime guards reject replies after interval cleanup, even after normal
  completion without navigation. Latest poll wins; non-finite fractions are
  ignored and finite percentages are clamped and rounded to 0–100.
- Lens busy callbacks capture context and a local lease: old callbacks cannot
  finish newer preparation in the same context or after query/tab/project ABA.
  Join cleanup cannot erase unrelated quality/export progress. Existing quality
  Inspect handoff clears when current Lens preparation starts.
- Original Matching Join capture, typed mounted tabs, stable Mapping Save API,
  acknowledged Save, separate lifecycle errors, non-writing demos and live
  unavailable behavior remain with their existing owners.

## Validation evidence

- Initial production build: passed, with the existing large-chunk warning.
- Initial and final unit runs: **all 39 files passed**, including the new Join
  controller and updated replacement reset tests. Final standalone typecheck
  passed. Logs: `/tmp/pr04b-unit-final.log`, `/tmp/pr04b-typecheck-final.log`.
- First focused Electron run: **52 passed, 3 failed (12.2 minutes)**. Two new test
  harness failures were an incorrect existing sample label and omission of the
  real replacement Discard prompt. Both assertions/setup were corrected without
  changing runtime policy. The third failure was the existing comparison test's
  mapped-preview row timeout at line 140. This run is not green.
- Final rebuilt focused Electron: **55 passed (7.5 minutes), exit 0** — 45
  execution/navigation/lifecycle/tabs/Matching cases and 10 flagship journey
  cases. This includes all five new held Join cases and the unchanged comparison
  case that timed out on the first run. Evidence:
  [final Electron log](../../../../../../tmp/pr04b-electron-final.log).
- Final ordinary production build: **passed, exit 0** (17.05 seconds), with the
  existing large-chunk warning. Evidence:
  [production build log](../../../../../../tmp/pr04b-build-final.log).
- A temporary source export of unchanged starting HEAD, built separately with
  the same existing host, ran the two selected comparison cases: **2 passed
  (24.9 seconds)**. This confirms the failure is not deterministic baseline
  evidence and does not establish either regression or repair. No working-tree
  source, index or branch was replaced. Log: `/tmp/pr04b-comparison-head.log`.

The final five mounted Join cases prove numeric 42% reporting plus pending poll
refusal after Cancel, old prepare error/finally refusal while newer diagnostics
remain computing, old diagnostics error refusal after rapid query/step navigation,
old prepared status refusal across real Discard/project replacement, and newest
right-side sample intent surviving a later left-side response. The harness fixes
did not weaken assertions or bypass replacement policy.

The focused selection is execution states, query navigation, safe Help Lab
replacement, workspace tabs, Matching Save/demo/live and flagship journey.
The release host is explicitly reused, not rebuilt; each E2E run rebuilds the
E2E renderer. New response holds are E2E-only, one-shot and restricted to four
existing Join read commands; they hold a real host reply, not the host lane.
Synthetic progress/error/status values are test evidence, not real engine metrics.

Unit evidence covers same-context prepare supersession, stale status/errors,
out-of-order/finite/clamped progress, pending poll after completion/cancel/reset,
query/step/project/view/graph/same-target ABA, Lens leases, newest sample intent,
embedded sample metadata/highlights, sample clearing and local error classification.
Electron retains explicit injected Matching-draft discard during teardown.

Final whitespace validation passed; merged requirements exactly match the reviewed
delta. Final HEAD remained **e30220ac98a86a1c5a7bb8799217c2441fc49a02** and the
index remained empty. Diff checks confirmed no edits to the ignore file, preview
owner, navigation controller, project controller, Join Lens UI, stable Mapping
editor, Rust sources or dependency manifests. Only this PR-04B slice is left
unstaged in the working tree.

## Manual gaps and known failures

No human visual/cross-platform smoke, real PostgreSQL race, external LLM, native
dialog happy path, crash/restart restore, full own-data/export or complete
flagship repair/Save As/reopen journey is claimed. No Rust tests were run because
Rust/host behavior is unchanged. Existing Lens internal request/poll orchestration
is not newly extracted or individually proven by this slice; its parent mirror is.

The historical broad baseline remains **33 passed, 2 failed, 2 skipped**. The
broad suite is not rerun here. Mapping-create case 6 (source key to / to_2) remains
a known failure, unmodified and excluded. A passing comparison rerun would not
prove its historical timing failure fixed; report each run independently.

## PR-05 handoff — not implemented here

1. Reverify live HEAD/status; external commits are possible. Preserve this work,
   the PR-04A preview owner and unrelated ignore edits without index operations.
2. Keep Join controller, preview controller and project lifecycle separate.
   QueryContext is not an execution framework; do not introduce another host
   lane, a generic DuckDB service, a store/bus or a universal setter interface.
3. App still owns schema inference, Model SQL and domain transformations. Join
   Lens internal execution remains unchanged; do not describe the parent progress
   extraction as a full Lens rewrite or move it into preview.
4. Keep replacement-only reset ports and independent lifecycle errors; preserve
   original Matching Join capture, stable mounted editor API registration,
   acknowledged Save, explicit non-writing demo and live-unavailable policy.
5. Preserve explicit test-only Matching discard teardown. Treat new held Join
   values as synthetic timing evidence, not live retrieval or engine performance.
6. Carry broad historical failures independently. Investigate the comparison
   timing symptom using baseline/current snapshots before claiming causality;
   do not silently fold mapping-create case 6 into an extraction slice.
