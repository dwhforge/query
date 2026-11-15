# Design: Unified Matching Workspace

Status: architecture approved on 2026-11-15, runtime not implemented. Decision:
[ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md).
No new tests were executed for this packet. Locations below describe inspected
source, not proof of the future integration. Baseline is supplied by the parent.

Approval locks staged delivery: complete Basic real-data/shared-review/atomic
commit/Electron Save-Reopen first; only then implement Advanced live execution
in this same change and same workspace/review/commit workflow. Preserve the agreed
Join Lens No match / Candidates selector and existing Suggest Right modal;
neither is replaced by the shared batch review. No detachment or output rebinding.

## 1. Ownership and integration map

| Existing location | Observed behavior | Recommended change |
|---|---|---|
| [Matching session/model](../../../src/app/matching/types.ts:44) | String-only candidates/keys, proposal provenance, separate decisions | Extend this model, not a parallel batch session |
| [Matching review](../../../src/components/MatchingWorkspace.tsx:46) | Existing table/detail/final diff; Mapping Save callback | Keep UI owner; add producer/run/commit callbacks and Basic/Advanced plan disclosure |
| [Live trial gate](../../../src/components/MatchingWorkspace.tsx:424) | Ordinary UI reports unavailable | Replace only when its real producer is wired; preserve demo policy |
| [Plan defaults](../../../src/app/matching/planDefaults.ts:45) | Outputs currently copy preferred target identity | JOIN defaults must copy ordered right-side JOIN keys; identity remains independent |
| [Lens Matching entry](../../../src/App.tsx:5748) | Captures JOIN and parent metadata, creates separate contextual session | Route Find Matches into this existing tab owner; capture immutable commit binding |
| [Lens batch mounting](../../../src/components/JoinLens.tsx:2307) | Mounts separate batch component | Remove competing review once shared Basic gate passes |
| [Batch retrieval](../../../src/components/JoinLensAuto.tsx:117) | Real existing tuple fuzzy bridge call | Move orchestration into matching scenario adapter; keep existing Rust scorer |
| [Batch LLM](../../../src/components/JoinLensAuto.tsx:161) and [helpers](../../../src/lib/joinLensBatch.ts:138) | Bounded grouped prompt/parser and guarded merges | Reuse algorithms with shared model input/output; no retained mutable legacy queue |
| [Review decisions/bulk](../../../src/app/matching/reviewLogic.ts:166) | State-based bulk and mutable suggestion when choosing alternative | One decision reducer; keep producer evidence immutable; replace permissive bulk with evidence-based eligibility |
| [Batch eligibility](../../../src/lib/joinLensBatch.ts:85) | Checks every competitor and right coverage | Preserve policy in shared review selector; do not round-trip decisions into legacy state |
| [Contextual trial adapter](../../../src/app/matching/runTrial.ts:127) | Accepts actual caller rows; result mapping drops fields/evidence | Reuse trial/retrieval with verified Host inputs and lossless field/score evidence |
| [Contextual retrieval](../../../crates/dwh-engine/src/matching/retrieve.rs:194) | Pure in-memory ranking, no actual source acquisition | Keep algorithm; add bounded Host acquisition/orchestration, not another matcher |
| [Host matching gates](../../../crates/dwh-host/src/commands/matching.rs:35) | Stateless retrieve/validate over supplied candidates | Bind live acquisition/evidence to Host-owned verification; do not label supplied arrays as a server-owned registry |
| [Batch planner](../../../src/app/keyMap/tupleMapping.ts:13) | Private map preparation + exact tuple/readiness gates | Reuse for both JOIN-bound producer outputs |
| [Batch App commit](../../../src/App.tsx:3290) | Atomic fold but resolves current Lens target | Factor explicit session-bound target argument; never read current selection for authority |
| [Reducer receipt handling](../../../src/App.tsx:1575) and [receipt type](../../../src/lib/joinLensBatchCommit.ts:2) | Commit acknowledgement and shifted JOIN identity | Reuse transaction receipt in Matching session; preserve exact transition/ABA guards |
| [Batch acknowledgement UI](../../../src/components/JoinLensAuto.tsx:30) | Protects own context transition, explicit refresh | Move behavior into existing Matching lifecycle; do not remount away a pending receipt |
| [Mapping-only persistence](../../../src/app/matching/persistSave.ts:89) | Seed/source Save acknowledgement, independent of Apply | Keep for pre-existing Mapping entry; never chain it before JOIN-bound Apply |

## 2. Concrete authoritative model

