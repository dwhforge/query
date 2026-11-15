# Spec Delta: matching-workspace

Current UI/commit amendment: [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md)
supersedes the historical separate Lens/contextual review boundary. One Matching
tab owns default JOIN and contextual plan results. JOIN-origin sessions lock full
ordered LEFT inputs and RIGHT outputs and use atomic Mapping + Apply; the
Mapping-origin Save/storage requirements below remain scoped to Mapping entry.
Delivered unified requirements are integrated at the end of this capability.

## Requirements

### Requirement: One Lens Matching entry

Join Lens SHALL expose one Find Matches action opening the existing Matching tab
without running automatically. Edit plan changes retrieval semantics, not the
Review UI. There SHALL NOT be a competing inline batch/contextual review.

#### Scenario: Mapping editor opens Matching
- **GIVEN** a Mapping editor tab for a map
- **WHEN** the user chooses **Open matching…**
- **THEN** a Matching session opens bound to that map

#### Scenario: Matching opens Lens for outcome
- **GIVEN** a Matching session after Save (or with an applied map)
- **WHEN** the user chooses **Open result in Lens**
- **THEN** Join Lens opens for inspection
- **AND** Matching session state is not silently discarded by that navigation

#### Scenario: Lens → Matching does not auto-run
- **GIVEN** the user opens Matching from Lens with an explicit scope
- **WHEN** Matching opens
- **THEN** scope and transferable settings are shown
- **AND** a second processing run does not start automatically

### Requirement: Matching workspace tab and session lifecycle

The product SHALL provide a Matching workspace tab beside Pipeline and Mapping
editor. It SHALL include: structured plan editor (optional chat), run status and
controls, proposal table, detail panel, counters, and final review. Until
restart persistence ships, Matching SHALL always show a persistent banner that
the draft exists only for the current app run, will not restore after restart,
and only Saved map correspondences persist. Tab switch SHALL preserve session
state in-process. Closing Matching, closing the project, changing connection, or
quitting the app with unsaved user decisions SHALL warn. The product SHALL NOT
promise crash protection. Without restart restore, Matching SHALL be positioned
only as a capped preview workplace.

#### Scenario: Banner always visible before persistence
- **GIVEN** an open Matching session without durable draft persistence
- **WHEN** the user views any Matching panel
- **THEN** the no-restart-restore limitation is visible without opening docs or
  dismissing a one-shot toast

#### Scenario: Switch tabs keeps draft
- **GIVEN** draft decisions and an active filter in Matching
- **WHEN** the user opens Pipeline then returns
- **THEN** those decisions, filter, and selection remain

### Requirement: Structured MatchingPlan editor (JOIN binding constrained by ADR-0051)

The plan SHALL be the execution contract and edited primarily via structured UI
(source/target, map key, comparison pairs with role hard constraint / soft
signal / reference context, normalization, outputs, ambiguity behaviour, scope
and run limits). When opened from Join Lens, Source/Target/Map key/identity/
outputs/comparison fields SHALL offer column and query choices from the Join
parents (combos / multi-select), not only free text; defaults SHALL prefer the
left FromQuery parent as Source, id-like target identity (e.g. `vendor_id`), and
one soft comparison per Join ON pair. Chat MAY populate the editor but SHALL NOT
be required to edit it. A valid plan SHALL use one primary control **Apply plan and run trial**.
The product SHALL block only unresolved blockers (missing identity,
ambiguous map key, incompatible outputs), not per-field confirms. Plan changes
SHALL show a concrete diff and affected results. The product SHALL maintain
separate semantic and UI revisions: display/sort/label changes do not invalidate
proposals; comparison-semantics changes invalidate affected proposals; map key,
target identity, or outputs changes require re-validation of the affected draft.
LLM SHALL NOT silently alter semantic plan rules.

#### Scenario: Apply plan starts trial without chat
- **GIVEN** a valid plan filled in the structured editor with chat collapsed
- **WHEN** the user activates **Apply plan and run trial**
- **THEN** the trial run starts under plan scope/limits
- **AND** no chat message is required

