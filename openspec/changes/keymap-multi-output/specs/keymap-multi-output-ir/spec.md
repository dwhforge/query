# Spec: keymap-multi-output-ir (delta)

Change: [`keymap-multi-output`](../../). ADR: [0037](../../../../docs/adr/0037-keymap-multi-output.md).

## ADDED Requirements

### Requirement: Canonical multi-output fields
The product SHALL represent map outputs as ordered `KeyMapDef.output_columns`, row values as `KeyMapEntry.output_values` index-aligned to that list, and Apply destinations as `ApplyKeyMap.output_bindings` of `{ map_column, destination_column }` with length ≥ 1. Writers SHALL omit legacy `to`, `to_column`, and `output_column`. Rust SHALL remain the source of the shared contract; TypeScript for these shapes SHALL be generated.

#### Scenario: Single-output canonical form
- **WHEN** a map has one output named `product_id`
- **THEN** `output_columns` is `["product_id"]`
- **AND** each entry's `output_values` has length 1
- **AND** each Apply step uses one binding whose `map_column` is `product_id`

#### Scenario: Name uniqueness
- **WHEN** an output column name case-insensitively equals a From, range, or editable column name
- **THEN** validation refuses the map

### Requirement: Textual output values
`output_values` SHALL keep textual mapping-value semantics. This change SHALL NOT introduce typed numeric, date, or boolean outputs. Preview and dbt SHALL apply the same casts. Range bounds and event-time columns remain stewardship/temporal fields, not outputs.

#### Scenario: Whitespace is a value
- **WHEN** an output cell is the string `" "` (spaces only)
- **THEN** validation treats it as a non-blank stored value
- **AND** does not trim it during ready-map checks

### Requirement: format_version 3 migration
Projects that may contain multi-output maps SHALL use `format_version` 3 after this change ships. `migrate_v2_to_v3` SHALL convert every serialized `KeyMapEntry`, including Apply snapshots. When both a legacy scalar and the new list are present, the scalar MUST agree with the first list element (`to`↔`output_values[0]`, `to_column`↔`output_columns[0]`, `output_column`↔ first binding `destination_column`, map single output ↔ first binding `map_column`); otherwise load SHALL refuse. An Apply whose `map_id` is absent from this document SHALL refuse without inventing `map_column`.

#### Scenario: Legacy single-To round-trip
- **GIVEN** a v2 project with `to_column: "to"` and entries with `to`
- **WHEN** the project is loaded
- **THEN** `format_version` becomes 3
- **AND** `output_columns` is `["to"]`
- **AND** writers no longer emit `to` / `to_column`

#### Scenario: Missing map on Apply refuses
- **GIVEN** an Apply step whose `map_id` is not present in the document
- **WHEN** `migrate_v2_to_v3` runs
- **THEN** load fails with a clear error
- **AND** no `map_column` is invented

### Requirement: Ready-map NULL rule
A ready map SHALL require every declared output to be present and non-NULL. Blank means NULL or `""` only. Incomplete values MAY exist only in an editor draft session; `KeyMapDef::validate` and project save SHALL refuse them. An Apply that binds a subset of outputs SHALL NOT narrow this check.

#### Scenario: Empty output refuses save
- **WHEN** a seed entry has `output_values` containing `""`
- **THEN** project save fails validation

### Requirement: Cardinality errors
For a static map, a duplicate From tuple SHALL be an error. For range SCD, overlapping intervals for the same From tuple SHALL be an error; the same From in non-overlapping periods SHALL be valid. The product SHALL NOT pick the first row among duplicates.

#### Scenario: Non-overlapping SCD versions allowed
- **GIVEN** one From with `[2020-01-01, 2021-01-01)` and `[2021-01-01, NULL)`
- **THEN** the map validates
- **AND** at a given event time at most one version matches
