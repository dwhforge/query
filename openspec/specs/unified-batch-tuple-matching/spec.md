# Unified Batch Tuple Matching

Decision: [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md).
Change/evidence: [change record](../../changes/unified-batch-tuple-matching/report.md).

## Requirements

### Requirement: Find Matches uses all ordered Join pairs

The primary Join Lens batch action SHALL be **Find Matches**, superseding legacy
scalar/composite Auto and the former Quick match copy. It SHALL use every ordered
left/right ON pair for any positive arity, with no designated fuzzy slot, mode
picker, glued identity, or scalar fallback. A missing tuple report SHALL produce
an error rather than silently invoke the legacy scalar path.

#### Scenario: Context cannot become a global alias
- **GIVEN** sources sharing their first fields but differing in a later Join key
- **WHEN** one complete source is mapped to a complete right tuple
- **THEN** only that full source identity is remapped
- **AND** all target outputs bind to their aligned left Join columns, regardless
  of physical source column order or different left/right column names

### Requirement: Explicit full-target decisions

The queue SHALL contain one record per exact complete source tuple. Every record
SHALL start pending with no target selected, including exact/unambiguous fuzzy
hits. Review SHALL expose all fields, differences, available field/mean scores,
occurrence counts and duplicate warnings. Selecting a target SHALL NOT accept it;
acceptance SHALL stage a draft only. Skip SHALL not write a Mapping. Only accepted
records SHALL be included in **Write Mapping**. Cancel/dismiss SHALL leave the
project unchanged, and unaccepted decisions SHALL not affect SQL or persistence.

#### Scenario: High score is not consent
- **GIVEN** one high-scoring candidate
- **WHEN** retrieval completes
- **THEN** no target is selected or accepted and Write Mapping is disabled
- **WHEN** the user selects and accepts it
- **THEN** the project remains unchanged until Write Mapping succeeds

### Requirement: Explicit counted high-confidence draft acceptance

An explicit **Accept high-confidence suggestions (N)** action MAY select and accept
eligible records in the draft. Retrieval itself SHALL NOT select/accept/write.
Eligibility SHALL require untouched pending/unselected records, safe complete
tuples, fuzzy winner provenance, complete right coverage, all competitors scored,
score at least 0.88 and a margin at least 0.03 over every competitor, including
below-cutoff/hidden alternatives. Ties, unknown scores, truncated right retrieval,
manual/user-touched decisions and conflicting LLM alternatives SHALL be excluded.
The count SHALL reflect current eligibility. Bulk undo SHALL be available without
overwriting intervening individual decisions. **Write Mapping** remains required.
This is per-source spelling-similarity eligibility, not calibrated global confidence.

#### Scenario: Accept a bounded set without applying it
- **WHEN** the user explicitly accepts N eligible high-confidence suggestions
- **THEN** only those draft decisions become accepted, with no project changes
- **AND** the user can undo the bulk action or write the accepted batch separately

### Requirement: One batch response format

Batch prompts SHALL contain one ordered Join alignment, a bounded list of source
groups with source-specific complete-target allowlists, and exactly one response
schema for all groups. Parse the overall response once, retaining exact source,
target, arity, nullable value, rationale and duplicate checks. Multiple structured
payloads or oversized responses SHALL be rejected wholesale with feedback, not
silently truncated or reduced to the first payload. Suggest Right remains unchanged.

#### Scenario: Several source groups in one model response
- **GIVEN** a prompt containing multiple source groups
- **WHEN** one response contains valid allowed pairs for several groups
- **THEN** all those proposals join the shared queue without automatic acceptance
- **BUT** separate JSON payloads cause explicit rejection of the response

### Requirement: One bounded fuzzy/manual/LLM queue

