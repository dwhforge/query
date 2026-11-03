# Spec: mapping-quality-overview

## ADDED Requirements

### Requirement: Offline moderate-scale Help lab
Help SHALL expose a mapping-quality lab with 100000 source positions, 2400 catalog products and 95000 seed links. Generation SHALL be deterministic and require no external services. Incomplete cached generations SHALL fail explicitly.

#### Scenario: First load
- **WHEN** the lab is selected in Help
- **THEN** CSV inputs are generated locally and a real DWHQ mapping workspace opens with DuckDB execution
- **AND** the overview opens in its own workspace tab

### Requirement: Global observations, not coverage-only verdicts
The overview SHALL display family/grade correspondence, declared decision basis and target concentration. It SHALL distinguish observations from correctness assertions and label synthetic scores as annotations.

#### Scenario: Fully mapped but inconsistent region
- **GIVEN** accepted links crossing family/grade boundaries
- **WHEN** the user explores the matrix
- **THEN** those links remain observable despite high catalog coverage

### Requirement: Aggregates retain full-input scope
Projection SQL SHALL aggregate the complete input. The UI SHALL reject truncated/incomplete aggregate results using a reported window total. Target lists and sample keys SHALL be bounded.

#### Scenario: Aggregate preview is truncated
- **WHEN** visible aggregate counts do not sum to the reported total
- **THEN** the UI displays an error rather than presenting a partial matrix as global

### Requirement: Explicit local drill-down
Selecting a cell or target SHALL expose actual sample keys. Inspect SHALL upsert a single ephemeral ordinary query filtered to at most 24 unique keys and open its Join in the existing Lens without modifying the original Join. The ephemeral query SHALL be visually marked as temporary and omitted from Save / dbt Export.

#### Scenario: Inspect a matrix region
- **WHEN** Inspect samples is chosen
- **THEN** the sample query uses exact keys from that aggregate
- **AND** a later Inspect replaces the same ephemeral query instead of adding another canvas node
- **AND** the UI clearly distinguishes sample investigation from full-data coverage

#### Scenario: Persist project while Inspect is open
- **WHEN** the project is saved or exported
- **THEN** the ephemeral Inspect query is not written to the project file or dbt export
