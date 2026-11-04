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
