# Phase 2 — first Basic Matching milestone

Baseline: `30ead1dfd6e30b76865ca19d7b7d696134a4db18` on `feature/redesign`.
The supplied Phase 1 architecture packet and index changes were retained. No commit
was made. This is a Basic milestone, **not completion of ADR-0051 or this change**;
no delta has been merged into `openspec/specs/`.

## Delivered

- Find Matches enters the existing Matching tab through `onOpenMatching`, without
  starting retrieval automatically. The application no longer exposes a competing
  inline batch review. The old component remains available only to callers without
  a Matching navigation callback; it is not mounted by the application entry.
- One authoritative Matching ledger owns full-source-tuple decisions. Basic review
  statuses are derived from producer evidence and that ledger. No stateful legacy
  TupleBatch decision queue is retained. Temporary checked-row selection is separate
  from confirmation and is cleared after retrieval/acknowledgement.
- Exact nullable ordered keys/outputs, grouped target identity, occurrence counts,
  every scored competitor, unknown scores, field scores, coverage and merged
  fuzzy/LLM origins survive the Basic adapter. JSON-array identity distinguishes
  NULL, empty, whitespace, literal symbols and embedded delimiter bytes. Existing
  string-only Mapping/contextual boundaries refuse NULL instead of coercing it.
- Default JOIN plan outputs are ordered `rightOn`, independent of the preferred
  target identity field and physical column order. Basic uses grouped real JOIN
  tuples, not fabricated target row IDs. Contextual identity controls are retained
  for inspection but do not claim Basic acquired additional identity fields.
- Real existing tuple fuzzy retrieval, bounded batch LLM prompt/parser and shared
  review/detail/filter/final-diff are connected. Model replies add alternatives, not
  decisions, and merge through the App owner's functional latest-session update.
- Confidence bulk reuses the existing score/gap/full-competitor policy. Unknown or
  incomplete right evidence, conflicting origins, touched records and unsafe tuples
  cannot qualify. Explicit reviewed bulk has a separate counted safe-tuple preview.
  Undo removes only the latest unchanged bulk entries and retains sticky touched
  evidence. Neither action publishes Mapping or Apply before Write.
- JOIN-bound Write reuses the existing private whole-batch planner, compatible-map
  checks, import policy, dirty Mapping/Save guards, ApplyPlan fold and expected-project
  reducer transaction. It resolves the captured original JOIN, not current Lens
  selection. Mapping-origin persistence is unchanged and fixture writes stay banned.
- The Host re-acquires bounded Basic tuple evidence through existing input preparation,
  verifies the typed report and selected real tuples, and materializes outputs.
  Unknown/mutated/wrong-source/wrong-run/inconsistent-revision requests are refused.
- Pending writes lock old review actions. Session/run-owned reducer receipts permit
  only the exact expected resulting context, including shifted JOIN index. Other
  edits cause sticky stale/ABA invalidation. Acknowledgement clears actionable old
  evidence/decisions; only explicit Refresh remaining review retrieves again.
  The Matching component stays mounted through tab switches and its own transaction.
- Edit plan retains the contextual editor as an honestly gated disclosure for
  JOIN-bound Basic. Advanced execution and Candidates were not implemented.

## Verification

Commands are from this working tree, not inherited reports. Browser commands used
the already cached Chromium 1193 because the pinned Playwright default revision
1148 was absent. No browser/dependency download or version upgrade was made.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npm run test:unit` | 48 test files passed |
| `cargo check -p dwh-host` | Passed; existing warnings |
| `cargo test -p dwh-host --test join_tuple_suggest -- --test-threads=1` | 2 passed; direct API cases iterate arities 1–5; includes exact fractional-score wire regression |
| `cargo test -p dwh-host --test join_tuple_lifecycle -- --test-threads=1` | 6 passed; real tuple execution and persistence |
| `cargo build -p dwh-host --release` | Passed; rebuilt corrected Host, no stale/portable Host used |
| `DWH_ELECTRON_BUILD=1 DWH_E2E=1 npm run build` | Passed; existing large-chunk warning |
| `npm run build` | Passed after final Electron revalidation; existing large-chunk warning |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/alex/.cache/ms-playwright/chromium-1193/chrome-linux/chrome npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | 8 passed |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/alex/.cache/ms-playwright/chromium-1193/chrome-linux/chrome npx playwright test -c src/components/FindRightDialog.playwright.config.ts` | 13 passed; unchanged Suggest Right component |
| `DWH_E2E_SKIP_HOST_BUILD=1 ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test -c playwright.config.ts e2e/electron/join-batch-save.spec.ts e2e/electron/join-tuple-save.spec.ts e2e/electron/matching-save.spec.ts` | 16 passed in the final run (2.4 minutes), after the reviewed-bulk count/selection cleanup; prior complete run also passed (2.7 minutes) |
| `git diff --check` | Passed |
| `git diff --exit-code -- src/components/FindRightDialog.tsx` | Passed; no changes |

