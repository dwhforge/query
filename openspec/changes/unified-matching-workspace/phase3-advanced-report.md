# Phase 3 — Advanced LIVE integration: implementation and verification

Status: **Advanced LIVE delivered and verified end-to-end in the working tree.**
This is **not** the whole change: the Candidates/extra-lookup subtask is deferred to
the next parent subtask, the merged capability specs are intentionally **untouched**,
nothing is **committed**, and the change is **not marked complete**.

Decision: [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md).
Parent handoff: [phase2-basic-report.md](phase2-basic-report.md) (Basic milestone,
48 unit files / 8 Matching browser / 13 Suggest browser / 2 host / 6 native /
16 Electron). Baseline HEAD `30ead1dfd6e30b76865ca19d7b7d696134a4db18`.

## What this phase proves (real, live, not an "enable button")

- Advanced plan fields **outside** the JOIN keys are acquired through the Host from
  the **original left input after all preceding transforms** and the **consumed
  right query**, via `matching_acquire_join`. The live e2e proves this with a
  `DeriveColumn` field (`name_soft = lower(company)`) that does **not** exist in the
  raw `LoadCsv` — only a post-derive pre-JOIN read returns it.
- **Actual semantics** are live-verified: a `hard_constraint` filters candidates, a
  `soft_signal` scores them, and `reference_context` is non-filtering **and**
  unscored. Ordered per-source `fieldScores` (soft ≈0.95, hard/reference `null`)
  and actual source values (incl. the derived field) are asserted.
- **Bounded SQL acquisition caps** are enforced **before** row transfer
  (trial 20 source groups / mass 200 / target 10,000) with cap+1 refusal; the e2e
  acquisition reports `complete: true` and exact `sourceKeyCap`/`targetRowCap`.
- **Plan revision invalidation:** a semantic edit clears the run **without** an
  automatic rerun; an explicit Find-matches reruns a fresh acquisition.
- **Shared review/ledger:** Advanced uses the same `MatchingProposalView` /
  decision ledger / review as Basic. Candidate **identity** (`["id0"]`) is
  distinct from its **output** (`["acme"]`); outputs are the locked ordered
  `rightOn`.
- **Verified write via Host re-acquisition (not Basic fuzzy):**
  `matching_verify_join_candidates` re-acquires and re-runs contextual retrieval,
  then reuses the same JOIN-bound atomic Mapping + Apply planner / receipt / ack /
  explicit refresh as Basic.
- **End-to-end live journey** in Electron with real DuckDB: extra fields +
  hard/soft/reference, plan-change rerun, tab retention, reviewed bulk, LLM rank on
  the verified snapshot (real loopback host intake), verified write, atomic
  `ApplyKeyMap`+`Join`, real execution, Save and **cold-process reopen**.

## Two real blockers found and fixed (would otherwise be an "enable button")

1. **`casefold` normalization was refused.** The shared canonical plan
   (`buildLensMatchingPlan`) sets `normalization: ["trim","casefold"]`, but the
   engine's `normalize()` and its validation only accepted
   `trim/lower/upper/collapse_space/ltrim_zeros`. Because `advancedPlanToWire`
   forwards the plan normalization to `matching_retrieve`, **every** Advanced run
   on the default plan was refused (`unsupported normalization operation casefold`).
   Fix (narrow, existing engine, design §3): accept `casefold` as trim + case fold
   on comparison values only, in `matching/retrieve.rs` + a regression test.
   Identity/outputs are still never normalized; truly unsupported tokens are still
   refused.
2. **Plan `scope` refusal.** The Lens Find Matches session opens with the display
   cohort label `scope: "cohort"`, which the engine's
   `(plan.scope, source_parts)` gate refuses. Advanced acquisition is a bounded
   SQL `GROUP BY` over the pre-JOIN left (its own bounded scope), so
   `advancedPlanToWire` now maps the wire `plan.scope` to `full` (cohort/full →
   full; `selected` only with exact `sourceParts`). The top-level request scope is
   unchanged (`all` for non-selected), so the subtask's acquisition-scope contract
   is preserved.

Both fixes are additive and re-verified by the serial native suites below.

## Commands and exact results

All native commands run **serially** (`--test-threads=1`) because the recorded
parallel native SIGSEGV is unresolved.

