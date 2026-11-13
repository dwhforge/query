# PR-05 delivery report — Query workspace and local Inspector ownership

## Starting state and scope

Verified live HEAD **e30220ac98a86a1c5a7bb8799217c2441fc49a02** and an empty
index. PR-04B was present as unstaged/untracked work. Saved a read-only starting
working diff and App snapshot under the temporary directory before extraction.
No staging, reset, checkout, commit, host, IPC, IR, dependency, Compare, plugin,
store or event-bus changes were made by this slice. The ignore file was not edited.
Final verification retained the same HEAD and empty index; reviewed delta and
merged capability requirements match exactly. Whitespace validation passed.

Read agent/Cursor guidance, Accepted ADR-0031/0032/0039/0044/0045/0046/0047,
relevant merged contracts and PR-01/02/03/04A/04B handoffs. Prepared proposal →
capability delta → design → tasks before runtime edits. No new ADR/product
decision is introduced. This is only the sequential roadmap's extraction PR-05,
not the older UX roadmap's similarly numbered presentation work.

## Before / after responsibilities

| Owner | Before | After |
|---|---|---|
| [App](../../../src/App.tsx) | Query graph/result/Inspector markup, all step-family drafts/refs, query-wide hydration, schema requests, shell and cross-tool application effects | Overall frame/menu/Explorer, top-level tool tabs and mounted Mapping/Matching sessions, semantic navigation and domain transformation adapters, independent scenario controllers, shared panel geometry, narrow Lens integration |
| [QueryWorkspace](../../../src/components/query/QueryWorkspace.tsx) | Absent | Graph/result/Inspector composition; typed graph and geometry ports; named shell-content slot; mounted visibility rather than draft reset on tool/side-bar hiding |
| [QueryResultDock](../../../src/components/query/QueryResultDock.tsx) | Embedded in App | Data/Model toolbar, preview phases and Sample/Full actions, diagnostic samples, result table and generated model SQL; distinct preview/Join view-and-action ports |
| [QueryInspector](../../../src/components/query/QueryInspector.tsx) | Embedded in App | Query focus/publish/execution controls, source schema and external read-only context, Applied Steps, add-step controls and identity-scoped editor composition |
| [QueryStepEditor](../../../src/components/query/QueryStepEditor.tsx) | Global shared draft fields for all kinds | Dispatch only; concrete families get only required read/command ports, never setters from App |
| [Text editor](../../../src/components/query/TextStepEditor.tsx) | Shared Filter/SQL/Group/Sort/Limit/Rename fields and DOM refs | Local fields/refs seeded from the selected step, no rehydration from the first same-kind step in the query |
| [Columns editor](../../../src/components/query/ColumnsStepEditor.tsx) | App upstream request and selection state | Owns upstream choices/request lifetime; [Fields control](../../../src/components/SelectColumnsEditor.tsx) retains visible text independently of normalized IR |
| [Derive editor](../../../src/components/query/DeriveStepEditor.tsx) | Shared expression/mode/operation state | Local expression and ready-made-operation controls; existing engine/dialect transform semantics |
| [Join editor](../../../src/components/query/JoinStepEditor.tsx) | App right-query/type/key refs, hydration and schema effect | Local right/type/key draft and schema lifecycle, existing JoinKeyEditor, host-scoped read-only draft API for canvas connection |
| [Relation editor](../../../src/components/query/RelationStepEditor.tsx) | Shared From/Append picker state | Local target pickers with existing local/external object-target parsing |
| [Mapping step editor](../../../src/components/query/MappingStepEditor.tsx) | Global document lookups for Normalize/Apply fields | Editor-local DOM scope/fields, existing transformation and Mapping-open commands; no Mapping document ownership change |
| [Load editor](../../../src/components/query/LoadStepEditor.tsx) | Embedded source-step view | Source-path view and existing Change file command; no new source persistence or file-picker policy |
| [Column transitions](../../../src/components/query/columnDraft.ts) | Apply reset the Fields input using normalized selection | Pure choose/edit/toggle transitions; Apply reads selected columns without rewriting visible comma/whitespace text |

Against the actual PR-04B working App snapshot: **7,732 → 5,923 lines**,
**102 added / 1,911 removed**, net 1,809 fewer. This is not a line-count-only
split: App no longer owns Inspector draft setters, DOM refs, hydration effects or
editor schema orchestration. There is no universal hook exposing a setter bag.