Extend [MatchingProposalView](../../../src/app/matching/types.ts:58),
[MatchingCandidateView](../../../src/app/matching/types.ts:44),
[MatchingDecisionView](../../../src/app/matching/types.ts:80) and
[MatchingTabSession](../../../src/app/matching/types.ts:128). Producer wire DTOs
remain adapters, not UI state. Suggested fields below are implementation contracts
to add in those existing types; they do not describe already implemented fields.

| Entity | Required data and invariants |
|---|---|
| Session | Existing ID/mode/plan/generation; producer Basic or contextual; immutable JOIN binding containing project-session generation, original host query/JOIN navigation target, ordered left/right fields, right query and local definition token; run/evidence ID; acknowledged receipt/refresh lifecycle |
| Proposal | Existing proposal ID; exact ordered nullable map-key array; source identity; actual used source field values; affected occurrence count; semantic and evidence revisions; suggested candidate ID separately from UI-selected ID; alternative IDs; search status/coverage/omission counts; evidence/contradictions; sticky user-touched marker |
| Candidate | Session/run-scoped ID; independent exact candidate identity tuple and opaque target ID; full ordered right JOIN output tuple; actual selected/display fields; target occurrence count; evidence revision; candidate origin metadata. All outputs come from one real row or equivalent grouped tuple |
| Proposal–candidate evidence | Candidate ID; producer metric name; optional numeric mean score; ordered field-pair scores with explicit unknown values; constraints/hits/contradictions; original and normalized evidence; merged fuzzy/LLM/manual origins and bounded rationale; model/request metadata when available |
| Search coverage | Separate source coverage, right universe total/retrieved/truncated, competitors scored/unknown, shortlist omitted, prompt omissions and query scope. Unknown totals/completeness remain unknown; visible eight alternatives are not the competitor universe |
| Decision | One entry per full exact source tuple: pending has no confirming entry; confirm/choose stores candidate ID and expected plan/evidence/run revisions; defer/reject/no-suitable are explicit. Include decision revision/origin and bulk undo token. No independently mutable accepted flag on a second proposal array |
| View status | Derive proposed/ambiguous/incomplete/confirmed/deferred/rejected/stale/saved from evidence, ledger and acknowledged receipt; retain existing filter vocabulary through selectors rather than a second status writer |

Nullable parts use the same structured value semantics as the
[Rust tuple report](../../../crates/dwh-engine/src/join_fuzzy.rs:119). The current
wire uses nullable strings after SQL casts, not rich SQL scalar types: preserve
that exact null/string distinction, do not claim numeric/date type fidelity.
Use canonical structured-array encoding for lookup tokens. The current
[NUL-joined token](../../../src/app/matching/types.ts:176) cannot safely distinguish
arbitrary embedded delimiters; migrate matching-only token consumers together,
including replacement keys and final diff. Do not change stored Mapping IR.

Scores belong to source/candidate edges, not globally to the candidate: the same
right tuple can score differently for different sources. Deduplicate candidates
by run plus exact identity/output tuple, not display text or a global right index.
If contextual rows share identity but disagree in outputs/fields, refuse the
identity collision rather than choosing a row. Identical repeated tuples may
group with occurrences; Basic candidates are grouped tuples, not unique row IDs.

UI selection is transient per proposal and starts empty. Confirmation is the
only operation creating a confirming ledger decision. Changing selection after
confirmation requires an explicit decision edit. Async evidence merges consult
the latest ledger synchronously, not a render-captured snapshot. Presentation
pagination/filter/disclosure changes do not invalidate evidence. Semantic plan
edits invalidate affected review; do not automatically rerun or drop dirty work.

## 3. Producer adapters, no duplicate decisions

### Basic

1. Call existing real tuple fuzzy retrieval with the captured JOIN context and
   optional focused source, using the existing full-tuple bridge path from
   [batch retrieval](../../../src/components/JoinLensAuto.tsx:117).
2. Validate ordered alignment/arity against the binding. Adapt every retrieved
   source/right tuple and every scored competitor, retaining counts, nullability,
   mean/field scores and truncation. Display only bounded initial alternatives;
   preserve other competitors in immutable evidence for bulk checks.
3. Adapt existing batch prompt/parser helpers to read shared proposals/ledger and
   emit candidate-evidence merge events. Temporary legacy-shaped inputs are
   permitted as pure invocation values, never another stateful decision model.
   Keep exact prompt source-specific allowlists and whole-response rejection.
