# Current checkout investigation and capability reuse inventory

## Reproducible baseline

Inspected 2026-11-15: branch **feature/redesign**, HEAD
**0c152c8fa0a8b86f037389617ba8eb9a8d24a9cd**. Initial short status had no entries.
No fetch, branch change, commit or runtime modification was performed. This packet
is based on the checked-out files, not assumptions from historical reports.

Read repository [agent rules](../../../AGENTS.md),
[ADR/OpenSpec rules](../../../.cursor/rules/adr-openspec.mdc),
[product design](../../../docs/DESIGN.md), [product IR](../../../docs/SPEC.md),
[ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md), relevant earlier
ADRs linked by [ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md),
the [OpenSpec index](../../README.md), merged Matching/batch/Suggest Right,
JOIN diagnostics and Help Lab contracts, and the active predecessor packet and
[P1 report](../unified-matching-workspace/p1-residual-report.md).

## Implementation inventory: reuse, not replacement

| Capability | Evidence / reuse point | Consequence for redesign |
|---|---|---|
| One in-process session owner | [App session ownership](../../../src/App.tsx:801), [mounted tabs and callbacks](../../../src/App.tsx:5455) | Keep the existing tab/session; no second workspace or store |
| Exact tuple identity | [tuple token](../../../src/app/matching/types.ts:239), [Basic candidate identity](../../../src/app/matching/basic.ts:10), [Advanced candidate identity](../../../src/app/matching/advanced.ts:63) | Use structured tuple tokens and run namespaces; never label/delimiter identity |
| Separate evidence and decisions | [session types](../../../src/app/matching/types.ts:72), [ledger decisions](../../../src/app/matching/types.ts:124) | Reverse indexes are read projections only |
| Decision/status/bulk/diff | [review logic](../../../src/app/matching/reviewLogic.ts:294) | Reuse validation and counters with clearly specified units; no new decision authority |
| Basic producer | [adapter](../../../src/app/matching/basic.ts:24) | Bounded unmatched LEFT tuples; acquired RIGHT universe, occurrences, edges and coverage already available |
| Advanced producer | [adapter](../../../src/app/matching/advanced.ts:101), [Host acquisition](../../../crates/dwh-engine/src/matching_join.rs:90) | Actual prefix fields and independent identity; no fabricated extra business fields |
| Verified manual lookup | [source-scoped service](../../../src/app/matching/advanced.ts:279), [current UI flow](../../../src/components/MatchingWorkspace.tsx:1692) | Preserve page/source/run ownership and exact lookup replay; searching is not confirming |
| LLM merge and ranking | [Basic merge](../../../src/app/matching/basic.ts:108), [current assistant operations](../../../src/components/MatchingWorkspace.tsx:517) | Move presentation only; permission, budgets, cancellation and allowlists survive |
| Semantic invalidation | [plan/run invalidation](../../../src/app/matching/advanced.ts:330), [current editor](../../../src/components/MatchingWorkspace.tsx:449) | UI disclosure/focus cannot change semantic revision or rerun |
| Atomic JOIN-bound write | [App private fold and publication](../../../src/App.tsx:3322), [Basic verification](../../../src/App.tsx:3402), [Advanced service](../../../src/app/matching/advanced.ts:1) | Same original JOIN, live verification, reducer receipt and explicit refresh |
| Mapping-origin Save | [persistence service](../../../src/app/matching/persistSave.ts:1) | Remains separate from JOIN-bound atomic commit; no expansion of write support |
| Mapping rows/outputs | [Mapping helpers](../../../src/lib/keyMap.ts), [source paged/exact reads](../../../src/lib/bridge.ts:806), [query preview](../../../src/lib/keyMapQuery.ts:173) | Reuse authority and output bindings, not a second Mapping store |
| Executed relationships | [key explanation bridge](../../../src/lib/bridge.ts:454), [engine implementation](../../../crates/dwh-engine/src/join_lens.rs:875) | Explicit RIGHT-side query gives counts plus capped samples, not full alias enumeration |
| JOIN-wide diagnostics | [engine diagnostics](../../../crates/dwh-engine/src/join_diagnostics.rs), [controller](../../../src/app/joinDiagnostics/controller.ts) | Existing actual fan-out facts, not proposal counts |
| Lens compatibility | [existing Lens](../../../src/components/JoinLens.tsx), [Candidates](../../../src/components/JoinLensCandidates.tsx), [Suggest Right](../../../src/components/FindRightDialog.tsx) | Preserve No match/Candidates and separate single-source modal |