#### Scenario: UI-only plan tweak keeps proposals
- **GIVEN** proposals under semantic revision R
- **WHEN** the user only changes sort order or a display label (UI revision)
- **THEN** proposals are not marked Stale for that reason

### Requirement: Numeric run caps and metrics

Matching runs SHALL enforce documented first-slice caps (trial ≤20 unique map
keys; mass ≤200 unique map keys; retrieval shortlist ≤40 candidates/key; ≤10
candidates/key per LLM request; local full-scan target universe ≤10 000 rows;
≤2 parallel LLM requests; ≤1 automatic retry/request; ≤220 LLM calls/run
including plan interpretation and retries) or a shared config that reuses HEAD
fuzzy/LLM relatives with explicit justification for differences. Targets above
the local universe cap SHALL use server-side retrieval or refuse with
explanation — never a silent full download. Expand-search SHALL stay within
remaining budget. Token hard limits SHALL come from provider config. Missing
monetary tariffs SHALL NOT lift caps. Budget exhaustion SHALL yield a partial
result with stop reason and SHALL NOT silently continue past the limit. Before
run the UI SHALL show scope and upper bounds; after run it SHALL show actual
candidates, calls, tokens, duration, retries, and unprocessed keys.

#### Scenario: Over-cap target refuses silent download
- **GIVEN** a target relation larger than the local universe cap and no
  server-side retrieval path configured
- **WHEN** the user starts a run
- **THEN** the product refuses or requires an explicit alternative path
- **AND** does not download the full target unnoticed

#### Scenario: Budget stop is partial and labelled
- **GIVEN** a run that exhausts the LLM call budget mid-scope
- **WHEN** processing stops
- **THEN** completed keys remain available for review
- **AND** the stop reason and unprocessed key count are shown
- **AND** no further batches run automatically past the limit

### Requirement: Host-side validation trust boundary

Client-side checks are UX only. Accepting an LLM result, accepting a draft
decision, and final commit SHALL validate in the application/host layer: task/
session identity, semantic plan revision, full source key, target ID in the
registered candidate set, target evidence freshness, outputs materialized from
one registered target row, and live map content plus write policy. The renderer
SHALL submit proposal/candidate identifiers and expected revisions — not a
trusted output tuple. Manual search picks SHALL register as verified candidates
before use. Forged host API payloads (unknown target ID, other-session ID,
mutated outputs, stale revision, read-only map write) SHALL be rejected
regardless of renderer state.

#### Scenario: Forged unknown target id rejected at host
- **GIVEN** a Matching session with a registered candidate set
- **WHEN** a host draft-accept or commit API is called with a target ID absent
  from that set
- **THEN** the call is rejected
- **AND** no map write occurs

#### Scenario: Renderer output tuple is ignored
- **GIVEN** a commit request that includes client-supplied output values
  disagreeing with the registered candidate
- **WHEN** the host processes commit
- **THEN** it materializes outputs from the registered candidate (or rejects)
- **AND** does not persist the untrusted client tuple as authoritative

### Requirement: Map-key merge and bulk confirm

The decision unit SHALL be the full map key. Merge logic SHALL compare map
baseline at prepare, live map value, and confirmed proposal. “Filled” means an
existing map row for that From key under the map model — not an automatic
interpretation of `0`, `false`, `""`, or nullable outputs as absence. Ordinary
bulk confirm SHALL NOT replace differing existing values, resolve same-key
conflicts, pick winners by LLM arrival order, or override a confirmed choice
with a later proposal. Conflict at final commit SHALL stop without silent
partial Save. Multiple source rows sharing one key and tuple SHALL count as one
decision with an affected-row count.

#### Scenario: Conflicting proposals block bulk
- **GIVEN** one map key with two different proposed target tuples
- **WHEN** bulk confirm runs over a scope including that key
- **THEN** the conflict is not auto-accepted
- **AND** no map write occurs for that key via bulk

#### Scenario: Same output is no-op
- **GIVEN** the map already contains the confirmed output tuple for a key
- **WHEN** final Save includes that decision
- **THEN** the result is treated as already matching / no-op
- **AND** no duplicate From row is created

