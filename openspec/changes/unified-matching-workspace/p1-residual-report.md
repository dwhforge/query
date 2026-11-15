# Residual P1 — verified Advanced lookup and real App concurrency

## Provenance and acceptance boundary

Feedback accepted the published core increment and identified two remaining P1
gates. Work began after fetching the configured query remote and checking a clean
checkout: local HEAD and remote feature/redesign both
**342ecfdc78353c5b74bd41b212f95b306558ba1e**. The original task baseline remains
**30ead1dfd6e30b76865ca19d7b7d696134a4db18**. Final HEAD is still **342ecfd**,
with uncommitted residual implementation/tests/docs. No commit was made here.

The main [report](report.md) and [tasks](tasks.md) now distinguish the published
342ecfd increment from the historical pre-publication 5820b99 plus working tree.
The two requested P1 gates are implemented and verified **within the explicitly
bounded Advanced input contract**. Full dictionary-scale acceptance is not claimed;
the P2 performance/bulk/preview risks below remain open.

## Advanced lookup beyond shortlist

The [Host lookup and verifier](../../../crates/dwh-host/src/commands/matching.rs)
now support explicit source-scoped manual lookup independent of shortlist size or
soft cutoff. It reuses actual bounded acquisition from the original pre-JOIN left
and consumed right inputs and compares the frozen snapshot before returning any
result. Lookup is a heavy read-only RPC, not a new engine, parser, store or ledger.

- Literal case-insensitive field/identity search, at most 200 search characters,
  stable target-ID ordering, 20 results per page, bounded aligned offset.
- Results contain actual identity, fields, complete ordered outputs, occurrences,
  source/run/evidence identity, total matches and bounded universe count/cap.
- The existing [pair comparison](../../../crates/dwh-engine/src/matching/retrieve.rs)
  was extracted and reused by shortlist ranking and lookup: normalized hard equality
  is never relaxed; soft signals are scored and reference context remains unscored.
  A zero soft score is not an inadmissibility rule for an explicit human choice.
- The existing [Review detail](../../../src/components/MatchingWorkspace.tsx)
  searches through Host, pages results and separates radio selection from explicit
  confirmation. Manual source–candidate evidence and lookup page metadata enter
  the same proposal and authoritative decision ledger. No parallel decisions.
- The [Advanced service](../../../src/app/matching/advanced.ts) and detail generation
  guards reject late query/source/run/context replies, changed decisions, closed
  sessions and ABA. Lookup itself does not modify the ledger.
- At commit, a manual decision supplies its exact source/query/page metadata. Host
  reacquires the actual inputs, checks snapshot/plan/session/run/evidence, replays
  that page and materializes actual target outputs. Ordinary non-manual choices
  still require source-shortlist membership. Invented IDs, mutated outputs/pages,
  foreign sources/revisions and hard-invalid targets refuse.
- Verification is stateless reacquisition/replay, **not a durable authenticated
  registry or proof that a historical RPC was issued**. Renderer claims alone do
  not authorize unknown or hard-invalid targets. External snapshot isolation is
  not added.

Initial Advanced runs now preserve their actual expansion/budget configuration for
lookup and commit replay. Previously the initial run allowed bounded expansion,
while verification rebuilt with expansion disabled; a source with no soft-qualified
candidates could therefore fail freshness comparison. Both 40-entry-shortlist and
empty-soft/expanded-shortlist manual lookup journeys now pass cold reopen.

### Scope and scale — deliberately not overstated

This lookup searches the **bounded acquired RIGHT universe**, not just its fuzzy
shortlist. It does not remove the existing 10,000-row acquisition ceiling, avoid
all initial snapshot transfer, provide a server index over million-row dictionaries,
or establish dictionary-scale latency/memory throughput. Over-cap initial runs
still refuse honestly. The new live journey has 57 real right rows, with 56
hard-admissible objects; it is correctness evidence, not a scale benchmark.

Confidence bulk retains conservative incomplete/unknown-competitor exclusions.
Manual choices are user-touched and cannot manufacture confidence eligibility.
Explicit reviewed acceptance remains separate. Practical confidence-bulk coverage
on large dictionaries remains a product/performance question, not solved by making
the safety check less strict.

## Critical real App/Electron interleavings

[The new Electron suite](../../../e2e/electron/matching-residual.spec.ts) uses real
CSV/DuckDB/Host evidence and the actual App handlers and guarded project reducer.
It does not inject synthetic Matching proposals or fake successful verification.
IPC holds delegate to the real handler and delay its response. Existing E2E project
mutation/open hooks drive the actual App state paths.

For **both Basic and Advanced** it verifies:

| Case | Observed invariant |
|---|---|
| Delete original JOIN while Host verification is held | No Mapping/Apply/receipt publication; unrelated existing map retained |
| Insert upstream transform during held verification | No stale write against shifted/changed JOIN |
| Open another project and return to original identity/context | Old reply cannot publish into replacement session |
| Change context and restore the exact old definition | Sticky invalidation; no ABA revival |
| Fail private Apply after the real fold but before publication | Entire workspace unchanged, exact draft retained, explicit retry succeeds atomically |
| Mapping Save first, Matching write second | Real linked-seed Save response held; Matching refuses without publication or lost decisions |
| Matching verification first, Mapping Save second | Save refuses before overlapping publication/persistence; Matching completes after release |

