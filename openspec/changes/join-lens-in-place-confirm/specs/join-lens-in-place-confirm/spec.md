# Spec Delta: join-lens-in-place-confirm

## ADDED Requirements

### Requirement: Match proposals stage in Join Lens

When the user runs Join Lens Auto (or equivalent) for a Join, the product SHALL
stage match proposals in the Join Lens session UI with enough context to decide
(from key, proposed to, score, ambiguous flag, and runner-up when present). The
KeyMap editor SHALL NOT be required to review or resolve those proposals.

#### Scenario: Proposals visible in Lens
- **GIVEN** a Join with unmatched keys and a successful fuzzy suggest
- **WHEN** Auto results are shown
- **THEN** each proposal appears in the Lens with a proposed To value
- **AND** the user can inspect it without opening a KeyMap tab

### Requirement: Session staging does not mutate Join or KeyMap

Staged proposals SHALL NOT change Join ON, preview SQL, export, or KeyMap rows
until the user confirms. Cancel, dismiss, or switching away from the Join SHALL
drop unconfirmed session state without project changes.

#### Scenario: Dismiss leaves project unchanged
- **GIVEN** staged accepted and pending proposals in Lens
- **WHEN** the user cancels or leaves the Join without Apply accepted
- **THEN** KeyMaps and query steps are unchanged

### Requirement: Unambiguous pre-accepted; disputes need a choice

Unambiguous fuzzy proposals SHALL start accepted in the session. Ambiguous
proposals SHALL require an explicit in-Lens choice (accept best, choose
runner-up / listed candidate, or skip) before they can be applied. One click per
disputed row is the intended interaction.

#### Scenario: Ambiguous cannot apply without choice
- **GIVEN** an ambiguous proposal still pending
- **WHEN** the user activates Apply accepted
- **THEN** that proposal is not written to the KeyMap
- **AND** only accepted session rows are committed

### Requirement: Single Apply accepted commits to KeyMap

A single confirm control SHALL write all session-accepted proposals into a KeyMap
(existing or newly created) and ensure ApplyKeyMap is present for the remap
column / side, using existing KeyMap SoT and Apply rules. It SHALL NOT rewrite
Join ON as a fuzzy condition.

#### Scenario: Apply accepted once
- **GIVEN** several session-accepted proposals and zero pending required disputes
  (or pending rows are skipped)
- **WHEN** the user activates Apply accepted
- **THEN** those From→To rows exist on a KeyMap
- **AND** ApplyKeyMap is on the graph for that remap
- **AND** Join ON column names are unchanged

### Requirement: LLM leftovers use the same queue

Optional LLM suggestions for matcher leftovers SHALL enter the same Lens session
queue as pending proposals. LLM SHALL NOT write Join ON or KeyMap rows without
the same Apply accepted path.

#### Scenario: LLM pair needs confirm
- **GIVEN** an LLM-suggested leftover pair in the Lens queue
- **WHEN** the user has not accepted it
- **THEN** Apply accepted does not persist that pair