#### Scenario: Different existing tuple needs explicit replace
- **GIVEN** the map has a different output tuple for the key
- **WHEN** bulk confirm runs without an explicit replace agreement
- **THEN** that key is excluded from bulk acceptance

### Requirement: Proposal contract and states

Each MatchingProposal SHALL include source identity and full map key, used
source values, proposed target identity or no-choice, host-materializable
outputs from one target row, alternatives, short field evidence, contradictions,
search completeness, semantic plan and evidence revisions, provenance, and
model/prompt metadata when LLM was used. LLM self-scores SHALL NOT authorize
auto-save. States SHALL distinguish at least: Proposed, Ambiguous, No
candidates, Incomplete search, Confirmed in draft, Deferred, Rejected, Stale,
Saved; plus explicit no suitable target. Incomplete/bounded search SHALL NOT
render as confident non-match. Global one-to-one assignment SHALL NOT be
required.

#### Scenario: One key spanning many source rows
- **GIVEN** 24 source rows that share one map key
- **WHEN** counters and review labels are shown
- **THEN** the UI presents one correspondence affecting 24 rows

#### Scenario: Incomplete search is not proven absence
- **GIVEN** a source key whose candidate search was truncated or bounded
- **WHEN** no candidate is returned
- **THEN** the state is Incomplete search or equivalent — not confident “no match”

### Requirement: Review UI and draft confirm

The review table SHALL show source identity/key values, proposed target and main
fields, short evidence, near-alternative presence, and decision status, with
actions to open detail, confirm draft, choose alternative, defer, reject, or
mark no suitable target. Filters SHALL include needs decision, ambiguous,
incomplete search, confirmed, stale, and all. Paging SHALL NOT lose draft.
Counters SHALL separately track source rows, unique map keys, proposals, and
confirmed decisions. Detail view SHALL compare proposed vs alternatives with
original and normalized values and checkable evidence (not color alone). Bulk
draft confirm SHALL show exact scope and exclusions. Draft confirm SHALL NOT
write the map or database.

#### Scenario: Choose alternative into draft without write
- **GIVEN** a proposal with a proposed target and a listed alternative
- **WHEN** the user selects the alternative and confirms draft
- **THEN** the draft decision targets that alternative
- **AND** no map/DB write has occurred yet

### Requirement: Mapping-origin final review Save uses existing storage semantics

Before Save the product SHALL show adds, changes, unresolved (not saved), and
affected source rows, with From tuple / old outputs / new outputs / decision
origin for changes. Only explicitly confirmed non-stale decisions SHALL save,
via existing seed / source dirty-delta / query / ref semantics and shared import
write refusal. The product SHALL NOT create a physical table, alter schema, or
auto-switch storage. Warehouse conflict SHALL NOT be presented as successful
Saved. Double-confirm and re-Save SHALL NOT duplicate From rows. Read-only maps
SHALL refuse write-back via the write command.

Commit planning SHALL NOT mark decisions saved or clear unsaved decisions.
Matching SHALL expose explicit saved, no_changes, conflict, refused, and error
outcomes. Only acknowledged persistence or a no-op verified against the current
Mapping SHALL settle the corresponding confirmed decisions. Missing target IDs,
missing maps, import refusal, unsupported write bindings, skipped required writes,
conflict/error, cancellation, and stale context SHALL NOT count as Saved.

Live map data SHALL be revalidated before mutation. Source maps SHALL use real
exact-key baselines and existing dirty-delta writes, not paged/project caches.
Unrelated dirty Mapping drafts SHALL NOT be implicitly saved. Explicitly approved
replacements SHALL write the approved outputs, not silently preserve old cells.

Failures SHALL keep confirmed decisions and allow retry without success copy.
Successful Mapping Save SHALL NOT imply that the project file has been saved.
A skipped external sync for a seed with no linked export SHALL acknowledge its
successful local Mapping save; this is not a refused warehouse or linked-seed write.
Failed external sync SHALL NOT imply rollback of a local AST update. Retrying
after external failure SHALL retry persistence even if local rows now match.
Late replies SHALL NOT settle a changed/closed session or replacement project.