### Explicit narrow adapters / remaining App ownership

The existing JoinLens view remains App-controlled as one named result slot.
Its callbacks bridge Mapping writes, original-Join Matching session creation,
lab assistance and the independent Join owner's busy lease. Moving those effects
inside the workspace would either cross scenario boundaries or require a broad
callback bag. The Lens UI and its internal orchestration were not rewritten.
JoinDiagnosticsPanel receives a small view slot bound to its existing independent
controller; it cannot hydrate editor fields. All remaining result-dock UI is local
to QueryResultDock, not passed as an opaque App-rendered dock.

Shared frame dimensions stay in App through a typed geometry port because the
menu's explicit Focus Join Lens action resizes/collapses the same overall frame.
The shell-content slot retains the shell's top-level tool tabs, guidance and
mounted other-tool views. It does not transfer Mapping/Matching document state
or their Save APIs to QueryWorkspace. Project transformations, Model SQL requests,
file-picker authoring and cross-tool handoffs remain existing application effects.

## Draft and request contract

- Editor identity is a serialized tuple of replacement generation, query id,
  step index and step kind. It is not a workspace/IR fingerprint. Same-kind steps
  in different queries or at different indices cannot share an input instance.
- Apply normalizes committed IR where existing transforms already did so, but
  does not remount text inputs or change their visible user text. GroupBy comma
  formatting, Filter whitespace and Fields ordering/whitespace remain visible.
- Recompute, schema completion, unrelated project renders, Save and tool-tab
  navigation do not reseed the same editor. Collapsing the Inspector or visiting
  the quality tool hides, rather than destroys, that editor.
- Selecting a different query/index/kind hydrates that target's committed IR;
  successful project replacement changes generation even if ids match. This is
  not a multi-target uncommitted draft cache or durable formatting/restart store.
- Unapplied text is not silently project-saved and does not introduce a new
  lifecycle dirty-document category. Explicit Apply/Save policy is unchanged.
- Join/Fields request effects invalidate their own completion lifetime. Late
  replies can only supply choices/loading, never text/key hydration. Join retains
  overlay/Help/quality availability and full quality-Join schema exclusion.
- Canvas may read only its host query's mounted Join draft. It cannot write
  editor fields or borrow another query's draft. Existing application transforms
  remain the authoring source of truth.

## Preserved contracts

Independent Query preview and JoinDiagnostics controllers and replacement-only
reset ports; lifecycle dirty baseline/late edits/errors/Cancel/replace semantics;
typed tab identities and mounted Mapping/Matching state; captured original Join
return; stable Mapping Save API registration and acknowledged Matching Save;
explicit non-writing offline demo and truthful live-unavailable behavior; sample
versus full-input proof; Help Lab discovery, task/hints/focus and comparison.

Starting-patch comparison verified the pre-existing navigation tests, reset
adapter/tests and bridge/E2E-helper changes remained byte-for-byte unchanged by
PR-05. No edits were made to the prior preview, Join, navigation or lifecycle
controllers, JoinLens, Mapping editor, Rust or manifests. Existing transformations
were reused, not replaced by another authoring service/store.

## Validation history

- All **40 frontend unit files passed**, including new pure column-draft
  transitions; [final unit log](../../../../../../tmp/pr05-units-final.log).
- Initial focused Inspector Electron: **5 passed (33.1 seconds)**;
  [log](../../../../../../tmp/pr05-inspector-initial.log). This includes same-kind
  step/query hydration and exact Filter input, GroupBy recompute/tool retention,
  held upstream Fields response, held Join schema across query/step changes,
  real dirty guard / ordinary Save / explicit export focus.
- First combined rebuilt Electron: **46 passed, 14 failed (5.6 minutes)**;
  [log](../../../../../../tmp/pr05-electron-final.log). Failures include page or
  browser closure during launch/before assertions and mid-scenario closure; this
  run is not green. No runtime/harness policy change was made to explain them
  away. The unchanged comparison case passed in this run; no causal fix is claimed.
- Second rebuilt combined run: **51 passed, 9 failed (9.5 minutes)**;
  [log](../../../../../../tmp/pr05-electron-rerun.log). All five Inspector cases
  passed. Failures were six launch closures, one fixture-open timeout, one
  closure during held-status release and one other closure. Comparison passed
  again, sometimes slowly. This is also not a green combined suite.