The Electron skip-build flag follows an explicit successful corrected release Host
build and E2E UI build. It does not mean the original baseline binary was reused.

### What the Basic Electron journey actually proves

Five independent cases (1–5 keys) use actual temporary CSV files and real Rust tuple
scoring; only the external model is a real loopback HTTP provider fixture. Each case:

1. Enters Matching from the real Lens action and observes no automatic run/decisions.
2. Checks ordered RIGHT outputs despite reversed physical RIGHT columns and a distinct
   `target_id` preferred identity. Verifies grouped repeated-source occurrences.
3. Performs confidence bulk and undo using real scores (observed eligible counts
   2, 2, 2, 2, 3), then explicit reviewed bulk for two actual fuzzy targets.
4. Sends a bounded multi-source model request; accepted decisions are absent from
   its prompt, invented targets are rejected, and another source's alternative is
   not silently accepted. Explicitly confirms the third source's real target.
5. Leaves Matching, selects a **non-JOIN** step, returns with all three decisions,
   and writes against the original JOIN binding.
6. Samples project publication: observed project states are only old `[0,0,0]` or
   complete `[1,3,1]` (maps, entries, Apply steps), never a map-only intermediate.
7. Executes the committed query, checks context-sharing guard tuples stay unmatched,
   observes the owned shifted-index receipt without an implicit rerun, explicitly
   refreshes remaining review, and verifies no implicit model request occurs.
8. Saves, closes the process, launches a fresh Electron/Host process, opens the saved
   project, and compares real execution plus exact Mapping entries and JOIN bindings.

The other eleven Electron cases cover existing Suggest Right arities 1–5 and
Mapping-origin missing-target/refused-write/retry/real-local-save/demo/fixture gates.
Those Mapping-origin tests are not presented as real Basic retrieval evidence.

### Failures encountered and fixed

- Initial browser launch: Chromium 1148 absent. Retried using the existing Chromium
  executable override; no product fix or dependency update was needed.
- Early arity browser cases targeted the disclosure's accessibility group instead
  of its disabled controls. Corrected the test selector.
- The first Electron run exposed missing checked-row controls in the existing
  review table. Added real temporary row checkboxes to that same table.
- A direct initial execution was cancelled as `Preview superseded` by the ordinary
  UI preview lane. The test retries only that explicit cancellation, never SQL,
  Apply, validation or incorrect execution results.
- The tab-retention test initially selected a step in the intentionally collapsed
  inspector after Open Lens. It now restores the inspector using its real control.
- Failure cleanup initially waited on dirty-draft beforeunload and subsequently on
  an orphan sidecar's loopback keepalive. Test-only cleanup now invokes normal quit
  before forced exit and closes fixture server connections. Two stuck test-owned
  Electron processes and one test-owned orphan sidecar were terminated during
  diagnosis; no developer application process was targeted.
- Most importantly, strict JSON-value/then typed report comparison exposed real
  one-ULP score changes in the default Rust JSON float parser. A native real-CSV
  regression reproduced `0.9874999999999999` becoming `0.9875`. Enabling Host
  `serde_json/float_roundtrip` fixes exact wire preservation. No epsilon comparison,
  output substitution, score fabrication or validation bypass was introduced.
- The wrapper's shell argument forwarding made the initial `--grep 'Basic 2-key'`
  wrapper invocation run all five Basic cases. Subsequent targeted runs used direct
  Playwright invocation with preserved quoting. Earlier failed runs are not counted
  as passing evidence.

## Remaining integration risks and parent work

1. **Advanced and Candidates remain parent subtasks.** No live additional-field
   contextual acquisition, semantic constraint repair, candidate browser/extra lookup
   UI, or Advanced engine integration is claimed. Basic currently reviews the fuzzy
   shortlist and bounded LLM-added alternatives in the existing detail panel.
2. **Negative-matrix coverage is layered, not exhaustive Electron coverage.** Pure
   tests cover unknown/incomplete evidence, full competitors, safety, latest ledger,
   exact receipts and sticky ABA. Native direct calls cover forged evidence/IDs and
   revisions; existing planner tests cover incompatible/not-ready maps and atomic
   refusal. The real Electron test proves current selection can be non-JOIN. It does
   not yet hold a live verification request while editing/deleting the original JOIN,
   selecting a different actual JOIN, switching projects away/back, racing Mapping
   Save, or injecting an Apply failure. Those App-level interleavings still deserve
   dedicated real integration tests despite existing code guards.
3. **The Host verifier is deliberately stateless.** It validates request/run/session
   consistency and real values against bounded re-acquisition, not a durable
   Host-owned session/evidence registry or signed attestation. The renderer session
   owner plus expected-project reducer remain authority for project lifecycle and
   publication. A wholly self-consistent request describing another real workspace
   is not authenticated as the current App project by this read-only RPC alone.