#### Scenario: Missing target or failed write
- **GIVEN** confirmed draft decisions
- **WHEN** target resolution or persistence fails or refuses the write
- **THEN** the draft stays dirty and no Saved message is displayed

#### Scenario: Acknowledged save and repeated save
- **WHEN** the existing Mapping path acknowledges persistence
- **THEN** only the confirmed write set becomes saved
- **AND** a repeated save verifies live rows without duplicating From keys

#### Scenario: Concurrent edit during save
- **WHEN** the map, session, or project changes while planning or writing awaits
- **THEN** stale work is not published as a successful current-session save
- **AND** committed writes are not described as rolled back

#### Scenario: Conflict at commit stops without partial Save
- **GIVEN** confirmed draft decisions and a live map conflict detected at commit
- **WHEN** Save runs
- **THEN** the operation stops and surfaces the conflict
- **AND** does not silently apply a partial subset as successful Saved

#### Scenario: Read-only import refuses Matching Save
- **GIVEN** a map whose import write policy is read-only or broken
- **WHEN** Matching Save is attempted
- **THEN** write-back is refused by the shared write path

## PR-00B: Explicit data origin

Merged from [matching-demo-live](../../changes/matching-demo-live/proposal.md)
under [ADR-0047](../../../docs/adr/0047-matching-demo-live-boundary.md).

### Requirement: Explicit demo/live execution boundary

Matching SHALL default to live sessions. Live trial execution SHALL use the
confirmed plan and explicitly supplied actual source/target rows through existing
matching retrieval, or report unavailable/failed. Missing plan, unavailable or
empty input, host failure and cancellation SHALL NOT produce successful fixture
results, replacement fixture plans, or fabricated completion metrics. Failed
attempts SHALL preserve existing draft decisions rather than replacing them.

Until live row acquisition is wired, ordinary UI sessions SHALL explicitly report
live retrieval unavailable. Merely entering Matching SHALL NOT start a run.

#### Scenario: Live inputs or host unavailable
- **WHEN** a live trial has no plan, no/empty input, or its host request rejects
- **THEN** it reports unavailable or failed, retaining the existing draft
- **AND** no fixture candidates, plan, or success metrics are substituted

### Requirement: Detached, non-writing fixture demo

Offline fixture execution SHALL require explicit Demo fixtures selection. It
SHALL open a separate, visibly labelled demo session without a target Mapping or
Lens context, preserving the original live session. Demo status SHALL survive
review and optional LLM transformation. Demo sessions and fixture-provenance
proposals SHALL be refused by the Matching persistence path before any reads,
validation/planning or writes, even if a Mapping ID is attached. UI controls
SHALL NOT suggest that demo results are live results or allow writing them.

#### Scenario: Offline demo review
- **WHEN** the user explicitly opens Demo fixtures and runs its trial
- **THEN** deterministic offline proposals and metrics are reproducible
- **AND** the demo is labelled as sample data, not the user's query results
- **AND** confirming decisions cannot write into any user Mapping

#### Scenario: Test-only save evidence
- **WHEN** save regressions inject synthetic live evidence via the E2E-only hook
- **THEN** real host validation and Mapping persistence remain exercised
- **AND** tests neither bypass demo policy nor claim live retrieval coverage

<!-- Merged from unified-matching-workspace, 2026-11-15. -->
## Unified workspace requirements (ADR-0051)

### Requirement: One Matching workspace for Basic and Advanced

Find Matches SHALL open the existing Matching workspace. Basic and the Advanced
plan SHALL share the same review and authoritative decision ledger. Advanced
SHALL NOT introduce another tab type, review UI or matching engine. Existing
Mapping-origin sessions retain their Save contract. Suggest Right is unchanged.
The agreed Join Lens No match / Candidates selector and existing Suggest Right
modal SHALL be preserved. Advanced live execution SHALL follow the validated
Basic milestone within this same change, not be deferred to a separate change.