All alternatives SHALL identify real complete retrieved targets, never invented
field combinations. Fuzzy, manual, and optional LLM origins SHALL share the same
source decision. LLM ranking SHALL remain available alongside fuzzy hits and for
pending records with no fuzzy hit, subject to configuration/host permissions.
LLM results SHALL validate exact complete source and target arrays against the
actual prompt allowlists. Duplicate alternatives SHALL merge provenance; a later
reply SHALL NOT overwrite an accepted/skipped decision or auto-select/accept.

#### Scenario: Model duplicates, invention, and late conflict
- **GIVEN** a fuzzy alternative and a user-accepted target
- **WHEN** a model repeats a candidate, invents a tuple, or proposes a conflicting
  alternative for the accepted source
- **THEN** duplicates do not create extra decisions, invented tuples are rejected,
  and the user's existing decision remains authoritative

### Requirement: Atomic private Mapping and Apply preparation

Write Mapping SHALL validate every accepted selection and the entire resulting
ready map before publishing changes. It SHALL preserve existing multi-output IR,
resolve explicit aligned left-side Apply bindings using the established ApplyPlan,
and fold Mapping + Apply privately. A single reducer publication SHALL require
the live project to remain the expected project captured for preparation. Failure
at any stage SHALL publish neither Mapping edits nor graph changes. Success SHALL
be acknowledged only after reducer commit; repeated clicks SHALL not duplicate
the batch. No Mapping editor navigation SHALL be required. Join ON SHALL NOT be
rewritten as fuzzy conditions. Runtime preparation/validation and explicit project
Save SHALL remain the existing operations; this is not a warehouse transaction.

#### Scenario: A later selection or Apply fails
- **GIVEN** a batch whose first tuple is valid
- **WHEN** a later tuple conflicts, the ready map is invalid, or Apply cannot fold
- **THEN** no earlier tuple, new Mapping, or standalone Apply is published

#### Scenario: An edit wins before reducer commit
- **GIVEN** a privately prepared Mapping + Apply
- **WHEN** the project changes before the reducer receives the commit
- **THEN** the newer project remains intact and the batch reports stale failure

### Requirement: Acknowledged write and deliberate remaining review

The commit receipt SHALL identify the exact resulting context, project session,
actual Join index after Apply insertion and applied count. The Lens SHALL retain
a success summary across only that acknowledged context transition, clear previous
review decisions, and offer **Refresh remaining review** before fresh retrieval.
Awaiting acknowledgement SHALL NOT expose stale actionable records. Intervening
edits, project switches and switch-away/return (ABA) transitions SHALL invalidate
old summaries/replies rather than resurrect them. Failed writes in an unchanged
context SHALL preserve review decisions for correction/retry. Project Save remains
separate from successful local publication.

#### Scenario: Project rerenders before the commit callback resolves
- **WHEN** Mapping and Apply change the workspace and shift the current Join index
- **THEN** the acknowledged applied count remains visible without another search
- **WHEN** the user refreshes remaining review
- **THEN** a new bounded retrieval uses the updated context with fresh pending decisions

### Requirement: Compatible maps and dirty-state refusal

Reuse SHALL be restricted to compatible static seed maps with the expected ordered
From/output shape; otherwise create an eligible new map. An incompatible Mapping
already associated with this Join SHALL block the batch, not be reshaped or
silently bypassed. Source/query/ref/range maps SHALL NOT be converted. Duplicate
From decisions or stored rows and differing existing output tuples SHALL block
the entire write; equal existing outputs SHALL be no-ops. Local editor drafts,
dirty deltas, and in-flight Save SHALL block writes. Frozen Check remap SHALL
refuse the live tuple path with guidance to open the live Join.

#### Scenario: Do not overwrite editor or existing correspondence
- **GIVEN** unsaved map edits, Save in progress, or an existing differing target
- **WHEN** the user attempts Write Mapping
- **THEN** the whole batch fails with an explanation and all existing state remains

### Requirement: Local-only complete definition freshness

