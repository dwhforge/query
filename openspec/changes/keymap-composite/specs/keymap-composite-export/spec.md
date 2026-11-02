# Spec Delta: keymap-composite-export

## ADDED Requirements

### Requirement: Seed CSV header matches from_columns

Export SHALL write `seeds/map_<id>.csv` with header = `from_columns` followed by `to_column`. Arity 1 with defaults remains `from,to`.

#### Scenario: Composite seed written
- **GIVEN** KeyMap `from_columns: ["ext_offer_id","as_of_day"]`, `to_column: "offer_sk"`
- **WHEN** dbt export runs
- **THEN** the seed header is `ext_offer_id,as_of_day,offer_sk`

### Requirement: Seed sync parses composite header

Sync from export tree SHALL parse composite headers into `from_parts` and refresh ApplyKeyMap snapshots.

#### Scenario: Re-open after hand-edit
- **GIVEN** a composite seed file edited in git
- **WHEN** seed→KeyMap sync runs
- **THEN** editor entries reflect the file tuples

### Requirement: Source upsert by From tuple

For `storage=source` with arity N, Save SHALL upsert/delete by equality on all From columns (not a single From).

#### Scenario: Two rows same ext_id different day
- **GIVEN** arity-2 source map
- **WHEN** both rows are saved
- **THEN** both persist as distinct tuples