| Command | Result |
|---|---|
| `cargo test -p dwh-engine --lib matching:: -- --test-threads=1` | **38 passed, 0 failed** (incl. new `canonical_casefold_token_is_trim_then_lower_for_comparisons_only`; retained `unsupported_normalization_refuses_even_an_empty_run`, hard/soft/reference/expand/missing-field, shortlist-truncation evidence) |
| `cargo test -p dwh-host --test matching_advanced_join -- --test-threads=1` | **10 passed, 0 failed** (transforms/consumed-right, composite identity, fractional scores, caps, NULL/missing, conflict/collision, forgery/stale, fresh-CSV reacquisition, scopes) |
| `cargo test -p dwh-host --test join_tuple_suggest --test join_tuple_lifecycle -- --test-threads=1` | **8 passed, 0 failed** (Basic tuple verification 1–5 + Save/Reopen) |
| `npx tsc --noEmit` | passed |
| `npm run test:unit` | **ok** (all files, incl. `advanced.test.ts`, `basic.test.ts`) |
| `node scripts/run-electron-e2e.mjs matching-advanced` (fresh `DWH_E2E=1` UI + release host) | **1 passed (14.9s)** — the full live Advanced journey |
| `node scripts/run-electron-e2e.mjs join-batch-save` (Basic regression) | **5 passed** (arities 1–5, atomic write, Save, cold reopen) |
| `node scripts/run-electron-e2e.mjs matching-save` (Mapping-origin regression) | **6 passed** |
| `node scripts/run-electron-e2e.mjs join-tuple-save` (Suggest Right regression) | **5 passed** (one transient `Preview cancelled` flake on a first run of the 5-key case; clean on rerun) |
| `npx playwright test -c src/components/MatchingWorkspace.playwright.config.ts` | **9 passed** (incl. the Advanced live-run case) |
| `npx playwright test -c src/components/FindRightDialog.playwright.config.ts` | **13 passed** (Suggest Right unchanged) |

Host build: `cargo build -p dwh-host --release` (rebuilt after the engine change;
release binary is what the Electron tests run). E2E UI built with
`DWH_E2E=1` via `npm run build`.

## What the live e2e asserts (precisely)

`e2e/electron/matching-advanced.spec.ts` — one scenario, real Electron + DuckDB +
release `dwh-host`:

- Raw Join is empty (left keys are aliases that do not equal the right keys);
  `execute` baseline all `null`.
- A delegating IPC spy counts renderer `matching_acquire_join` /
  `matching_verify_join_candidates` calls (delegates to the real handler; no bridge
  or host response is replaced).
- Plan: locked `mapKeyFields=["company"]`, `outputs=["legal_name"]`,
  `targetIdentityFields=["target_id"]`, `normalization=["trim","casefold"]`,
  comparisons `name_soft↔legal_name (soft)`, `country↔nation (hard)`,
  `category↔state (reference)`.
- One acquisition; `matchingMode="advanced"`, `advancedRun` set; acquired
  `sourceFields = [category, company, country, name_soft]`, `complete: true`.
- Derived field present in source values; `fieldScores=[≈0.95, null, null]`;
  identity `["id0"]` vs output `["acme"]`; the hard constraint leaves `gamma llc`
  with a single `gamma` candidate; reference is non-filtering (`online` ≠ `retail`
  yet `acme` proposed).
- Confidence bulk is **honestly blocked** (`(0)`, disabled) because the bounded
  shortlist is not the full competitor universe.
- Semantic edit (remove a comparison) clears the run with **no** rerun; explicit
  Find-matches runs a fresh acquisition (acquire 2); the now-soft field is scored,
  the removed reference is gone.
- Review 3 clear rows (reviewed bulk, 3 decisions, no write yet); leave the tab,
  switch to a non-JOIN step, return — ledger retained.
- Advanced LLM rank on the single ambiguous residue via the real loopback host
  intake: the offered allowlist includes the residue's allowlisted target and
  **excludes the hard-filtered `id3`**, does not auto-confirm, and does not leak
  fixtures; the pick sets the residue to `beacon`.
- Verified write: receipt `Applied 3 complete tuple mappings`, `verifyCount=1`,
  decisions cleared; steps become `LoadCsv → DeriveColumn → ApplyKeyMap → Join`;
  `execute` reproduces the expected matches; the atomic write is a single
  `[1,3,1]` snapshot (no publish-then-apply intermediate).
