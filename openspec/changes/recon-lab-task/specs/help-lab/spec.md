# Delta: help-lab — flagship task card

## ADDED Requirements

### Requirement: Session-local reconciliation task

After successful opening of the reconciliation flagship, the workspace SHALL
show one compact dismissible English task card explaining mismatched commercial
SKU versus plant identifiers and pointing to the original Join and Join Lens.
The prepared mapped query SHALL be described as a partial example, not a result
achieved by the user. The card SHALL NOT block Data/Model or Mapping work.

#### Scenario: Open, dismiss, restore
- **WHEN** the user opens the flagship lab
- **THEN** its original dirty recon Join is selected and the task is visible
- **WHEN** the user dismisses the card and navigates or previews
- **THEN** the card remains dismissed until explicitly restored using Lab task

### Requirement: Deterministic task start

Show me SHALL resolve the actual Join in the existing original query, select it
using existing actions and enable Data/Join Lens without changing the graph or
forcing layout collapse. If the query/Join no longer exists, the action SHALL
be unavailable with a readable explanation rather than targeting another step.

#### Scenario: Start from another query
- **GIVEN** the lab session is on another query or Model view
- **WHEN** the user activates Show me
- **THEN** the original Join and Data/Join Lens are selected without pipeline edits

### Requirement: Task state never leaks to another project

Task visibility SHALL be session-local, owned by project identity, and cleared
on successful project/lab replacement. Failed/cancelled replacement SHALL retain
the current session. Matching query names in a normal/reopened project SHALL NOT
activate the task. No tutorial state SHALL be persisted in the project file.

#### Scenario: Switch away
- **WHEN** the user opens another project or a different lab
- **THEN** no stale flagship task remains
