# Design: Unified Batch Tuple Matching

Decision: [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md).
Normative behavior: [merged contract](../../specs/unified-batch-tuple-matching/spec.md).

## Existing implementation boundaries

1. [JoinLensAuto](../../../src/components/JoinLensAuto.tsx:28) now implements
   the **Find Matches** batch session. Its retained internal name does not mean
   the primary UI still offers scalar/composite modes. The existing tuple request
   retrieves all ordered Join fields; missing tuple results fail without fallback.
2. [Batch helpers](../../../src/lib/joinLensBatch.ts) own canonical local context,
   complete-source queue identity, initially pending/unselected proposals, bounded
   prompts and allowlists, provenance deduplication, and accepted-row collection.
   Manual search pages the retrieved universe, not the warehouse. The UI's live
   decisions reference prevents a same-turn LLM callback from overwriting a user
   decision; generation/unmount guards reject old asynchronous results.
3. [planBatchTupleMapping()](../../../src/app/keyMap/tupleMapping.ts:13) validates
   exact selections, rejects an incompatible Join-associated map, and stages each
   addition in private values using the existing single-tuple planner. It rejects
   repeated source keys and validates every row of the resulting ready map, not
   just touched rows. It deliberately avoids the legacy editor trim/clean path.
   Generated map From/output names are disjoint; outputs bind by name to every
   aligned left destination. Existing equal outputs are no-ops; conflicts fail.
4. [App batch handler](../../../src/App.tsx:3280) checks live Join/frozen context,
   fingerprint and editor draft/dirty/Save state. It privately upserts the planned
   map, resolves the existing ApplyPlan with explicit left bindings, and invokes
   the established Apply fold. It never publishes an intermediate map or invokes
   an LLM inside Apply.
5. [Guarded reducer](../../../src/App.tsx:380) publishes the folded project only
   if the current project is the captured expected object. A separate
   [receipt effect](../../../src/App.tsx:1566) acknowledges success/failure and
   updates editor/session feedback only after commit, outside reducer/updater
   side effects. The pending transaction and UI locks prevent duplicate writes.

## Freshness and privacy

### Review follow-up implementation

- The batch prompt is now purpose-built: one alignment, grouped complete-source
  allowlists and one response schema. One parser validates all groups in a single
  payload; multiple payloads are rejected rather than silently losing later ones.
  The single-source Suggest Right prompt/parser are unchanged.
- Explicit bulk draft acceptance reuses the Rust cutoff (0.88) and ambiguity gap
  (0.03), but checks every scored competitor, including below-cutoff ones. It
  excludes incomplete right coverage, unknown scores, unsafe values, competing LLM
  alternatives and touched decisions. Counted bulk acceptance/undo never writes.
- A local typed commit receipt carries the expected resulting context and Join
  index. The wrapper can show success after the child remounts, but only across
  the exact origin-to-committed-context transition. Project-session identity and
  transition history reject ABA/intervening edits. The containing Lens survives
  its own preview reset and Apply-induced index shift. Old decisions are cleared;
  remaining retrieval requires an explicit refresh. Receipt tokens remain local.

The [fingerprint](../../../src/lib/joinLensBatch.ts:12) is canonical serialized
local definitions, not an opaque safe-to-log digest. It includes full workspace,
Join identity, connections (including secrets), sources and project references.
Keep it local; prompts contain only bounded ordered columns/source/candidate
evidence and bounded chat, never this token or connection definitions.

The fingerprint catches definition changes, including upstream ones. It does
**not** watch external CSV/Parquet bytes or database rows changed in place.
The reducer's project-object check is an additional local lost-update guard, not
a substitute for external data versioning. Batch staging is not durable across
restart; only explicitly saved project Mapping/Apply state persists.

## Reuse, not a new engine or Mapping store

The [Rust tuple scorer](../../../crates/dwh-engine/src/join_fuzzy.rs:247) remains
the ADR-0049 implementation: all aligned field scores, equal-weight mean, 200
tuples per side and 0.88 cutoff. The renderer limits initially displayed fuzzy
alternatives to 8, manual pages to 20, LLM groups/candidates to 4 × 12 within a
10,000-character prompt budget, and history to 6 × 4,000 characters. Report
omissions explicitly; character caps are not tokens or a whole-session call cap.

The existing [tuple value gate](../../../src/lib/joinLensTuple.ts:18) blocks
NULL/empty/whitespace-only authoring while preserving significant whitespace and
literal display markers. Existing seed multi-output Mapping, ApplyPlan revision
checks, runtime prepare/validate/execute and persistence remain authoritative.
Project publication does not itself execute SQL, save the project file, or write
a warehouse table. Suggest Right and contextual Matching implementations are not
modified, and their different workflows are not routed through this batch UI.

## Verification boundary

The [new Electron test](../../../e2e/electron/join-batch-save.spec.ts:34) combines
real CSV/Rust fuzzy retrieval, an actual local HTTP mock LLM, three explicit
acceptances and one write, execution, Save and fresh-process reopen at arities
1–5. Browser mocks cover session/error cases, not native persistence. The
[report](report.md) records supplied results and exact rerun entry points, plus
the parallel native SIGSEGV and connector/model/workspace gaps. No broader
regression or arbitrary-arity exhaustiveness is inferred.
