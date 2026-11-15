# Unified Matching Workspace — implementation and verification report

## Status and revisions

Basic live, Advanced live and read-only Lens Candidates are implemented and
verified. Delivered contracts are merged into capability SoT. **The change remains
open for residual acceptance**, not an assertion that every planned extension or
adversarial race has been tested. See the unchecked [tasks](tasks.md).

**Residual P1 update:** bounded Host-verified Advanced lookup beyond shortlist and
the requested critical real App/Electron interleavings are now implemented and
verified. Final combined matching/persistence run: **39 passed (3.6 minutes)**,
including 16 new residual cases. Details, exact commands and failure history are
in the [P1 residual report](p1-residual-report.md). Remaining P2 concerns are
dictionary-scale performance, practical confidence-bulk coverage and the still
unproven cause of the historical preview failure. This does not claim full-scale
product acceptance or complete proof of every possible race.

- Requested and initially verified baseline: **30ead1dfd6e30b76865ca19d7b7d696134a4db18**,
  branch **feature/redesign**; initial working tree clean.
- The requested origin fetch failed because no origin remote exists. Fetching the
  configured query remote succeeded and initially matched that exact baseline.
- Published accepted-increment HEAD: **342ecfdc78353c5b74bd41b212f95b306558ba1e**.
  Rechecked on 2026-11-15 after fetching the configured query remote: local HEAD
  and remote feature/redesign matched, with a clean working tree. This commit
  contains the Candidates, cleanup, migrated tests and documentation described
  below; they are no longer described as unpublished changes.
- Historical pre-publication verification used HEAD
  **5820b99aad33f31c52927a323ee9daa51b79d2d5** plus working-tree changes. That was
  the actual state when the earlier run was recorded, not the published result.
- Residual P1 implementation now proceeds from **342ecfd**. New lookup/concurrency
  edits are uncommitted until explicitly recorded otherwise; earlier test counts
  below remain evidence for the accepted increment, not claims about new edits.

## Architecture and reused capabilities

One existing Matching tab, existing session owner and existing proposal/candidate
model own both producers. There is no new tab mechanism, fuzzy engine, LLM parser,
Mapping store or independent mutable batch decision array.

- [Shared model](../../../src/app/matching/types.ts) and
  [review logic](../../../src/app/matching/reviewLogic.ts): one authoritative
  full-source-key decision ledger; suggested candidate, temporary selection,
  explicit confirmation and persistence receipt remain different operations.
- [Basic adapter](../../../src/app/matching/basic.ts) reuses existing real tuple
  retrieval and [batch prompt/parser/policies](../../../src/lib/joinLensBatch.ts).
  Pure legacy-shaped invocation projections are not a second stateful review.
  Exact nullable ordered tuples, JSON-array identity, occurrences, all scored
  competitors, field scores, provenance, alternatives and incomplete coverage
  survive adaptation. NULL and empty strings are never collapsed.
- [Advanced service](../../../src/app/matching/advanced.ts) reuses
  [contextual trial](../../../src/app/matching/runTrial.ts), the existing
  contextual engine, semantic expansion and ranking. Host acquisition reads actual
  selected fields from the original left pre-JOIN input after preceding transforms
  and the consumed right output. It is not a preview or JOIN-key-only reconstruction.
- [Shared workspace](../../../src/components/MatchingWorkspace.tsx) retains
  review/detail/evidence/alternatives/final diff, filters, search, score sorting,
  pagination, draft bulk and undo. Basic manual browsing pages its retrieved right
  universe; no per-source card explosion. Plan editing does not create a new Review.
- Existing Matching tab mounting preserves plans, decisions, alternatives and local
  presentation across ordinary application navigation without rerunning searches.
  No restart-restorable draft was added.

### Basic and Advanced semantics

The normal JOIN entry builds a usable full-scope default plan. Ordered LEFT JOIN
keys are Mapping inputs and ordered RIGHT JOIN keys are outputs; a target record
ID is not implicitly a Mapping output. Basic handles 1–5 keys with no scalar fallback.
Fuzzy and bounded batch LLM add proposals, never confirmations, and late replies
respect the current ledger. Conservative confidence bulk preserves the complete
competitor policy; explicit reviewed bulk is a separate counted operation.

