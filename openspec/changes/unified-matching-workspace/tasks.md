# Tasks: Unified Matching Workspace

Status: Basic, Advanced live, read-only Lens Candidates and cleanup/regression
verified on 2026-11-15. Delivered capability contracts are merged; residual
acceptance remains open (unchecked below). See [final evidence](report.md). Decision:
[ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md).
Review [proposal](proposal.md) → [specs](specs/) → [design](design.md) → tasks
before runtime changes. No commits requested.

## Phase 2A — Basic first

- [x] Review/accept ADR-0051 and this packet; recheck actual HEAD, working tree and cited code locations without discarding others' work.
- [x] Extend existing Matching proposal/candidate/session types with exact nullable tuple identity, edge scores/field evidence, counts, merged origins, coverage, run revisions and immutable original-JOIN binding.
- [x] Replace matching-only delimiter tokens and replacement-key consumers with collision-safe structured tuple identity without changing persisted Mapping IR.
- [x] Centralize draft decisions in the existing session ledger; separate suggestion from selection/confirmation and derive review state through selectors; preserve latest decisions against late evidence.
- [x] Add pure Basic tuple-report adapter retaining every competitor, unknown score and truncation; add shared-model tests for exact values, arities, counts and alternatives.
- [x] Adapt existing batch LLM prompt/parser and manual candidate helpers to shared-model merge events without retaining a second mutable batch decision queue.
      Basic LLM/latest-ledger merges and paged manual browsing of the retrieved
      right universe are verified by migrated MatchingWorkflow browser tests.
- [x] Add conservative counted bulk preview/accept/undo using complete scored-universe evidence and existing cutoff/gap policy; exclude touched/manual/conflicting/unknown/incomplete records.
- [x] Add narrow Host verification/materialization of live candidates using original input acquisition and existing validators; test unknown candidate, mutated outputs, wrong session/source and stale revisions through direct API calls.
- [x] Factor existing private batch Mapping + Apply transaction to accept the Matching session's explicit original-JOIN binding; retain compatible-map/readiness/dirty-state/write-flight guards and reducer expected-project check.
- [x] Route Find Matches into existing Matching review with locked ordered LEFT inputs and RIGHT outputs, independent candidate identity and no preselection; remove competing Lens batch review ownership while preserving the agreed No match / Candidates selector and existing Suggest Right modal.
      Existing No match/Suggest Right behavior is preserved; Phase 4 adds the
      read-only Candidates selector and removes the callback-free inline batch
      mount. Legacy component removed after migration of its manual/LLM/lifecycle
      coverage into MatchingWorkflow tests; pure helpers and Electron tests remain.
- [x] Integrate pending/acknowledged commit lifecycle into Matching with exact receipt context, shifted JOIN index, ABA invalidation and explicit Refresh remaining review; retain failure drafts and separate project Save.
- [x] Validate Basic using real CSV/Rust fuzzy plus loopback-provider LLM in Electron for arities 1–5: shared review, multiple source decisions, atomic publication, real Apply/Join execution, Save and cold-process reopen.
- [x] Validate Basic negative guard matrix, Mapping-origin Save and unchanged Suggest Right; record exact commands/results/gaps. Stop before Advanced unless Basic real integration passes.
      Layered unit/browser/native negative tests and adjacent Electron regressions
      pass. The requested critical real-App interleavings now run for both Basic
      and Advanced: JOIN deletion, upstream edits, project/context ABA, both
      Mapping Save orders and private Apply failure/retry. See [P1 report](p1-residual-report.md).

## Phase 2B — Advanced after Basic gate

Advanced is required within this same change, not deferred to a separate change.

- [x] Expose Advanced plan controls within the same workspace/session; lock original key/output/JOIN shape and keep candidate identity separate; semantic edits invalidate explicitly, disclosure alone does not rerun.
      Proven by `e2e/electron/matching-advanced.spec.ts` (locked
      `mapKeyFields`/`outputs`, identity `["id0"]` distinct from output
      `["acme"]`, semantic edit clears the run with no auto rerun, explicit
      Find-matches reruns a fresh acquisition) and the 9-case Matching browser
      spec (Advanced live-run case).
- [x] Add typed bounded Host acquisition of confirmed-plan key/comparison/identity/output fields from actual pre-JOIN left and consumed right inputs, reusing existing preparation/execution ownership.
      Proven live: the e2e acquires a `DeriveColumn` field (`name_soft`, absent
      from the raw `LoadCsv`) plus the consumed-right fields through
      `matching_acquire_join`, and `matching_advanced_join.rs` covers
      pre-JOIN transforms, consumed-right outputs, composite identity and the
      reused `join_prepare` prefix.
