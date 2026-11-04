# Spec: query-based-mapping-create (delta)

Change: [`query-based-mapping-create`](../../). ADR: [0034](../../../../docs/adr/0034-keymap-authoring-context.md).

## ADDED Requirements

### Requirement: Optional authoring context without format bump

The system SHALL allow an optional typed `authoring_context` on `KeyMapDef` (`source_query_id`, ordered `source_columns[]`, `target_query_id`, `target_column`). Legacy maps without the field SHALL remain valid. Adding the field SHALL NOT bump project `format_version`.

#### Scenario: New map keeps context
- **GIVEN** a query-based create commit with chosen local queries/columns
- **WHEN** the KeyMap is upserted into the project
- **THEN** `authoring_context` matches the review plan
- **AND** `format_version` stays at the current project stamp

#### Scenario: Legacy absence
- **GIVEN** a KeyMap JSON without `authoring_context`
- **WHEN** the document is loaded
- **THEN** the map is accepted with `authoring_context` absent

### Requirement: Plan / validate / commit is all-or-nothing

Query-based create SHALL build a pure review plan, re-validate freshness at commit, and fold map upsert + optional last-Fields patches in one project update. On stale or error, the project document SHALL be left unchanged. Create SHALL NOT Apply, Join, Check, Lens, export, or write the warehouse / disk.

#### Scenario: Happy path seed map
- **GIVEN** two local workspace queries and valid key columns on output schemas
- **WHEN** the user confirms a valid plan
- **THEN** a seed KeyMap is added with empty entries and authoring context
- **AND** untouched queries keep identical steps

#### Scenario: Stale query refuses
- **GIVEN** a reviewed plan whose expected query step fingerprint no longer matches
- **WHEN** commit runs
- **THEN** the result is `stale`
- **AND** the project reference is unchanged

### Requirement: Last-Fields restore only

Optional column restore SHALL apply only when the query’s last step is `SelectColumns`, the column exists upstream, and it is missing from the projection. Restore is a planned patch appended into that last Fields list — not a new step.

#### Scenario: Restore blocked without Fields
- **GIVEN** a query whose last step is not SelectColumns
- **WHEN** restore is probed for a column
- **THEN** the probe fails with a clear error

### Requirement: Wizard handoff to existing editor

The UI SHALL offer a thin create wizard (keys → optional Fields → review). Cancel SHALL leave the project unchanged. On `applied`, the app SHALL open the existing KeyMap editor for the new map without warehouse Save.

#### Scenario: Explorer entry
- **GIVEN** a project with local queries
- **WHEN** the user chooses “Create from data” under Mappings
- **THEN** the wizard opens
- **AND** empty “New mapping” (+) still creates a blank seed map as before
