# Spec: heavy-preview-sample

Capability contract for [ADR-0041](../../../docs/adr/0041-heavy-preview-sample.md).

## Requirements

### Requirement: Heaviness follows map size, not lab query ids

A focus SHALL be treated as heavy only when it needs a seed KeyMap whose `entries` length is at least 5000. Specific query ids from Help labs SHALL NOT by themselves mark a focus heavy.

#### Scenario: Large ApplyKeyMap is heavy
- **GIVEN** the focused query Applies a seed map with 8000 entries
- **WHEN** heaviness is evaluated
- **THEN** the focus is heavy

#### Scenario: Lab id alone is not heavy
- **GIVEN** a focus id used by a Mapping-quality lab pack
- **AND** that focus does not need a seed map with ≥ 5000 entries
- **WHEN** heaviness is evaluated
- **THEN** the focus is not heavy for that reason

### Requirement: Auto-preview always loads a sample

Selecting a graph focus SHALL run structural DuckDB preview with the sample output row LIMIT (50), including when the focus is heavy. The Data panel SHALL show the returned rows (or an error / cancel), not an empty “skipped heavy preview” placeholder.

#### Scenario: Heavy focus shows sample rows
- **GIVEN** a heavy ApplyKeyMap focus
- **WHEN** the user selects that node
- **THEN** preview runs with `LIMIT 50`
- **AND** the Data grid shows the sample (after the host returns)

### Requirement: Full preview is on demand for heavy focuses

When the current focus is heavy, the Data chrome SHALL offer an explicit control to load a full preview (no output row LIMIT). The UI SHALL label whether the visible grid is a sample or a full preview. Full preview SHALL NOT replace auto-sample as the default for a newly selected focus.

#### Scenario: Load full
- **GIVEN** a heavy focus whose sample preview is shown
- **WHEN** the user activates Load full
- **THEN** preview runs without an output row LIMIT
- **AND** the chrome indicates a full preview

### Requirement: Help lab preview uses the same policy

A Mapping-quality (or other) Help lab project SHALL use the same heaviness and sample/full preview rules as any user project. Preview policy SHALL NOT branch on lab-only query id allowlists.