- [x] Reject missing/null-incompatible fields, ambiguous same-key contextual source rows and conflicting target identities without arbitrary representative rows or empty-string coercion.
      Proven by `matching_advanced_join.rs` (`null_missing_and_unsupported...`,
      `refuses_conflicting_source_context_and_target_identity_collisions`).
- [x] Enforce acquisition caps before row transfer, including cap+1 detection and honest partial totals/refusal; preserve cancellation/project/connection stale guards and no fixture fallback.
      Proven by `sql_caps_are_enforced_for_trial_mass_and_raw_target_rows`
      (cap+1 refusal before transfer) and `direct_forgery_mutations_and_stale_...`
      / `fresh_csv_reacquisition_rejects_changed_context...` (stale guards, no
      preview/prepare cache). The e2e acquisition reports `complete: true` and
      exact `sourceKeyCap`/`targetRowCap`.
- [x] Reconcile existing contextual hard/reference/normalization/expand semantics with confirmed-plan contracts using focused existing-engine fixes or explicit refusal; add actual per-source candidate score/field evidence to results.
      Narrow engine fix in `matching/retrieve.rs`: the canonical plan token
      `casefold` is now honored (trim + case fold on comparison values only)
      instead of refused, with `canonical_casefold_token_...` regression.
      Live e2e proves hard filters, soft scores, reference non-filtering/
      unscored, and ordered per-source `fieldScores` (soft≈0.95, hard/reference
      null). `unsupported_normalization_refuses...` still rejects real
      unsupported tokens.
- [x] Feed verified real fields through existing contextual trial/retrieval and lossless adapter, retaining actual allowlists; reuse existing semantic expansion/ranking with live snapshots, permissions and budgets.
      Proven live: the e2e ranks the residue through the real loopback host
      intake against the verified snapshot allowlist (asserts the offered
      allowlist excludes the hard-filtered `id3`, does not auto-confirm, and
      does not leak fixtures). Live `allow_expand` is passed through; expansion
      semantics are proven at the engine level
      (`expansion_relaxes_soft_cutoff_but_never_any_hard_constraint`) but not
      separately asserted as a distinct e2e candidate add.
- [x] Lazy-load/render active-source right candidate details in existing review; verified extra lookup candidates share the ledger and commit path, with stale-request guards and honest browsing scope.
      Explicit Host lookup now searches beyond shortlist/soft cutoff within the
      bounded acquired RIGHT universe, with actual hard constraints, paged results,
      stale guards and exact page replay at commit. Real zero-score and empty-soft
      expansion Save/Reopen journeys pass; this is not large-dictionary scalability.
- [x] Validate Advanced on real additional fields and same JOIN-bound atomic Mapping + Apply, identity distinct from outputs, constraints, completeness/caps, forged/stale API calls, execute/Save/cold reopen and adjacent regressions.
      Proven by the live e2e (verified Host reacquisition write, atomic
      `ApplyKeyMap`+`Join`, real execution, Save, cold-process reopen) and the
      native suites (forgery/stale/caps/transforms). Basic regression re-run
      green after the changes (5 Basic arities, 5 Suggest Right, 6 Mapping-origin,
      unit + native). See [phase3-advanced-report.md](phase3-advanced-report.md).

## Phase 4 — Join Lens No match RIGHT Candidates

- [x] Preserve unmatched-right diagnostics under No match; add the right selector only inside No match; keep All rows / No match and one Find Matches entry, with no contextual entry or mounted legacy batch.
- [x] Inspect one complete ordered nullable LEFT tuple (1–5 keys) through the exact existing focused tuple Suggest RPC, using selected LEFT card or active unmatched ordinary result; keep FindRightDialog unchanged.
- [x] Display read-only Top-8 actual RIGHT tuples, Host mean score, expandable field differences/scores, counts and honest coverage/incompleteness; include targets already matching another left row; no selection/accept/LLM/Mapping write route.
- [x] Implement lazy opening, explicit new-source retrieval, sixteen-result context-scoped LRU, exact null/string identities and generation-owned result/loading/error guards for selection/project ABA and late replies.
- [x] Add browser checks for arities/order, delayed/out-of-order/ABA, bounded cache/identity/context changes, incomplete/unknown/empty/refused evidence, right-only/pair refusal, no writes and unchanged modal.
- [x] Verify real Electron Candidates before Suggest Right for 1–5 keys with Mapping/Apply/Save/cold reopen; add a real-Host case with zero unmatched right rows and a target already joined elsewhere; rerun Basic/Advanced/Mapping-origin regressions. See the report for the cold-reopen preview failure and successful targeted rerun, not a claim of a single all-green final run.
- [x] Record exact commands/results, actual checkout baseline, failures and limits in [phase4-candidates-report.md](phase4-candidates-report.md); leave parent cleanup/acceptance/merge open and do not commit.

## Final documentation and acceptance