#### Scenario: Basic to Advanced
- GIVEN a JOIN-origin session with reviewed Basic results
- WHEN Advanced plan controls are expanded without semantic edits
- THEN the same proposals, decisions and active review remain
- WHEN comparison semantics change and the user runs a confirmed plan
- THEN affected old evidence/decisions are invalidated with an explicit notice,
  never silently rescored or reinterpreted as confirmed new decisions

### Requirement: JOIN-bound plan shape and authority

Both Basic and Advanced SHALL retain the original ordered LEFT JOIN keys as
Mapping inputs and the aligned ordered RIGHT JOIN keys as outputs. Candidate
identity SHALL NOT determine outputs implicitly. The key/output shape and JOIN
binding SHALL NOT be independently editable. Advanced MAY edit comparison fields,
roles, normalization and ranking. Both paths SHALL retain the same automatic
atomic Mapping + Apply authority under the same validation guarantees.
Detachment, arbitrary output rebinding and Mapping-only transitions are excluded.

#### Scenario: Identity differs from JOIN output
- GIVEN candidate identity vendor_id and a JOIN on vendor_name plus region
- WHEN either Basic or Advanced confirms a real candidate
- THEN Mapping outputs are vendor_name and region in original RIGHT JOIN order
- AND vendor_id identifies the candidate without replacing either output

#### Scenario: Originating JOIN changes
- WHEN a JOIN definition or upstream context changes
- THEN the bound session refuses stale run replies and commit
- AND reopening Find Matches binds current definitions with fresh review
- AND existing decisions are not silently reinterpreted

## Additional unified requirements (ADR-0051)

### Requirement: Lossless producer adapters into one review model

The existing proposal/candidate/session model SHALL become the single review
contract for Basic tuple reports and Advanced contextual results. It SHALL retain
nullable exact tuple parts, used source fields, candidate identity and complete
outputs from one real candidate, occurrences, per-source candidate metric/score/
field scores, alternatives and their merged provenance, evidence revisions,
constraint contradictions, search coverage and omissions. Unknown data SHALL be
explicit; display strings and normalized values SHALL NOT be identities.
One full source key SHALL have at most one authoritative draft decision.
Suggestion, UI selection, confirmed decision and persistence receipt SHALL be
distinct. Status SHALL be derived without duplicating mutable decisions.

#### Scenario: Nullable or delimited values
- WHEN NULL, empty, literal ∅, delimiter-bearing or significant-whitespace values arrive
- THEN review preserves their distinct exact ordered identities
- AND unsafe Mapping parts are blocked with an explanation, not converted

#### Scenario: Late or repeated candidate evidence
- WHEN fuzzy/manual/LLM evidence refers to the same real candidate
- THEN origins merge without creating a second source decision
- AND accepted, deferred, rejected and no-suitable decisions remain authoritative

### Requirement: Conservative bulk acceptance across producers

Bulk SHALL preview exact counts/exclusions and change only draft decisions, with
undo that preserves intervening individual edits. Basic eligibility SHALL retain
the existing complete-universe 0.88 / 0.03 rule, all competitors including hidden
and below-cutoff evidence, safe values and untouched pending state. Missing scores,
incomplete coverage, stale/unsafe/conflicting or user-touched records SHALL be
excluded. Advanced SHALL NOT inherit Basic eligibility from a proposal state or
an LLM self-score. Unknown eligibility SHALL refuse bulk, not manual review.

### Requirement: Real Advanced inputs through Host

Advanced live execution SHALL acquire selected actual fields bound to the
confirmed plan and original JOIN input after preceding transforms, then reuse
existing contextual trial/retrieval and LLM algorithms. JOIN-key-only tuple
reports and ordinary preview samples SHALL NOT masquerade as full-field inputs.
Missing fields, ambiguous source evidence, unavailable connectors, cancellation,
errors or over-cap inputs SHALL report unavailable/partial/refused, never fixtures.
NULL/missing values SHALL NOT be coerced to empty strings. Existing contextual
caps and permission/budget limits remain; no silent full target download.
The normal JOIN entry explicitly uses full unmatched-input scope; Advanced UI
selected/cohort scopes without a captured executable restriction SHALL refuse,
not silently widen to full. NULL contextual fields and over-cap inputs currently
refuse rather than claiming a partial successful run.