4. Manual browsing uses the same verified retrieved right universe. Lazy render
   the active source detail; page/filter within the universe, not a second search
   engine. Preserve target counts, duplicates and unsafe tuple explanations.

### Advanced

Keep the same JOIN-bound key/output shape and atomic authority. Expanding controls
alone changes presentation only. A confirmed semantic edit creates a new run/
evidence revision with an explicit old-result invalidation notice. Additional
comparison fields must be actual fields from the original JOIN inputs, not keys
renamed as contextual columns. Record source/target schema and acquisition scope.

Acquire only the union of key, comparison, identity and output fields through a
narrow Host request bound to original JOIN + confirmed plan. Resolve actual left
input after all preceding transforms and right consumed query output, reusing
[JOIN input preparation](../../../crates/dwh-engine/src/join_prepare.rs:397) and
[existing tuple acquisition pattern](../../../crates/dwh-engine/src/join_fuzzy.rs:190).
The nearest FromQuery default is display guidance, not authority to skip Filter,
Derive, Rename, Normalize or Apply steps preceding this JOIN.

Group by full map key with occurrence counts; refuse/mark ambiguous when compared
source fields differ within the same key. Do not select an arbitrary representative.
Validate real target identity uniqueness (or explicitly grouped equivalent rows),
ordered output projection and exact selected field availability. For string-only
contextual wire, preflight NULL/missing fields: retain them in review/refuse that
run rather than coercing to empty strings. A future nullable wire extension must
be explicit and typed; it is not a reason to add a second matcher.

Use bounded SQL acquisition with cap+1 detection before transfer: trial at most
20 map keys, mass at most 200, local target at most 10,000 rows. Above the target
cap refuse initially with guidance; server-side retrieval is a separately verified
extension, not silently fetching all rows and relying on the Rust late check.
Keep totals/truncation/rows-unprocessed honest. Do not reconstruct full inputs from
ordinary preview or the Basic 200-tuple report. Respect existing execution
ownership/cancellation and clear evidence on project/connection changes.

Feed acquired actual rows into
[runMatchingTrial](../../../src/app/matching/runTrial.ts:127) and existing
[matching retrieval](../../../crates/dwh-engine/src/matching/retrieve.rs:194).
Return/join original Host acquisition fields by exact source/candidate IDs instead
of the current synthetic key labels and ID-only candidate display. Preserve the
actual LLM allowlist map, currently omitted by the session adapter. Reuse existing
[semantic expansion](../../../src/app/matching/semanticExpand.ts) and
[ranking](../../../src/app/matching/llmRank.ts) only with the verified live field
snapshot, remaining budget and user permission. No fixture-derived target snapshot.

**Required correctness gate before Advanced enablement:** inspected contextual
retrieval currently scores reference context as a soft signal, treats hard fields
as score ≥0.85 rather than strict normalized equality, may expand across failed
hard constraints, and does not return score/field evidence. Its normalization
implementation is also fixed trim/lower rather than a complete plan interpreter.
These differ from the structured plan promises. Reconcile these narrowly in the
existing contextual implementation and contract tests, or refuse unsupported
semantics explicitly; never relabel today's results as satisfying those promises.
Return actual score evidence additively, not a renderer reconstruction. Until
then Advanced bulk eligibility is unknown/false and unavailable semantics remain
disabled. This is repair/reuse of the existing engine, not a replacement engine.

## 4. Candidate verification and JOIN-bound commit

The current [Host accept API](../../../crates/dwh-host/src/commands/matching.rs:99)
constructs its candidate registry from the request. It validates consistency, but
does not establish that arbitrary caller candidate bodies came from a live query.
The batch handler also accepts materialized selections. Do not claim either is
already a Host-owned evidence registry or that their composition proves origin.

Recommended narrow integration: add live candidate verification/materialization
at the existing Host matching boundary, re-reading the bounded original input for
the submitted source/candidate identities under the confirmed plan. Reuse existing
tuple/contextual acquisition and validators, reject unknown/mutated outputs and
revisions, and materialize output fields on Host. Keep verification scoped to one
request/run, not a generic durable registry/store/bus. A changed returned candidate
invalidates evidence and requires refresh; do not silently update a confirmed target.
External in-place changes still lack snapshot isolation and definition fingerprints
alone cannot detect them. Test forged direct Host calls, not only disabled buttons.

