# Spec: keymap-multi-output-adapters (delta)

Change: [`keymap-multi-output`](../../). ADR: [0037](../../../../docs/adr/0037-keymap-multi-output.md).

## ADDED Requirements

### Requirement: Seed multi-output
Seed maps SHALL edit every output, round-trip through the project document, and use CSV header `from_columns…, output_columns…, stewardship…`. A legacy header cell `to` SHALL mean the single output name. Sync and push SHALL match columns by header name, not by position alone.

#### Scenario: Seed CSV round-trip
- **WHEN** a seed map with outputs `product_id` and `variant_code` is exported and synced back
- **THEN** both output columns and values are restored
- **AND** attrs / range columns remain stewardship columns after the outputs

### Requirement: Source multi-output write-back
Source maps SHALL bind several existing columns without creating them in the database. Dirty baselines SHALL freeze every participating output (`KeyMapDirtyBaseline.outputs`). Save SHALL compare all of those outputs plus editable attrs under the existing advisory lock. Changing the output **set** with unsaved row edits SHALL refuse or require explicit discard; Cancel SHALL leave prior binding, baselines, delta, and edits unchanged. With no dirty edits, the change MAY drop tokens and re-read. Reorder of the same names SHALL NOT re-read. While Save is in flight, output set and bindings of that map SHALL NOT change. Rename of an Apply destination SHALL NOT drop source dirty state. Query-backed range SCD remains forbidden; multi-output does not lift that ban.

#### Scenario: Dirty discard Cancel
- **GIVEN** a dirty source row edit
- **WHEN** the user changes the output set and Cancels the discard prompt (or the change is refused)
- **THEN** the row edits remain
- **AND** the previous output binding remains

#### Scenario: Concurrent output change refuses Save
- **GIVEN** a baseline that froze `product_id` and `variant_code`
- **WHEN** another session changed `variant_code` in Postgres before Save
- **THEN** Save is refused

### Requirement: Query multi-output
Query-backed maps SHALL choose outputs from the map query schema, keep a read-only grid, Refresh, and jump-to-query. Apply SHALL join the live relation (preview CTE / export `ref` of the exported model). Dependency edges, cycle detection, and query revision helpers from [ADR-0036](../../../../docs/adr/0036-query-backed-keymap.md) SHALL remain. Computed rows SHALL NOT be copied into `entries` or Apply snapshots. UI sample LIMIT SHALL NOT bound Apply or validation. Every declared output SHALL be covered by the ready NULL / uniqueness rules.

#### Scenario: Preview sample does not bound Apply
- **GIVEN** a query-backed multi-output map whose grid shows a limited sample
- **WHEN** Apply runs on a From key present only beyond the sample
- **THEN** the correspondence still participates

### Requirement: Ref multi-output
Ref maps SHALL project several model columns in exported Apply SQL. Existing preview limitations remain; unreadable external models are unvalidated. This change SHALL NOT execute an external dbt model. Lens SHALL NOT offer write-into-ref. Query, ref, and source maps SHALL NOT receive a seed copy.

#### Scenario: Export uses model columns
- **WHEN** a ref-backed multi-output map is exported
- **THEN** Apply joins `ref(model)` and selects each bound output column
- **AND** no `seeds/map_*.csv` is written for that map

### Requirement: Export tests are additional
Export SHALL emit `not_null` on each From and output column and `unique_combination_of_columns` on From for static maps. Those YAML tests SHALL NOT replace the execution-path uniqueness guard. No `ALTER TABLE` uniqueness is required when binding source columns.