The session fingerprint SHALL include full workspace, Join target, connections,
sources, and project-reference context. Object-key order SHALL be canonicalized;
array order SHALL remain meaningful. The token, which can contain secrets, SHALL
stay **LOCAL ONLY**, never in prompts, logs, telemetry, or persisted drafts.
Definition changes SHALL invalidate the session and late retrieval/LLM replies.
The handler SHALL recheck current context before preparation, and the reducer
SHALL separately guard intervening project changes.

This definition-only fingerprint SHALL NOT be represented as detecting external
file/database content changed in place. It is not a content hash, database
snapshot, external revision probe, or durable freshness guarantee.

#### Scenario: Upstream change versus external content change
- **WHEN** an upstream query, map, connection/source definition or project-reference
  context changes
- **THEN** previous batch decisions/replies are invalidated
- **BUT** an external CSV/table modified without any definition change is outside
  this detection boundary and requires fresh retrieval/review

### Requirement: Exact tuple identity and unsafe-value explanation

NULL, empty string, whitespace-only string, literal ∅, and significant whitespace
SHALL remain distinct in review. The existing
[tupleMappingBlock()](../../../src/lib/joinLensTuple.ts:18) gate SHALL block NULL,
empty and whitespace-only parts on either side before Mapping confirmation.
Significant leading/trailing whitespace in otherwise nonempty values SHALL be
retained in identity and persistence, not implicitly trimmed or case-folded.
This conservative authoring gate SHALL NOT redefine stored Mapping value rules.
Existing KeyMap readiness validation SHALL also be checked before publication,
without storing its cleaned values. Distinct exact From tuples that collide under
legacy trim-based uniqueness SHALL block the whole batch with an explanation,
not be silently normalized, merged or partially committed.

#### Scenario: Display labels are not identities
- **GIVEN** values with separators, literal ∅, or leading/trailing whitespace
- **THEN** exact structured arrays distinguish them
- **AND** selecting a NULL/empty/whitespace-only tuple explains the block rather
  than converting it to a different value

### Requirement: Numeric caps and incomplete coverage are visible

Reuse the unchanged Rust all-field equal-mean scorer and 0.88 cutoff. Retrieval
SHALL remain bounded to 200 distinct tuples per side, with totals/truncation.
Initial fuzzy UI alternatives SHALL be capped at 8 per source with omissions
reported. Manual all-field search SHALL cover retrieved targets only, paginated
20 per page. Each batch LLM prompt SHALL include at most 4 pending source groups
with at most 12 targets each and a 10,000-character budget; actual prompt allowlists
may be smaller. Chat SHALL retain at most 6 messages of 4,000 characters each.
Focusing a pending record SHALL make it reachable for a subsequent bounded prompt.
Omitted groups/candidates SHALL be reported; no result SHALL imply dataset-wide
absence or complete search. These are not arity caps or a monetary/token budget.

#### Scenario: No fuzzy candidate in a bounded search
- **GIVEN** a pending source without a candidate above cutoff
- **THEN** manual review and optional LLM remain reachable
- **AND** truncation/prompt omissions are explicit, not a proven non-match

### Requirement: Adjacent implementations and runtime semantics remain intact

Suggest Right and MatchingWorkspace implementations SHALL remain unchanged by
this batch replacement. Contextual Matching retains its own plan, constraints,
budgets, trust boundary and Save lifecycle. Legacy Rust scalar/composite command
compatibility, existing Mapping persistence and Apply execution guards SHALL
remain. No new format, storage, fuzzy Join ON, LLM runtime Apply, durable batch
draft, or global one-to-one assignment is introduced.

#### Scenario: Execute and cold reopen
- **GIVEN** several accepted complete tuples written in one operation
- **WHEN** the project executes, is explicitly saved, then opened in a fresh app
- **THEN** full From/output values and aligned Apply bindings persist and execution
  reproduces the committed result
- **AND** Apply retains input cardinality; a later nonunique-right Join can still
  multiply rows independently
