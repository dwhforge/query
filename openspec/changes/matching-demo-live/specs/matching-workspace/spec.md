## ADDED Requirements

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