The final two orders share one case per producer: twelve concurrency tests total.
The seed-save test invokes the actual App Save handler through a build-gated E2E
bridge and delegates real linked-seed IPC; it does not set an in-flight boolean
directly. The failure test uses an E2E-only one-shot fault after the real private
Apply fold, routing through the same pre-publication failure gate. Normal production
builds omit that fault branch. There is no async pause inside the synchronous fold.

The App now refuses Mapping Save while a Matching commit is pending, completing
serialization in the previously unprotected direction. Post-verification checks
also require the expected sole write ownership. Original JOIN/session/plan guards,
atomic reducer publication, typed acknowledgement and explicit refresh remain.
This proves the listed cases, not every conceivable schedule or external-system
atomic transaction.

Two additional real Host lookup tests hold replies while search text changes or
JOIN context changes and returns. Neither installs manual evidence or decisions;
stale detail is removed from the active filter. Service-unit tests cover changed
decision/plan, closed session, foreign source/run replies and property-order-safe
lookup-page comparison.

## Verification actually run

All native tests serial (known parallel native SIGSEGV remains unresolved).
Electron uses Xvfb, actual release Host and E2E UI builds, real temporary CSVs.
The runner reports the release Host path; no baseline binary is substituted.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npm run test:unit` | **49 files passed**, including new lookup async/config tests |
| `cargo test -p dwh-engine --lib matching:: -- --test-threads=1` | **38 passed** after shared comparator extraction |
| `cargo test -p dwh-host --test join_tuple_suggest --test join_tuple_lifecycle --test matching_advanced_join -- --test-threads=1` | **19 passed**: 2 tuple verification/wire, 6 lifecycle, 11 Advanced |
| `npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | **41 passed** |
| `npx playwright test -c src/components/JoinLensCandidates.playwright.config.ts` | **23 passed** |
| `npx playwright test -c src/components/FindRightDialog.playwright.config.ts` | **13 passed**; modal source unchanged |
| `bash scripts/check-generated-types.sh` | Passed, generated types fresh |
| `npm run build` | Final production build passed; existing large-chunk warning remains |
| `node scripts/test-ux-docs.mjs` | Passed: 26 documents, 117 local links/media references and source/license assertions |
| `git diff --check` | Passed |
| Production asset scan for E2E Apply fault hook | Passed: hook absent from normal production assets |
| `xvfb-run -a node scripts/run-electron-e2e.mjs matching-residual join-tuple-save` | **21 passed (1.6m)**, fresh release/UI build |
| `xvfb-run -a node scripts/run-electron-e2e.mjs matching-residual join-candidates join-tuple-save join-batch-save matching-advanced matching-save workspace-tabs` | **39 passed (3.6m)**, final combined fresh build |

The residual suite contributes sixteen cases: two actual beyond-shortlist lookup /
write / execute / Save / fresh-process reopen journeys; two late-lookup guards;
twelve Basic/Advanced real App concurrency cases. The remaining combined cases
retain Basic and Suggest Right 1–5-key persistence, Advanced extra-field/ranking,
Candidates including already-joined targets, Mapping-origin fixture/demo/save
guards and tab/project lifecycle. Existing Basic LLM uses its loopback provider;
manual lookup itself does not invoke LLM.

The unit/browser suites were rerun after the final run-configuration fix, followed
by normal production build and documentation validation. These are not scale or
cross-platform packaging results.

## Failure history and remaining risks

- The first new lookup Electron attempt exposed a real implementation bug: JSON
  object key order was used to compare returned page identity. It rejected the
  same text/offset with reordered fields. Direct field comparison fixed it, with
  a reversed-key-order unit regression; ownership checks were not weakened.
- A unit check caught an optional undefined field altering ordinary decision
  projection shape. The field now remains absent for non-manual decisions.
- Initial new test helpers hung cleanup after exiting Electron before normal
  close, omitted project path in the cold-reopen execution RPC, and captured an
  old render's Mapping Save closure. Those helpers were corrected; the App Save
  bridge uses the latest real handler. The corrected 13-case and final 21/39-case
  runs pass. No test was removed to hide a failure.
- A pre-final broader run failed the late-context assertion because stale detail
  was correctly absent (no evidence/decision was installed). The test now checks
  absence rather than looking for text inside a nonexistent panel.
- That pre-final run also had two Suggest Right execution failures whose old
  helper discarded the actual Host error field. Diagnostics now preserve the
  full response. Focused 1–5 and final combined 1–5 reruns passed without reproducing
  them. **Their root cause and the historical cold-preview cause remain unproven**;
  this report does not declare the preview-lifecycle risk fixed.
- Dictionary-scale search/acquisition/performance, practical confidence-bulk
  coverage, paid providers, PostgreSQL/Parquet matching, parallel native behavior
  and durable draft restoration remain outside this verified increment.

P1 lookup and the requested real-App cases are delivered within the bounded
contract. The [task list](tasks.md) remains open for P2 risks and final product
acceptance; no unconditional full-scale closure or new published commit is claimed.
