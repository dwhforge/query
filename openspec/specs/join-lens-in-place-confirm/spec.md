# Spec: join-lens-in-place-confirm

Supersession: [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md)
moves batch review/confirmation to the existing Matching tab. Historical Lens
queue layout requirements below no longer expose a competing workflow. Atomic
Mapping + Apply safety survives; Suggest Right remains its existing modal.

Capability contract for [ADR-0042](../../../docs/adr/0042-join-lens-in-place-confirm.md).
Amended by [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md);
the [batch tuple contract](../unified-batch-tuple-matching/spec.md) supplies full
identity, atomic commit, freshness and caps. Earlier change documents remain historical.

## Requirements

### Requirement: Match proposals stage in Join Lens

When the user runs Join Lens **Find Matches** for a Join, the product SHALL
stage match proposals in the Join Lens session UI with enough context to decide
(complete ordered source/target fields, differences, scores, provenance,
occurrence counts and available alternatives). The
KeyMap editor SHALL NOT be required to review or resolve those proposals.

#### Scenario: Proposals visible in Lens
- **GIVEN** a Join with unmatched keys and a successful fuzzy suggest
- **WHEN** Find Matches results are shown
- **THEN** each proposal appears in the Lens with a proposed To value
- **AND** the user can inspect it without opening a KeyMap tab

### Requirement: Session staging does not mutate Join or KeyMap

Staged proposals SHALL NOT change Join ON, preview SQL, export, or KeyMap rows
until the user confirms. Cancel, dismiss, or switching away from the Join SHALL
drop unconfirmed session state without project changes.

#### Scenario: Dismiss leaves project unchanged
- **GIVEN** staged accepted and pending proposals in Lens
- **WHEN** the user cancels or leaves the Join without Write Mapping
- **THEN** KeyMaps and query steps are unchanged

### Requirement: Every proposal needs explicit target selection and acceptance

Every proposal SHALL start pending with no target selected, including exact or
unambiguous fuzzy hits. The user SHALL select a complete target and explicitly
accept it in the draft, or skip. Selecting alone SHALL NOT accept or write it.
This supersedes the original pre-acceptance policy.

#### Scenario: Pending cannot apply without choice
- **GIVEN** a high-scoring or ambiguous proposal still pending
- **WHEN** the user activates Write Mapping for other accepted records
- **THEN** that proposal is not written to the KeyMap
- **AND** only accepted session rows are committed

### Requirement: Single Write Mapping atomically commits Mapping and Apply

A single confirm control SHALL write all session-accepted proposals into a KeyMap
(compatible static seed or newly created) and ensure ApplyKeyMap is present for
all aligned left Join columns, using existing multi-output SoT and ApplyPlan
rules. The full batch/ready map and Apply fold SHALL be prepared privately, then
published once by a reducer guarded against intervening project edits. Failure
SHALL leave both Mapping and graph unchanged; success SHALL be acknowledged only
after reducer commit. Incompatible existing mappings, conflicts, duplicate From
tuples, dirty editor state or Save in flight SHALL block the entire batch.
It SHALL NOT rewrite Join ON as a fuzzy condition. Completing Write Mapping SHALL
NOT require opening a KeyMap tab or automatically Save the project file.

#### Scenario: Write Mapping once
- **GIVEN** several session-accepted proposals and pending rows skipped or left pending
- **WHEN** the user activates Write Mapping
- **THEN** those From→To rows exist on a KeyMap
- **AND** ApplyKeyMap is on the graph for that remap
- **AND** Join ON column names are unchanged
- **AND** the KeyMap editor tab is not required to finish

### Requirement: Fuzzy and LLM alternatives use the same queue

Optional LLM suggestions for pending sources, including those with fuzzy hits,
SHALL enter the same Lens queue as alternatives validated against complete tuples
actually sent. They SHALL NOT auto-select/accept or overwrite accepted/skipped
decisions. LLM SHALL NOT write Join ON or KeyMap rows without the same explicit
Write Mapping path.

#### Scenario: LLM pair needs confirm
- **GIVEN** an LLM-suggested leftover pair in the Lens queue
- **WHEN** the user has not accepted it
- **THEN** Write Mapping does not persist that pair