## Observed gaps and limits (not new implementation claims)

1. [The current primary table](../../../src/components/MatchingWorkspace.tsx:1370)
   uses tiers and technical target IDs. The [detail comparison](../../../src/components/MatchingWorkspace.tsx:1846)
   compares proposed/alternative target fields rather than a clear LEFT/RIGHT
   business-record pair. Source keys are delimiter-displayed; composite labels
   need individual field names. Reverse focus has no first-class session view.
2. [Empty session defaults](../../../src/app/matching/types.ts:254) create empty
   baseline/live arrays; [Advanced installation](../../../src/app/matching/advanced.ts:179)
   clears them. [Mapping-origin persistence](../../../src/app/matching/persistSave.ts:132)
   populates a live baseline during Save, including only touched source keys for
   source storage. Therefore empty arrays do **not** prove an empty saved Mapping,
   and a Save baseline does **not** prove complete reverse coverage.
3. Basic maps its entire acquired RIGHT tuple universe into candidates, but source
   proposals cover unmatched keys only. Advanced acquisition can have more target
   records than the installed candidate shortlist; use its acquired target rows
   as read-only record references, not automatic source admissibility evidence.
4. [Advanced acquisition](../../../crates/dwh-engine/src/matching_join.rs:121)
   supports exact/full scopes at engine level, but [current service](../../../src/app/matching/advanced.ts:218)
   refuses selected/cohort sessions without an exact bound source. It acquires
   unmatched LEFT context groups for this workflow. Over-cap source groups or
   RIGHT acquisition **refuse**, rather than becoming an unlabeled sample.
   Current [caps](../../../src/lib/matchingCaps.ts:15): 20 trial keys, 200 mass
   keys, 40 shortlist entries, 10 LLM candidates/key and 10,000 local target rows.
   Do not change these to make the redesign appear complete.
5. [Key explanation](../../../crates/dwh-engine/src/join_lens.rs:832) returns full
   query-time row counts and at most 50 LEFT, RIGHT and result rows each. The side
   parameter changes input-side interpretation/expansion, not a general reverse
   predicate. Counts are **rows**, not distinct original LEFT aliases. SQL equality
   governs NULL; equal displayed NULLs are not actual JOIN matches. RIGHT output
   keys identify a JOIN-key group, not necessarily one independent target record.
   Inspect outer-JOIN result counts separately from matched pairs: a result row
   alone is not proof of a partner. No historical last-preview snapshot is returned.
6. [Source Mapping reads](../../../src/lib/bridge.ts:806) filter by From prefix or
   exact From tuples, not complete RIGHT output equality. [The page hash](../../../crates/dwh-engine/src/key_map_write.rs:1058)
   hashes page contents, **not** a whole-table snapshot. Reading one page or exact
   review keys cannot establish complete RIGHT → LEFT Mapping coverage.
7. [Query-backed preview](../../../src/lib/keyMapQuery.ts:159) is bounded (up to
   500), and ref-backed execution retains existing availability limits. Neither
   inline entries nor a preview should be mistaken for their authoritative full
   relation. Existing Matching writes to ref/query/range maps remain refused.
8. [App tabs](../../../src/App.tsx:5455) stay mounted while hidden, preserving local
   state. Current [detail request generation](../../../src/components/MatchingWorkspace.tsx:1714)
   handles lookup supersession; a reverse inspection needs its own monotonic
   intent guards, not only matching a selected key after A → B → A.

## Host capability verdict

**No additional Host RPC is necessary for the proposed bounded workbench.**