#### Scenario: Same map key with contradictory source context
- GIVEN actual source rows sharing a map key but differing in compared context
- WHEN Host acquisition groups the key
- THEN the conflict is explicit and requires review/refusal
- AND no arbitrary first source row becomes authoritative

### Requirement: Lazy candidate detail uses the same verified candidates

The existing review detail SHALL load/render the active source's real right tuple
candidates lazily, retain exact identity, fields, counts, score availability and
pagination/omissions, and cancel/ignore stale selection requests. Basic browsing
remains within its retrieved universe. Advanced SHALL provide explicit Host lookup
beyond shortlist and soft cutoff, with literal field/identity search and stable
20-result pages inside the bounded acquired RIGHT universe. Results SHALL retain
source/plan/run/evidence identity, real target identity/fields/outputs, occurrence
counts and comparison evidence. Normalized hard constraints SHALL still hold.
A human MAY explicitly confirm an admissible zero-score candidate in the same
ledger without granting confidence-bulk eligibility. Lookup never auto-confirms.
Neither browsing path implies dataset-wide or large-dictionary scalability.

Late replies after source/query/run/context changes or ABA SHALL NOT install
evidence. Commit SHALL reacquire the frozen run configuration and replay the exact
source/query/page, checking real candidate membership and actual outputs. Forged
pages/IDs/outputs, stale snapshots and failed hard constraints SHALL refuse.

#### Scenario: Correct candidate absent from shortlist
- GIVEN an admissible real RIGHT object with zero soft score outside the shortlist
- WHEN the user finds it through existing Review lookup and explicitly confirms
- THEN one manual-provenance decision joins the same authoritative ledger
- AND verified Mapping + Apply, execution, Save and cold reopen preserve it

#### Scenario: Critical real App interleavings
- WHEN JOIN deletion, upstream changes or project/context ABA occur during verification
- THEN no stale Mapping, Apply or success receipt is published
- WHEN private Apply preparation fails
- THEN no partial project is published and unchanged-context decisions remain retryable
- WHEN Mapping Save and Matching write race in either order
- THEN the conflicting write refuses rather than overlapping persistence/publication

### Requirement: JOIN-bound atomic commit and acknowledged refresh

JOIN-bound commit SHALL resolve the session's original target, validate candidate
IDs/session/plan/evidence revisions and real outputs, prepare the complete Mapping
and Apply privately, and publish once with the existing guarded reducer. It SHALL
NOT use current Lens selection or save Mapping then attempt Apply separately.
Incompatible maps, conflicting/duplicate keys, dirty editor/deltas, Save in flight,
frozen context and stale ownership SHALL block the entire write. Success requires
the reducer's exact receipt with project session, resulting JOIN index/context
and count. Acknowledgement clears old actionable review; explicit Refresh remaining
review retrieves again. Failure in unchanged context keeps retryable decisions.
Project Save remains separate; no warehouse atomicity or external freshness claim.

#### Scenario: Navigate before writing
- GIVEN Matching bound to JOIN A and the canvas now selects JOIN B
- WHEN the user writes accepted decisions
- THEN only validated JOIN A can receive Mapping + Apply
- AND missing/stale A refuses rather than falling back to B

#### Scenario: Commit rerenders the workspace before callback completion
- WHEN Apply insertion changes project context and JOIN index
- THEN the matching session accepts only its own exact reducer receipt transition
- AND success remains visible without automatic retrieval or stale actionable rows
- AND unrelated edits/project replacement/ABA cannot revive the old summary

## ADR-0052 — record-first relationship workbench

