# Delta: Matching workspace

Decision: [ADR-0051](../../../../../docs/adr/0051-unified-matching-workspace.md).
Status: delivered requirements merged on 2026-11-15; remaining verification/extension work is tracked in tasks.md and report.md.

## MODIFIED Requirements

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

## ADDED Requirements

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
remains within its retrieved universe. Advanced currently browses only its verified
retrieved shortlist; an extra-lookup action beyond that shortlist remains unfinished.
Any future additional lookup SHALL verify candidates before selection/acceptance.
Neither current browsing path implies dataset-wide search.

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