4. **Freshness is local definitions, not external snapshot isolation.** Definitions,
   project session, sources, connections and references participate; focus navigation
   does not. Existing prepared-input acquisition/cache semantics remain. External
   file/database changes in place are not guaranteed detected or locked throughout
   verify-to-publication; no stronger claim is made.
5. **Bounded Basic is not dataset-wide matching.** Reports retain caps/totals and
   omissions. A safe explicit full-tuple review does not turn spelling similarity
   into calibrated business confidence. Duplicate right tuples may multiply JOIN rows.
6. **No restart restoration** of Matching drafts was added. Project Save is separate
   from acknowledged Mapping + Apply. Standalone source/linked-seed writes retain
   their pre-existing external persistence behavior, not graph-reducer atomicity.
7. **Native parallel crash remains unresolved/unverified.** Native suites here ran
   serially. Paid providers, PostgreSQL/Parquet-backed matching, connector-scale data,
   and adversarial live concurrency have not been verified in this milestone.
8. Legacy inline batch code remains for callback-free/component compatibility,
   although application navigation cannot expose the competing review. Removing
   that fallback and its old component tests is a separate cleanup decision.

## Precise implementation file inventory

The baseline already had uncommitted ADR-0051, the proposal/design/delta specs and
OpenSpec index edit. They are not newly authored runtime work in this milestone.
Only this report and the active tasks file add/change implementation evidence.

| File | Change |
|---|---|
| `crates/dwh-host/Cargo.toml` | Exact fractional-score JSON parsing feature |
| `crates/dwh-host/src/api.rs` | Typed Basic verification/materialization over existing tuple acquisition and heavy execution lane |
| `crates/dwh-host/tests/join_tuple_suggest.rs` | Direct API negative matrix, 1–5 arities, real fractional-score round-trip regression |
| `src/App.tsx` | Original-JOIN binding, live retrieval, latest-ledger merge, verified atomic commit, owned receipt/stale lifecycle; existing mounted Matching tabs retained |
| `src/app/matching/types.ts` | Nullable shared tuples, edge/coverage/run data, ledger revisions, immutable binding/lifecycle; structured identity and string-only refusal helpers |
| `src/app/matching/basic.ts` (new) | Pure lossless adapter, legacy invocation projections, LLM merge, confidence selector, decision collection, freshness/receipt helpers |
| `src/app/matching/basic.test.ts` (new) | Model, full-universe bulk, exact identity, late evidence and lifecycle tests |
| `src/app/matching/reviewLogic.ts` | Shared Basic ledger guards/projections, confidence bulk/undo, explicit reviewed preview, structured final-diff equality |
| `src/app/matching/planDefaults.ts` | Ordered RIGHT JOIN outputs independent of identity |
| `src/app/matching/planDefaults.test.ts` | Output/identity regression expectation |
| `src/app/matching/commitSave.ts` | Structured replacement-token decoding for existing Mapping-origin Save |
| `src/app/matching/persistSave.ts` | Explicit string-only source-key boundary |
| `src/app/matching/llmRank.ts` | Lossless nullable shared-model prompt types; contextual execution otherwise unchanged |
| `src/app/matching/semanticExpand.ts` | Explicit refusal of NULL at existing string-only contextual snapshot boundary |
| `src/components/MatchingWorkspace.tsx` | Existing single review gains live Basic actions, counts, scores/origins, safe bulk/undo, locked plan disclosure and pending/receipt/refresh lifecycle |
| `src/components/MatchingWorkspace.playwright.config.ts` (new) | Focused component test config |
| `src/components/MatchingWorkspace.ui.spec.ts` (new) | Eight focused review/ledger/receipt/safety browser cases |
| `src/components/JoinLens.tsx` | Find Matches routes through existing Matching callback; no application inline batch review |
| `src/lib/bridge.ts` | Narrow typed read-only verification RPC wrapper |
| `src/lib/joinLensBatch.ts` | Definition fingerprint ignores presentation-only query focus |
| `src/lib/joinLensBatch.test.ts` | Navigation/fingerprint regression |
| `src/lib/joinLensBatchCommit.ts` | Optional Matching session/run receipt ownership |
| `e2e/electron/join-batch-save.spec.ts` | Real Matching-tab 1–5-key journey, atomic publication, Save/cold reopen, narrow cancellation handling and failure cleanup |
| `openspec/changes/unified-matching-workspace/tasks.md` | Proven progress and evidence only; change remains in flight |
| `openspec/changes/unified-matching-workspace/phase2-basic-report.md` (new) | This evidence, failures, limitations and file inventory |

`FindRightDialog.tsx` was not modified. Merged OpenSpec capability files were not
modified. The prior architecture packet and unrelated working-tree changes were
not discarded or committed.