Advanced semantic edits require confirmation and invalidate stale evidence without
automatic rerun. Additional real fields, normalized hard equality, scored soft
signals and non-filtering/unscored reference context are enforced in the existing
engine. Real derived pre-JOIN fields, independent target identity and JOIN outputs,
plan rerun, LLM ranking, tab retention and writes are proven through Electron.
Unknown/unsafe/incomplete evidence does not gain bulk eligibility from an LLM score.
Unsupported selected/cohort Advanced UI scopes refuse rather than silently widening
to full input. SQL cap checks occur before row transfer (trial 20 keys, mass 200,
target 10,000); NULL/missing contextual fields, identity/context conflicts and
over-cap inputs currently refuse explicitly.

### JOIN-bound commit

Both producers use the original session JOIN binding, not the currently selected
canvas step. Host reacquisition verifies candidate membership, plan/evidence/run
identity and outputs. [The existing batch planner](../../../src/app/keyMap/tupleMapping.ts)
prepares complete Mapping + Apply privately; the guarded project reducer publishes
once. Dirty Mapping/save-flight/incompatible-map/stale ownership gates remain.
The typed receipt carries the owned transition and shifted JOIN index. Pending
locks and exact reducer acknowledgement prevent repeat writes. Old actionable
review is cleared only on acknowledgement; remaining search requires an explicit
refresh. Unchanged-context failures retain retryable decisions. Project Save is
separate. Standalone Mapping-origin sessions retain their existing persistence
semantics, and demo/fixture evidence cannot write to user Mappings.

Cleanup added further Advanced guards against review mutation during acquisition,
LLM ranking and verification, exact materialized-decision mismatches, stale/ABA
receipt transitions, and unsupported scope. Basic uses the same lifecycle rules.
These are targeted safeguards, not a broad App/project-store refactor.

### Lens Candidates and removed UI

[Join Lens](../../../src/components/JoinLens.tsx) exposes All rows and No match,
with one Find Matches entry opening the existing Matching tab. RIGHT under No
match has No match / Candidates. The original unmatched-right list is preserved.
[Candidates](../../../src/components/JoinLensCandidates.tsx) calls the existing
focused tuple fuzzy path for one exact selected LEFT tuple. Top-8 real RIGHT tuples,
mean/field scores, differences, occurrences and coverage are read-only; targets
already joined elsewhere remain inspectable. First opening is lazy, new selections
use explicit retrieval or an exact cache hit, the LRU holds at most 16 results,
and generation/context/ABA guards reject late replies and errors. There are no
accept, Mapping, LLM or batch actions in Candidates.

[Suggest Right](../../../src/components/FindRightDialog.tsx) is unchanged from the
requested baseline and remains modal. The obsolete inline batch component and its
configuration were removed only after equivalent workflow coverage was migrated
to [shared workflow tests](../../../src/components/MatchingWorkflow.ui.spec.ts).
Pure batch helper tests and all real batch/Suggest Electron journeys remain.

## Final verification actually executed

Linux; native tests serial; browser tests use installed Chromium; Electron uses
Xvfb, a fresh release Host/UI build, actual temporary CSV/DuckDB data and a loopback
HTTP provider for LLM responses. Browser doubles are not presented as Host proof.
Earlier phase evidence/failures remain in the [Basic](phase2-basic-report.md),
[Advanced](phase3-advanced-report.md) and [Candidates](phase4-candidates-report.md) reports.

