# Spec: query-backed-keymap

ADR: [0036](../../../docs/adr/0036-query-backed-keymap.md).

## Requirements

### Requirement: Query storage is a KeyMap SoT
The product SHALL support `KeyMapStorage` kind `query` referencing a local workspace query by id. Computed correspondence rows SHALL NOT be persisted as KeyMap `entries`, seed CSV, or ApplyKeyMap step snapshots.

#### Scenario: Binding survives save
- **WHEN** the user saves and reopens a project with a query-backed map
- **THEN** `query_id` and From/To column binding are restored
- **AND** `entries` are empty

### Requirement: format_version 2 gate
Projects that may contain query-backed maps SHALL use `format_version` 2. Older apps SHALL refuse newer documents. Migrating v1→v2 SHALL NOT rewrite map rows (stamp only).

#### Scenario: Old app refuses v2
- **WHEN** an app supporting only format_version ≤ 1 loads a v2 project
- **THEN** load fails with an unsupported-format error

### Requirement: Apply uses the live query relation
ApplyKeyMap on a query-backed map SHALL join the current result of that query. Preview row LIMIT SHALL NOT truncate the correspondence set used at Apply.

#### Scenario: Apply beyond preview page
- **GIVEN** a query-backed map whose preview shows fewer rows than the full query
- **WHEN** ApplyKeyMap runs on a consumer query
- **THEN** all valid From→To pairs from the map query participate in the join

### Requirement: Cycles through maps are refused
The dependency graph SHALL include consumer → map → map query → upstream. Applying a map inside its own source query (directly or indirectly) SHALL fail with a readable dependency chain.

#### Scenario: Direct cycle blocked
- **WHEN** the map’s `query_id` itself contains ApplyKeyMap for that map
- **THEN** preview/export of that path fails with a cycle error naming the chain

### Requirement: Full-set correspondence validation
Before treating a query-backed map as valid, the product SHALL validate the entire correspondence set: no NULL From part, no NULL To, no duplicate From tuple. Implicit trim/case normalization SHALL NOT be applied by this validation.

#### Scenario: Duplicate From fails
- **WHEN** the map query returns two rows with the same From tuple
- **THEN** the map is invalid even if To values match
- **AND** Apply and export of the affected path are blocked

### Requirement: dbt export without seed
Export SHALL emit the map query (and required upstream) as normal models, reference them via `ref()` from Apply, omit seed CSV for that map, and emit dbt data tests that enforce the NULL/uniqueness rules.

#### Scenario: Export buildable
- **WHEN** the user exports a project using a query-backed map
- **THEN** no `seeds/map_*.csv` is written for that map
- **AND** the Apply model joins `ref` of the exported map-query model
- **AND** schema tests cover not_null and uniqueness of From