- A diagnostic invocation through the existing npm wrapper failed **before test
  execution, exit 127**: its nested shell interpreted the pipe-separated grep
  expression as commands and the reporter hit EPIPE. This was a command/harness
  invocation error, not an application-test result. Preserved
  [log](../../../../../../tmp/pr05-electron-closure-check.log). No wrapper change
  is included in PR-05; the corrected invocation uses the existing Playwright
  Node CLI directly after rebuilding the E2E UI.
- Final direct-CLI diagnostic rerun: **14 passed (1.7 minutes), exit 0**, with
  no retries or weakened assertions. This includes all nine scenarios that failed
  in the preceding combined run and all five new Inspector cases. The corrected
  command rebuilt the E2E UI and enabled browser-process logging, but changed no
  application or launch/teardown policy. Evidence:
  [diagnostic Electron](../../../../../../tmp/pr05-electron-diagnostic.log),
  [E2E build](../../../../../../tmp/pr05-diagnostic-ui.log).
- Final ordinary production build: **passed, exit 0**, with the existing large-
  chunk warning; [log](../../../../../../tmp/pr05-build-final.log). Final all-unit
  rerun also passed all **40 files** after the last source edit (restoring the
  Mapping step editor's existing vertical spacing).

All 60 selected scenarios have passing evidence across these runs, but there is
**no consistently green 60-test combined run in PR-05**. The final 14-case run
does not reproduce or causally explain the intermittent closures/fixture-open
timeout. Do not describe those failures, or the historical comparison timing
symptom, as fixed by this extraction. The combined-suite reliability gap remains
explicit follow-up evidence for tooling/environment investigation.

The focused selection is execution states, Query navigation (including all five
Join races), lifecycle replacement, workspace tabs, Matching Save/demo/live, all
ten flagship journey scenarios and five new Inspector scenarios. Tests use the
existing release host, explicitly skipping its rebuild because host code is
unchanged; each Electron entry point rebuilds the E2E renderer. Existing response
holds are reused without bridge/IPC changes. Matching teardown explicitly
discards its fixture draft only after assertions, before closing Electron.

## Screenshots and manual gaps

Actual mounted Electron screenshots were captured and read back:
[GroupBy / result / shell](../../../docs/stabilization/pr05-inspector-group.png)
and [Join editor after held-schema navigation](../../../docs/stabilization/pr05-inspector-join.png).
They show the composed graph, dock and Inspector; the Join capture can show a
pending recomputation and is not full-input result proof. They are automated
screenshots, not a claimed human interactive visual/cross-platform pass.

No manual own-data/export workflow, real PostgreSQL race, external LLM, native
dialog happy path, crash/restart recovery or complete user-data repair/Save As/
reopen/export journey is claimed. No Rust suite was run for this frontend-only
slice. The historical broad baseline remains **33 passed, 2 failed, 2 skipped**;
the broad suite was not rerun. Mapping-create case 6 (source key to / to_2) remains
an unchanged separate task. Passing comparison reruns do not establish its
historical timing symptom repaired.

## PR-06 minimal tooling handoff — not implemented

1. Reverify live HEAD/status and preserve these unstaged slices and any external
   commits/ignore edits. No index operations are authorized by this report.
2. Keep PR-06 conditional and tooling-only: document/run the existing production
   build, all-unit and focused Electron recipe; new unit discovery already works.
   If useful, add a small dependency-boundary/import check for query views versus
   scenario controllers, not a registry, plugin API, runtime/store or event bus.
   The existing Electron npm wrapper's nested shell also needs a small argv-
   forwarding/quoting test before it can reliably accept pipe/space-containing
   grep expressions. Direct Node CLI invocation avoids that shell for diagnostics;
   do not mix the wrapper repair into the view extraction.
3. Keep separate evidence logs for launch/teardown failures versus behavioral
   assertions. The held read-response helpers are test-only; do not generalize
   them into an application execution service. Retain Matching discard teardown.
4. Do not relocate domain transforms into views or merge preview/Join/lifecycle
   owners. The explicit Lens slot and shell geometry port are known narrow
   boundaries, not an invitation to pass all App callbacks through a universal API.
5. Compare functionality, live Matching retrieval, persistence policy, durable
   drafts and mapping-create case 6 require separate authorized product work.