| Command | Final observed result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npm run test:unit` | All **49 files passed** |
| `npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | **41 passed**: retained shared-review tests plus migrated manual/LLM/context/receipt/ABA/scope workflow coverage |
| `npx playwright test -c src/components/JoinLensCandidates.playwright.config.ts` | **23 passed** |
| `npx playwright test -c src/components/FindRightDialog.playwright.config.ts` | **13 passed**, unchanged modal suite |
| `cargo test -p dwh-engine --lib matching:: -- --test-threads=1` | **38 passed** |
| `cargo test -p dwh-host --test join_tuple_suggest --test join_tuple_lifecycle --test matching_advanced_join -- --test-threads=1` | **18 passed**: 2 tuple verification/wire, 6 tuple execution/persistence, 10 Advanced acquisition/verification |
| `npm run build` | Passed; existing large-chunk warning |
| `bash scripts/check-generated-types.sh` | Passed; generated types fresh |
| `xvfb-run -a node scripts/run-electron-e2e.mjs join-candidates join-tuple-save join-batch-save matching-advanced matching-save workspace-tabs help-lab-journey` | **36 passed (2.8 minutes)** in one combined fresh-build run |
| `node scripts/test-ux-docs.mjs` | Final pass: **26 documents, 117 local links/media references**, source/license assertions; initial missing-report failure corrected by creating this report |
| `git diff --check` | Passed, including final documentation |

The Electron run covers Basic 1–5-key real Fuzzy/batch LLM/bulk/undo/atomic write/
execute/Save/cold reopen; real Advanced extra-field plan/constraints/ranking/
write/execute/cold reopen; Candidates before Suggest Right for 1–5 keys and an
already-joined RIGHT target with zero unmatched-right rows; Mapping-origin save/
retry/demo/fixture gates; mounted-tab retention/dirty-close/project replacement;
and the Help Lab journey. Context-sharing guard tuples remain isolated rather
than turning one source name into a global scalar alias.

### Failures and warnings, not hidden

- The Phase 4 combined run had 17 passes and one five-key cold-reopen preview
  failure; the unchanged targeted rerun passed. The final combined 36-test run
  passed without recurrence. This does not establish the preview flake's root cause
  or claim that every possible scheduling interleaving is fixed.
- Running the generated-type Bash script through the default shell failed on its
  pipefail option. Re-running it with Bash passed; no type check was weakened.
- A documentation patch initially missed a heading; it was inspected and reapplied.
- The optional command-line legacy-reference search could not run because ripgrep
  is not installed. Repository search instead found zero legacy component references
  under the source tree. Typecheck also confirms no deleted-module imports remain.
- Historical native parallel SIGSEGV remains unresolved. All reported native runs
  here were serial. Existing native warnings and bundle-size warnings remain.
- Earlier real fractional-score parsing corruption was fixed through exact float
  round-trip parsing, not relaxed comparison; the real RPC regression remains.

## Remaining work and known limitations

1. **Bounded Advanced extra lookup is now delivered**, superseding the earlier
   unfinished item: actual Host field/identity lookup, hard constraints, exact
   page replay, one ledger and real execute/Save/cold-reopen evidence. This still
   does not provide acquisition/search beyond the 10,000-row universe ceiling or
   prove performance on hundreds of thousands/millions of dictionary records.
2. The requested critical **real App/Electron** matrix now passes for both Basic
   and Advanced: held verification with JOIN deletion/upstream edits, project and
   context ABA, both orders of Mapping Save, and private Apply failure with retry.
   This is concrete evidence for those cases, not a mathematical proof of every
   possible interleaving or external warehouse transaction isolation.
3. LLM rank is proven live; a distinct live LLM expansion-added-candidate journey
   remains unverified. Engine expansion/hard-constraint tests pass.
4. Paid providers, PostgreSQL/Parquet matching, connector-scale behavior and parallel
   native execution remain unverified. No cross-platform release packaging claim.
5. Host verification is stateless reacquisition, not a durable authenticated evidence
   registry or snapshot isolation. Local definition fingerprints cannot detect every
   external file/database change in place; fingerprints are not persisted/logged.
6. Advanced selected/cohort UI scopes and nullable contextual wire fields refuse
   explicitly. Bounded search is not dataset-wide proof. Duplicate target rows can
   still fan out in the later JOIN even though Mapping Apply preserves rows.
7. Matching drafts have no restart restore. Mapping/Apply acknowledgement is not a
   project-file Save or an atomic transaction with an external warehouse/linked CSV.

Delivered contracts are merged into [Matching](../../specs/matching-workspace/spec.md),
[batch](../../specs/unified-batch-tuple-matching/spec.md) and
[Lens No match](../../specs/join-lens-no-match/spec.md). The remaining tasks stay
open; this report does not declare the entire requested acceptance matrix done.
