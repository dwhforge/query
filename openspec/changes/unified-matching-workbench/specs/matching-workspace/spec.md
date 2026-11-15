# Delta: Matching workspace — business records and bidirectional relationships

Status: **proposed / not implemented**. Decision:
[ADR-0052](../../../../../docs/adr/0052-matching-relationship-workbench.md).
Extends [merged Matching](../../../../specs/matching-workspace/spec.md) without
weakening ADR-0051 or changing persisted Mapping IR.

## ADDED Requirements

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
records in separate actual JOIN, existing Mapping, confirmed draft and suggested
groups. Both directions SHALL use the same Matching session and source-key ledger.
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

The workspace SHALL reuse the authoritative Mapping definition and existing row
acquisition; it SHALL NOT create another Mapping store. It SHALL establish shape,
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
Final acceptance SHALL require real CSV/DuckDB Electron journeys, the full
navigation/lifecycle matrix and an existing Help Lab workflow, not screenshots or
synthetic-session/component tests alone.
