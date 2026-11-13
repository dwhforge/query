# Spec Delta: execution-lifecycle

## ADDED Requirements

### Requirement: Single host DuckDB session

The host process SHALL own one DuckDB session for preview/analysis. Concurrent heavy work SHALL be serialized through the heavy worker with lane-specific supersede rules.

#### Scenario: Newer preview supersedes
- **GIVEN** a preview is queued or running
- **WHEN** a newer preview is enqueued
- **THEN** the older pending waiter receives a cancelled error
- **AND** the running DuckDB query may be interrupted

### Requirement: Stale IPC results are not applied

The UI SHALL track a generation (or equivalent) per preview/check surface and SHALL ignore host replies that do not match the latest generation.

#### Scenario: Late preview
- **GIVEN** the user triggered preview A then preview B
- **WHEN** reply for A arrives after B was requested
- **THEN** the UI does not replace the B result with A

## Preview confidence (PR-04)

Merged from [execution-confidence](../../changes/execution-confidence/proposal.md),
implementing ADR-0031 and ADR-0041 without changing host ownership.

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