| Relationship question | Renderer-only? | Existing fresh acquisition / honest boundary |
|---|---|---|
| Which acquired proposals reference this target? | Yes: sparse source edges and candidate IDs | Complete only within installed session edges, never all eligible matches |
| Which draft sources confirm this target? | Yes: exact ledger joins | Current verified run/revisions only; stale decisions are inspection-only |
| Which project-seed rows output this tuple? | Yes, if a compatible authoritative project definition is available | Complete within that definition, not proof of exported-file synchronization |
| Which external Mapping rows are associated? | Only for already acquired rows | Existing source pages/exact-From reads or query preview; disclose partial coverage; no whole-table reverse query claim |
| Which currently executed LEFT rows match this RIGHT key? | No, not from proposals | Explicit existing key explanation, full query-time row counts plus up to 50 samples; refuse complete enumeration beyond it |
| Which original aliases produced a transformed JOIN key? | Not generically | Saved Mapping aliases are a separate group; arbitrary transform lineage is unavailable |

Do not implement a Cartesian join in React. If later acceptance requires complete
large external reverse filtering or stable multi-page execution snapshots, first
demonstrate the existing API gap and review a bounded Host contract with typed
identity, limits, refusal and lifecycle tests. This packet does not authorize it.

## Verification inventory and gaps

| Existing suite | What it exercises | Reuse / extension gate |
|---|---|---|
| [Workspace browser](../../../src/components/MatchingWorkspace.ui.spec.ts), [workflow browser](../../../src/components/MatchingWorkflow.ui.spec.ts) | 1–5 fields, separate selection, manual search, undo/bulk, LLM, invalidation, receipt, bounds | Extend for readable fields, reverse groups and navigation; mocked component evidence is not Host acceptance |
| [Basic Electron](../../../e2e/electron/join-batch-save.spec.ts) | Real CSV/fuzzy, loopback LLM, atomic write, Save/cold reopen for 1–5 keys | Retain actual Host journey and adapt selectors, not the behavior assertions |
| [Advanced Electron](../../../e2e/electron/matching-advanced.spec.ts) | Actual prefix fields, hard/soft/reference rules, rerun, write and cold reopen | Preserve full pipeline through new inspector |
| [Residual Electron](../../../e2e/electron/matching-residual.spec.ts) | Beyond-shortlist real lookup, exact page replay, late replies, original JOIN/context/project ABA, failed Apply and Save/write serialization | Extend with reverse focus ABA and pending inspection close, using real IPC response holds |
| [Mapping Save Electron](../../../e2e/electron/matching-save.spec.ts) | Real Save guards with explicitly synthetic session evidence | Retain, but do not call this live retrieval/reverse acquisition coverage |
| [Candidates Electron](../../../e2e/electron/join-candidates.spec.ts), [Suggest Right Electron](../../../e2e/electron/join-tuple-save.spec.ts) | Existing independent Lens/modal workflows | Must remain functional without another batch workspace |
| [Help Lab Electron](../../../e2e/electron/help-lab-journey.spec.ts:147) | Vendor exact-pair No match context and modal; flagship reconciliation | Add actual Matching/reverse/write/recheck journey to existing vendor lab |

The [runner](../../../scripts/run-electron-e2e.mjs) rebuilds release Host and E2E
UI, and [launch helper](../../../e2e/electron/helpers/launch.mjs) isolates sessions.
Portable-beside-app Host precedence must be recorded, not ignored. Native suites
should remain serial per the predecessor's reported parallel-native risk.
Historical pass counts in the [P1 report](../unified-matching-workspace/p1-residual-report.md)
are prior evidence, not tests rerun for this packet. No runtime tests were run in
Phase 1 because runtime was deliberately unchanged.

## Existing Help Lab choice

Reuse [vendor fixtures](../../../fixtures/labs/name_region_match/) and
[generator](../../../crates/dwh-host/src/demo_help_labs.rs:219). Exact-pair JOIN
uses vendor label/region → vendor name/region. Its existing seed instead outputs
vendor ID for a different mapped query: **do not attach it as a compatible
name/region baseline**. Derive the baseline from the map actually selected by
existing atomic preparation. The name-only query provides genuine executed
fan-out; repeated invoices distinguish row counts from distinct keys. Preserve
the existing flagship reconciliation scenario and do not manufacture a new demo.