For both producers, the App handler receives the session's immutable JOIN binding
and verified accepted candidate IDs/revisions, not authority from current canvas
selection. Check current project-session generation and exact original definition
token; resolve original JOIN; verify locked input/output alignment and write policy.
Use existing whole-batch readiness planner, compatible static-seed restrictions,
dirty-draft/delta/Save guards and existing map-write/project-replacement guard.
Prepare Mapping + ApplyPlan + project fold privately and dispatch the existing
expected-project reducer transaction. Never publish a map and then call ordinary
Mapping Save/Apply as two independent operations. Existing Mapping-entry sessions
continue their existing seed/source persistence path without gaining JOIN authority.

Keep Matching mounted across its own committed-context transition. Pending commit
locks edits and old rows until reducer acknowledgement. Match receipt against
project session/run and exact expected resulting context, including shifted JOIN
index; update binding from that receipt only. Clear old actionable evidence/
decisions, show acknowledged count and wait for explicit refresh. Unrelated edits,
project replacement or ABA invalidate replies/summaries. Failure in unchanged
context retains dirty decisions. Local fingerprints/receipts may contain credentials:
never persist, send to models, log or include in telemetry. Project Save is separate.

## 5. Milestones and validation

1. Shared model/adapters/decision reducer and pure tests first. Cover nullable/
   delimiter/whitespace identity, arities 1–5 plus a higher-arity unit, counts,
   provenance deduplication, incomplete/unknown evidence, late reply preservation,
   conservative bulk count/undo and no preselection.
2. Basic existing Matching UI + explicit JOIN-bound atomic commit. Adapt the real
   [batch Electron journey](../../../e2e/electron/join-batch-save.spec.ts) to use
   the actual Matching tab: CSV/Rust fuzzy, bounded loopback LLM, multi-source
   acceptance, old-or-complete project publication, execute, Save, fresh-process
   reopen and equal execution. Verify rightOn differs from candidate ID and from
   physical column order; context-sharing sources must remain isolated.
3. Basic negative gates: wrong current JOIN, stale/deleted original JOIN, upstream
   edits, project ABA, dirty Mapping/deltas, Save in flight, incompatible maps,
   Apply failure, unknown/mutated Host candidates, duplicate/null/trim-collision
   tuples, receipt-before-callback rerender, no auto-refresh and retryable failure.
   Do not proceed to Advanced before this milestone passes.
4. Advanced acquisition/semantic correctness after Basic. Real extra fields,
   constraints/reference semantics, identity/output distinction, contradictory
   same-key context, cap+1 refusal, null/missing fields, cancellation/stale replies,
   same atomic commit and cold reopen. Extend existing tests rather than replacing
   them with injected sessions. Mapping-origin and Suggest Right regressions stay.
5. Review precise evidence, limitations and all active capability deltas; merge
   only delivered requirements and archive/complete only after acceptance.

Known inherited limitations: definition-only freshness; no durable draft restore;
Basic bounded search is not dataset-wide; contextual scores are a different metric;
linked seed/warehouse writes are not made atomic with a graph reducer; the recorded
parallel native SIGSEGV remains unresolved, so serial successes are not a parallel
green claim; paid-provider, PostgreSQL and Parquet integration need separate evidence.

## 6. Documentation read for this phase

- [ADR/OpenSpec rule](../../../.cursor/rules/adr-openspec.mdc).
- [ADR-0044](../../../docs/adr/0044-matching-workspace.md),
  [ADR-0047](../../../docs/adr/0047-matching-demo-live-boundary.md),
  [ADR-0049](../../../docs/adr/0049-unified-suggest-right.md),
  [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md).
- [OpenSpec index](../../README.md),
  [Matching capability](../../specs/matching-workspace/spec.md),
  [batch capability](../../specs/unified-batch-tuple-matching/spec.md),
  [Suggest Right capability](../../specs/unified-suggest-right/spec.md).
- [Matching report](../matching-workspace/report.md),
  [Save acknowledgement report](../matching-save-ack/report.md),
  [demo/live report](../matching-demo-live/report.md),
  [Suggest Right report](../unified-suggest-right/report.md),
  [batch report](../unified-batch-tuple-matching/report.md) through its evidence,
  risks and documentation-delivery sections.
- [Product design](../../../docs/DESIGN.md) and
  [product engineering specification](../../../docs/SPEC.md) through frontend
  contracts. General no-row-to-AI wording must remain qualified by the existing
  opt-in bounded matching-field permission contract, not silently expanded.

Parent handoff reports [agent instructions](../../../AGENTS.md) already read,
clean baseline and remote/HEAD checks; these were not independently rerun by this
architecture-only tool session. This packet's code-location table identifies the
actual implementations inspected here. No product tests or shell checks are claimed.
