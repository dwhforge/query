# Tasks and acceptance gates: Unified Matching relationship workbench

**Phase 1 architecture packet prepared; architecture review pending. Runtime work
has not started.** Decision: [proposed ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
Review [proposal](proposal.md) → [deltas](specs/) → [design](design.md) → tasks.

## Phase 1 — architecture and UX contract (no runtime changes)

- [x] Record actual branch/HEAD/initial worktree and read repository/product rules.
- [x] Inspect required Matching/Lens/App code, review model, producers and write lifecycle.
- [x] Inspect existing diagnostics and RIGHT-side key explanation before proposing RPCs.
- [x] Inspect browser/Electron tests, runner and existing vendor/flagship Help Lab journeys.
- [x] Document renderer-derived versus fresh Host relationships, Mapping baseline gaps and API limits.
- [x] Produce proposed ADR, proposal, capability deltas, design/layout/navigation, coverage/identity model and reuse inventory.
- [x] Validate packet links/diff and reconcile claims against current implementation evidence; see [Phase 1 report](report.md).
- [ ] Architecture/product review accepts packet before Phase 2 runtime work.

**Gate 1:** explicit acceptance of the record-first UX, four provenance groups,
scoped completeness, no-new-RPC bounded inspection boundary and same-ledger
confirmation. Proposed contracts are not merged as implemented behavior.

## Phase 2 — data-centric workspace and complete LEFT regression

- [ ] Extract focused explorer/inspector/plan/assistant/summary boundaries; retain current tab/session owner.
- [ ] Add lossless labelled-value presentation (NULL, empty, whitespace), separate focus/pick/confirmation and explicit consequences.
- [ ] Promote target search/manual lookup for zero-candidate sources; preserve Basic acquired-universe and Advanced source/page verification.
- [ ] Move Rules, Assistant, evidence and bulk to secondary/contextual disclosures without semantic invalidation or lost review.
- [ ] Resolve compatible authoritative Mapping baseline using existing preparation selection rules; add unknown/partial baseline display, not false adds.
- [ ] Retain same single-confirm, undo, source defer/reject, bulk eligibility, LLM and Mapping-origin Save paths.
- [ ] Run LEFT browser and actual CSV/DuckDB Electron journeys through write, execution, project Save and cold reopen.

**Gate 2:** one/many/no-candidate LEFT cases, manual outside shortlist, selection
without confirmation, confirmation/undo, failure retry and atomic Mapping + Apply
pass. Existing 1–5-key Basic/Advanced, LLM, Suggest Right and Lens tests retain
behavior assertions. No final acceptance claim at this intermediate phase.

## Phase 3 — RIGHT investigation, provenance and bounded execution

- [ ] Build pure memoized sparse indexes from acquired edges/decisions/baseline references; test collision-safe identity and non-additive provenance counts.
- [ ] Add RIGHT focus, per-group coverage/units and source navigation with retained picks/review/decisions.
- [ ] Show existing Mapping/draft/suggestion conflicts and equal-output no-ops without replacing baseline or inventing target identities.
- [ ] Support source-scoped confirmation from RIGHT through existing validation/manual lookup; saved-only/executed-only sources remain read-only outside current proposals.
- [ ] Add explicit actual-key inspection through existing Host API; distinguish full counts, bounded examples, transformed input keys and shared output-key groups.
- [ ] Implement read-only acquisition ownership/intent epochs, bounded cache/eviction, stale/error/loading protection and complete-query refusal.
- [ ] Test source/target/candidate/baseline completeness separately and keep acquisition/unsupported-scope refusal behavior.
- [ ] Verify navigation/index work is linear in stored edges/rows and not recomputed quadratically per focus/render; record bounded render/memory measurements.

**Gate 3:** RIGHT with many/no/only-suggested/existing/draft/mixed sources works;
the same RIGHT reached from different LEFTs retains one identity and ledger.
Actual execution is never inferred from proposals. No new Host RPC without a
demonstrated correctness gap and separate contract review.

## Phase 4 — real integration and product acceptance

- [ ] Extend actual Electron/Host journeys according to the matrix below, including genuine acquired Mapping and executed relationships.
- [ ] Adapt existing vendor Help Lab: problematic JOIN → unmatched → candidates → RIGHT associations → confirm → review → atomic Apply → execute → Save/cold reopen.
- [ ] Preserve flagship reconciliation, safe Help Lab switching, Basic/Advanced/LLM, Mapping Save, Join Lens and Suggest Right regressions.
- [ ] Run serial native Host/engine tests, unit tests, browser suites, fresh Electron release Host/E2E UI, type checks and production build.
- [ ] Record exact runtime/test revisions, selected Host binary, commands, results, failures/retries, unverified cases and residual limitations.
- [ ] Complete product review against readable records, bidirectional investigation and comprehensible consequences, not screenshots alone.
- [ ] Merge verified delivered deltas into merged Matching/JOIN diagnostics/Help Lab capability specs, update indexes/report and close only completed work.

**Gate 4:** all matrix rows have actual evidence or a verified explicit limitation
allowed by the contract. Core bidirectional journeys may not be waived. A report
must not relabel unavailable complete inspection as successful sample inspection.

## Acceptance matrix and required evidence

All positive end-to-end rows use the real [Electron runner](../../../scripts/run-electron-e2e.mjs),
[isolated launch](../../../e2e/electron/helpers/launch.mjs), temporary CSVs and actual
DuckDB/Host responses. Existing build-gated IPC holds may delay **real** replies
for races; never substitute synthetic successful acquisition/verification. Component
and pure tests supplement, not replace, integration evidence.

| Area | Required cases | Assertions/evidence |
|---|---|---|
| LEFT choices | One candidate; several; none; empty RIGHT | Real fields/caps/empty states; no decision from acquisition or selection |
| Manual lookup | Outside shortlist, zero soft score, paging, hard-invalid target | Source-specific Host page replay; exact full output; no eligibility manufacture |
| Decisions | Select, confirm, undo, defer/no-suitable, alternative after undo | Same ledger and exact tuples; navigation never decides; retry preserved |
| Writes | Atomic Mapping + Apply, separate project Save, fresh-process reopen | Real project bytes, no duplicate keys, all output bindings and equivalent execution |
| RIGHT groups | Several LEFTs; none; suggested only; existing only; draft only; mixed existing/new | Per-group units, coverage, origin and non-additive counts; no false zero from unacquired groups |
| RIGHT round trip | Same target from different LEFTs; LEFT→RIGHT→LEFT→other RIGHT | Identity stable, inspected pairs distinct, decisions/picks retained; no unnecessary run |
| RIGHT confirmation | Existing candidate and manual lookup reached from RIGHT | Same validation/decision as LEFT; A's lookup never authorizes B |
| Identity | 1–5 fields; NULL/empty/padded strings; embedded delimiters/quotes; equal outputs with different target IDs | Exact values survive display/lookup/ledger; no output-group attribution to independent rows |
| Small complete data | All relevant acquired records fit limits | Complete only in named run/map/executed-key scope; distinct row/key counts |
| Partial data | Basic bounded source, omitted shortlist, sampled JOIN >50, bounded Mapping page | Additional records warning; sample count separate; unsupported full enumeration refuses |
| Mapping baseline | Seed definition, external page, exact touched-key read, query/ref unavailable, mismatched map shape | No second store; missing baseline not empty; ID-output vendor seed not name/region map |
| Actual cardinality | Repeated LEFT invoices, many aliases→one entity, duplicated RIGHT rows, outer JOIN and NULL | Proposed cardinality distinct from verified fan-out; actual rows versus full keys explicit |
| Failure/refusal | Over-cap source/target, unavailable Host, cancellation, complete-query refusal | No fixtures/full-scope/sample fallback; explicit reason, no false absence |
| Rapid focus | LEFT A→B, RIGHT X→Y, LEFT→RIGHT→LEFT ABA, lookup text/page ABA | Old success/error/finally cannot install, confirm or clear newer state |
| Context invalidation | Project replacement/ABA, JOIN edit/deletion, upstream edit/context ABA | Sticky stale state; no stale evidence/write/receipt revival |
| Save/write concurrency | Mapping Save while baseline/inspection pending; both Save/Matching write orders | Current baseline not overwritten; existing serialization/refusal and retry behavior |
| Lifecycle | Pending write, switch tabs, Rules/Assistant open/close, close/unmount pending retrieval | No lost decisions, rerun or late publication; existing dirty-close warning |
| LLM | Permission/refusal/failure/retry, late suggestion, cancellation, manual choice | Existing allowlists/budgets; suggestion never confirmed; newer decision not overwritten |
| Help Lab | Existing vendor journey plus flagship regression | Eight-step record/relationship workflow, real recheck, Save/cold reopen; no algorithm knowledge needed |
| Usability/accessibility | Desktop/narrow layout; keyboard focus; long values; no JSON primary labels | Data readable, groups/status announced, no hidden pair action or overflow |
| Performance | Sparse multi-source target sharing at supported caps; repeated focus/search | No Cartesian materialization/duplicate row bodies; bounded DOM/pages/cache and documented measurements |

## Verification targets

Retain and extend [workspace browser](../../../src/components/MatchingWorkspace.ui.spec.ts),
[workflow browser](../../../src/components/MatchingWorkflow.ui.spec.ts),
[Basic Electron](../../../e2e/electron/join-batch-save.spec.ts),
[Advanced Electron](../../../e2e/electron/matching-advanced.spec.ts),
[residual Electron](../../../e2e/electron/matching-residual.spec.ts),
[Mapping Save](../../../e2e/electron/matching-save.spec.ts),
[Candidates](../../../e2e/electron/join-candidates.spec.ts),
[Suggest Right](../../../e2e/electron/join-tuple-save.spec.ts),
[Help Lab](../../../e2e/electron/help-lab-journey.spec.ts) and tab/switch regressions.
Add dedicated reverse-index/inspection tests without replacing the real journeys.

The [package scripts](../../../package.json) and
[Electron runner](../../../scripts/run-electron-e2e.mjs) define the build/test
entrypoints. Use a virtual display on headless Linux; rebuild release Host and E2E
UI rather than trusting stale artifacts. Verify portable Host precedence. Record
actual commands in the implementation report; prior pass counts are not this
change's acceptance evidence. Phase 1 runs documentation checks only.