Decision: [ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
Verified bounded delivery: [runtime evidence and residual limits](../../changes/unified-matching-workbench/runtime-report.md).
This amends presentation only; existing session, ledger and write authority remain.

### Requirement: Record-first workspace

The existing Matching tab SHALL prioritize labelled LEFT and RIGHT business values,
two searchable record explorers, one selected relationship comparison and explicit
decision consequences. Composite key parts SHALL have individual labels. NULL,
empty strings and significant whitespace SHALL remain distinguishable and exact.
Technical IDs and JSON tuple arrays SHALL NOT be primary business labels. Missing
unacquired fields SHALL remain unknown, not be fabricated from IDs or fixtures.

#### Scenario: Composite business values
- GIVEN keys with identical names but different regions, NULL, empty and padded values
- WHEN records are listed or compared
- THEN each ordered field is readable and exact values retain distinct identity
- AND unsafe Mapping writes remain refused under existing validation

### Requirement: One authority, two navigation directions

LEFT focus SHALL show suggestions, alternatives, explicit manual results, current
draft and available Mapping relationship. RIGHT focus SHALL show associated LEFT
records in ONE unified readable list with multiple actual JOIN, existing Mapping,
confirmed draft and suggested provenance badges and filters. Authority summaries,
coverage and count units SHALL remain separate and non-additive, not four expanded lists. Both directions SHALL use the same Matching session and source-key ledger.
Focus, candidate selection and explicit confirmation SHALL be separate states.
Navigation SHALL NOT select a candidate for confirmation, decide, persist or rerun.
No producer/LLM result SHALL imply consent.

#### Scenario: Round trip without changing a decision
- GIVEN two LEFT proposals referencing the same RIGHT record and one confirmed draft
- WHEN the user moves LEFT → RIGHT → related LEFT → another RIGHT
- THEN the current review and exact decisions remain intact without unnecessary retrieval
- AND a later explicit confirmation resolves the same source-scoped candidate validation as LEFT focus

#### Scenario: Target exists with no related source
- GIVEN an acquired target with no proposal edges, draft decisions or acquired baseline rows
- WHEN the user focuses it
- THEN each acquired group reports zero within its own coverage
- AND unacquired actual JOIN or Mapping groups report not inspected, not zero

### Requirement: Provenance, identity and non-additive counts

Relationship identity SHALL include exact ordered LEFT inputs, ordered RIGHT
outputs, independent target identity where known, session/run and relevant
semantic/evidence revisions. Collision-safe structured tuple identity SHALL be
reused; display strings and delimiter-joined keys SHALL NOT be identity.
Duplicate producer origins SHALL merge on the same source/target edge without
duplicate per-group counting. The UI SHALL NOT sum overlapping provenance groups.
Mapping output equality SHALL NOT invent an independent target identity.

#### Scenario: Same relationship exists and is newly confirmed
- GIVEN an acquired saved Mapping row and a draft with the same full outputs
- WHEN the RIGHT record is inspected
- THEN existing and draft provenance are visible separately, the draft is a no-op against that baseline
- AND no distinct-target identity is inferred solely from equal outputs

### Requirement: Honest reverse coverage

Every group SHALL disclose its basis, units and completeness. Complete within
installed run edges SHALL NOT imply complete source acquisition, shortlist,
external dictionary or executed JOIN coverage. Unknown, not acquired, refused,
sampled, stale and verified-empty SHALL be distinct. Record counts SHALL be
distinguished from distinct source-key counts and output counts.

#### Scenario: Bounded acquisition or incomplete shortlist
- WHEN RIGHT focus uses a partial source run or omitted candidate edges
- THEN it says additional records may exist outside that scope
- AND it never labels the index all associated LEFT records

### Requirement: Existing Mapping is a read-only baseline, not a draft

The workspace SHALL project the authoritative compatible seed Mapping definition
read-only; it SHALL NOT create another Mapping store. Source/query/ref/range
baselines not acquired by this bounded implementation SHALL be labelled unavailable,
not inferred from empty session arrays. It SHALL establish shape,
output binding and original-JOIN compatibility before presenting saved rows as a
baseline. Empty session arrays SHALL NOT establish completeness. Unsaved editor
rows SHALL NOT be labelled already in Mapping. Existing rows, confirmed-not-written,
suggested, rejected/deferred and stale states SHALL remain distinguishable.

#### Scenario: Unavailable external baseline
- GIVEN source/query/ref storage without a complete supported baseline acquisition
- WHEN inspecting a target
- THEN only acquired Mapping rows are shown with partial/unavailable coverage
- AND missing pages are not interpreted as absent rows or permission to replace

### Requirement: Source-scoped validation from RIGHT focus

Confirmation from RIGHT focus SHALL resolve one exact current LEFT proposal and
candidate, preserve hard constraints, tuple shape, run/evidence freshness, original
JOIN binding and existing manual lookup verification/replay. An acquired target
or reverse edge SHALL NOT by itself grant candidate admissibility. Unsupported
source scopes SHALL refuse rather than expand. Reject/defer semantics SHALL remain
source-ledger semantics; no per-edge rejection authority is added.

#### Scenario: Manual target reached from another source
- GIVEN a target manually retrieved for LEFT A
- WHEN LEFT B is investigated from RIGHT focus
- THEN A's lookup does not authorize B's confirmation
- AND B requires its own existing admissibility or verified source lookup

### Requirement: Secondary controls preserve the review

Matching Rules/Plan, LLM assistance, bulk actions and technical evidence SHALL be
secondary disclosures. Opening/closing them SHALL NOT invalidate evidence, clear
selection/decisions or rerun. Actual semantic edits SHALL preserve existing
invalidation and consent. Conservative high-confidence acceptance and explicit
reviewed bulk SHALL remain separate counted operations with existing eligibility
and undo. Ordinary selection SHALL NOT replace reviewed bulk consent.

### Requirement: Inspection cannot acquire write authority

Reverse/lookup replies SHALL use monotonic request intent plus project/session/run,
binding, revision and focus ownership checks. Late success/error/loading replies
after supersession, same-key ABA, project replacement, JOIN modification, close or
unmount SHALL NOT publish into current inspection or decisions. Pending writes
SHALL keep current lifecycle locks. Existing verified atomic commit and reducer
receipt SHALL remain the only JOIN-bound write authority; project Save is separate.

#### Scenario: LEFT → RIGHT → LEFT ABA during lookup
- WHEN an earlier response returns after the user leaves and returns to the same LEFT
- THEN matching key equality alone cannot install it
- AND decisions, newer loading/error state and write eligibility are unchanged

### Requirement: Bounded sparse presentation

Reverse indexes SHALL reference acquired collections rather than materialize a
Cartesian product or duplicate large row bodies. They SHALL be built once per
relevant immutable data revision, not quadratically per render. Search/navigation
SHALL stay bounded/paged and preserve acquisition caps and explicit refusals.

## MODIFIED presentation requirement

The historical proposal-table/tier-first presentation is replaced by record-first
exploration. Existing Basic, Advanced, manual lookup, LLM, Mapping-origin Save,
JOIN-bound Mapping + Apply, Suggest Right and Lens contracts remain operational.
Runtime verification SHALL include real CSV/DuckDB Electron navigation, lifecycle
and existing Help Lab workflows, not screenshots or synthetic-session/component
tests alone. The exhaustive risk matrix and independent usability/performance
acceptance remain explicitly tracked in the runtime report.

### Requirement: Fast explicit sequential review

Previous/next unresolved SHALL navigate without deciding and preserve filters,
per-source picks, drafts and context. Candidates SHALL remain visible. Pick and
confirm SHALL be separate explicit actions with separate keyboard interactions.
Optional advance after confirm SHALL be opt-in and use the same ledger action.

#### Scenario: Sequential confirmation
- WHEN a user picks a candidate then moves next and previous unresolved
- THEN picks and drafts remain intact and no new decision is created
- WHEN explicitly confirming with advance enabled
- THEN only that source is confirmed and focus advances to an unresolved source

### Requirement: Three distinct reverse scopes

Renderer reverse evidence SHALL NOT be labelled executed JOIN evidence. Existing
Host execution counts and bounded samples SHALL have independent units/coverage.
Complete arbitrary-large executed reverse enumeration SHALL report unsupported;
future paginated executed reverse is not a blocker and no new RPC is required.