- [x] Record precise test evidence and unresolved gaps, including native parallel crash and unverified connector/provider cases; do not infer coverage from historical reports or synthetic save sessions.
- [x] Amend superseded ADR cross-references and product/help copy; reconcile affected in-place-confirm/composite capability wording without changing Suggest Right behavior.
- [x] Merge delivered Matching, batch and Lens Candidates requirements into capability SoT. The complete change remains open for residual acceptance, not prematurely archived.
- [x] Complete bounded Advanced beyond-shortlist verified lookup and the requested critical real App/Electron interleaving cases; preserve precise limits rather than claiming all races are proven.
- [ ] P2: define and validate dictionary-scale retrieval/performance and useful confidence-bulk coverage without weakening conservative safety.
- [ ] P2: reproduce and establish the historical cold-reopen preview failure cause; retain risk until then.
- [ ] Final product acceptance of the bounded increment and remaining P2 scope; no unconditional full-scale closure is claimed.

## Residual P1 verification — 2026-11-15

- 16 real Electron cases cover two manual lookup/cold-reopen journeys, two late
  lookup cases and twelve Basic/Advanced concurrency cases. Final combined run:
  **39 passed (3.6m)**, including accepted Basic/Suggest 1–5, Advanced, Candidates,
  Mapping-origin persistence and tabs.
- Serial engine 38 and Host/tuple lifecycle 19 passed; 49 unit files and browser
  Matching 41 / Candidates 23 / Suggest 13 passed; generated types fresh.
- Actual HEAD remains 342ecfd plus uncommitted residual work. Failures/history and
  exact commands: [P1 residual report](p1-residual-report.md).

## Final cleanup evidence — 2026-11-15 (historical accepted increment)

- Historical pre-publication run: HEAD 5820b99aad33f31c52927a323ee9daa51b79d2d5
  plus working-tree changes. Published accepted increment: HEAD
  342ecfdc78353c5b74bd41b212f95b306558ba1e, clean checkout rechecked. Original
  baseline 30ead1dfd6e30b76865ca19d7b7d696134a4db18 remains in history.
- 49 unit files; browser Matching 41, Candidates 23, Suggest Right 13; serial
  contextual engine 38 and Host/tuple lifecycle 18; typecheck/build/generated wire passed.
- Fresh-build combined Electron: **36 passed (2.8m)**, including Basic 1–5,
  Advanced live, Candidates, Suggest 1–5, Mapping-origin, tabs and Help Lab.
- Unsupported Advanced selected/cohort scopes refuse explicitly, and async
  acquisition/rank/verification/receipt merges protect changed reviews/ABA.
- Full commands, failures, migration and limitations are in [report.md](report.md).

## Phase 2A evidence recorded so far

- Baseline rechecked: `30ead1dfd6e30b76865ca19d7b7d696134a4db18`; pre-existing
  uncommitted architecture packet retained; no commit made.
- `npx tsc --noEmit`: passed after nullable consumer migration.
- `npm run test:unit`: all 48 files passed, including Basic arities 1–5 and 8,
  full-competitor confidence, below-cutoff margin, exact NULL/delimiter identity,
  latest-ledger LLM merge, receipt ownership and sticky ABA lifecycle tests.
- Browser Matching suite: 8 passed using cached Chromium 1193 through the existing
  executable-path override. Initial default launch lacked Chromium revision 1148;
  an early retry exposed a test selector targeting a disclosure instead of a control.
- `cargo test -p dwh-host --test join_tuple_suggest -- --test-threads=1`:
  2 passed, including direct verification negative cases for 1–5 keys and a new
  real fractional-score JSON regression. That regression failed before enabling
  Host `serde_json/float_roundtrip`; strict typed evidence comparison is retained.
- Earlier real Electron attempts exposed missing row checkboxes, an inspector
  navigation test assumption, a cancelled initial preview, failure cleanup waiting
  on dirty drafts/loopback sockets, and strict fractional-score verification refused
  because of the JSON parser. These failures were diagnosed/fixed and are recorded
  separately from passing evidence in the [Basic report](phase2-basic-report.md).
- Corrected real Electron regression run: **16 passed**, including all five Basic
  arities with actual atomic publication/execution/Save/cold reopen, unchanged
  Suggest Right arities 1–5, and six existing Mapping-origin save/demo/fixture cases.
- Unchanged Suggest Right browser suite: **13 passed**; serial native tuple
  execution/Save-Reopen suite: **6 passed**. FindRightDialog was not modified.
- First Basic integration milestone is working. Advanced, Candidates and the full
  parent change remain incomplete; merged capability specs are intentionally untouched.
- Final post-cleanup rerun: 48 unit files, 8 Matching browser cases and all 16
  Electron cases passed (Electron: 2.4 minutes). Plain `npm run build` also passed
  after the final Electron run. Full commands, file inventory, diagnosed failures
  and remaining risks are in [the milestone report](phase2-basic-report.md).
