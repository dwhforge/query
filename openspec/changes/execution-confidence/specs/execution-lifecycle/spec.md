# Delta: execution-lifecycle — preview confidence

## ADDED Requirements

### Requirement: Preview results belong to the current input

Data SHALL NOT present rows from a different selected query, selected Join scope,
project or edited workspace as the current result. Pending debounce and IPC replies
SHALL be invalidated on input changes. Cache hits SHALL supersede older requests.
Project/map/source edits SHALL invalidate cached results; explicit Recompute SHALL
bypass the session cache. No new authoring state or second workspace store is introduced.

#### Scenario: Change selection while waiting
- **WHEN** a new query preview is pending
- **THEN** old-query rows are not shown under the new query label
- **AND** a later old reply cannot replace the current result

### Requirement: Distinct preview terminal states

Data SHALL distinguish queued/running, cancelled, failed and ready-empty states.
Cancel SHALL invalidate pending UI completion as well as request host interruption.
Recompute SHALL explicitly retry the current input without navigating away.
Existing ErrorBanner SHALL retain error details; empty content SHALL NOT misleadingly
say waiting after a terminal failure or cancellation.

#### Scenario: Cancel a held request
- **WHEN** the user cancels a queued/running preview
- **THEN** Data shows cancelled and stops local running progress
- **AND** late completion does not restore the cancelled result

#### Scenario: Failed preview
- **WHEN** host preview fails
- **THEN** Data names the failed state, exposes existing error details and offers recomputation

### Requirement: Honest result scope

The result dock SHALL identify the query and whether Data is the final query output
or truncated through a selected Join. Sample versus full SHALL be labelled for all
structural previews, including small offline labs. Full loading remains explicit
and limited to the existing heavy-focus affordance; a sample is not full-input proof.