- Explicit refresh re-runs Advanced on the committed context (acquire 3); the 3
  matched keys drop out of the unmatched scope and the open residue remains.
- Save + **cold-process reopen** reproduce the committed `key_maps` and execution.

## Honest limitations and remaining gaps

- **No durable registry / snapshot isolation.** Verification is a stateless
  reacquisition of current data; it is not a durable store and cannot detect
  external in-place file/database changes. Definition fingerprints remain
  LOCAL-only, as in Basic.
- **Bounded acquisition, not dataset-wide.** Excess source groups / target rows
  are refused, not sampled; cohort scope is refused. The e2e uses a small
  universe; connector-scale data is not verified here.
- **NULL/missing fields are refused, not coerced** (engine + host tests). This is
  an honest refusal at the string-only contextual wire boundary and is **not**
  exercised as a distinct Electron journey (no nullable wire exists); a future
  nullable wire extension would be separate.
- **Live semantic expansion is not separately asserted in the e2e.** The e2e runs
  with `allow_expand` passed through; expansion semantics (relax soft cutoff only,
  never a hard constraint) are proven at the engine level
  (`expansion_relaxes_soft_cutoff_but_never_any_hard_constraint`), but this phase
  does not assert a distinct e2e expansion-driven candidate add. LLM **rank** on
  the verified snapshot is asserted; LLM **expand** is not.
- **Candidates / extra lookup (lazy active-source details) is NOT implemented** —
  explicitly deferred to the next parent subtask; the Host shortlist is the
  verified universe for this slice, and out-of-shortlist manual lookups are
  unavailable.
- **Native parallel SIGSEGV remains unresolved** (all native runs were serial).
  Paid providers, PostgreSQL/Parquet-backed matching and adversarial live
  concurrency are not verified here.
- **One transient E2E flake** (Suggest Right 5-key `Preview cancelled`) was
  observed once and passed on rerun; it is a preview-lane supersession, not an
  Advanced regression.

## File inventory (this phase, working tree)

| File | Change |
|---|---|
| `crates/dwh-engine/src/matching/retrieve.rs` | Accept canonical `casefold` normalization (comparison values only) + validation + regression test |
| `crates/dwh-engine/src/matching/types.rs` | Document `casefold` in the plan normalization contract |
| `crates/dwh-engine/src/matching_join.rs` (new) | Fresh SQL-bounded Advanced acquisition (pre-JOIN left + consumed right, caps, NULL/identity refusal) — from the Host subtask |
| `crates/dwh-host/src/commands/matching.rs` | `matching_acquire_join` / `matching_verify_join_candidates` — from the Host subtask |
| `crates/dwh-host/tests/matching_advanced_join.rs` (new) | 10 real Host Advanced tests (transforms, caps, NULL, conflict, forgery, stale, scopes) |
| `src/app/matching/advanced.ts` (new) | Advanced producer adapter/orchestration + **wire `scope` fix** (cohort/full → full) |
| `src/app/matching/advanced.test.ts` (new) | Advanced unit tests |
| `src/app/matching/runTrial.ts` | Shared `installMatchingRetrieval` + `TrialEnrichment` (lossless fields/scores/allowlists) |
| `src/components/MatchingWorkspace.tsx` | Advanced plan disclosure, locked bindings, advanced coverage/run, advanced rank, advanced commit routing |
| `src/App.tsx` | App supplies execution context; routes run/commit to the Advanced service; reconcile Advanced context |
| `src/lib/bridge.ts` | Typed `matchingAcquireJoin` / `matchingVerifyJoinCandidates` + snapshot types |
| `e2e/electron/matching-advanced.spec.ts` (new) | The live Advanced Electron journey above |
| `src/components/MatchingWorkspace.ui.spec.ts` | Added the Advanced live-run browser case |
| `openspec/changes/unified-matching-workspace/tasks.md` | Phase 2B proven items checked (Candidates left open) |

`FindRightDialog.tsx` and the Suggest Right path were **not** modified. The merged
`openspec/specs/` capability files were **not** modified.

## Status

- Phase 3 Advanced LIVE: **implemented and verified** (live e2e + native + browser
  + Basic regression all green).
- Change: **still in flight.** Candidates/extra-lookup deferred to the next parent
  subtask; specs **not merged**; **no commit**; **not marked complete**.