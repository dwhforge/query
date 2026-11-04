# Spec: keymap-stewardship-shapes

Merged from [`openspec/changes/keymap-stewardship-shapes/`](../../changes/keymap-stewardship-shapes/). ADR: [0028](../../../docs/adr/0028-keymap-stewardship-shapes.md).

## Requirements

### Requirement: Optional attributes on every KeyMap path

The system SHALL allow authors to add zero or more attribute columns (e.g. reason, confidence, notes) on seed, source, and ref KeyMaps. Creating a map without attributes SHALL remain valid. ApplyKeyMap and dbt join emission SHALL continue to use From→To only (plus temporal predicate when range SCD).

#### Scenario: Seed map with reason
- **GIVEN** a seed KeyMap with editable column `reason`
- **WHEN** the map is saved and exported
- **THEN** `seeds/map_*.csv` includes a `reason` column
- **AND** ApplyKeyMap equality join does not reference `reason`

#### Scenario: Attrs not required
- **GIVEN** a new seed KeyMap with only From and To
- **WHEN** the author saves without adding attributes
- **THEN** the save succeeds

### Requirement: Optional time mode

A KeyMap SHALL declare a time mode of `none` (default) or `range_scd` (configurable valid-from / valid-to columns). Point-in-time effectivity uses composite From ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).

#### Scenario: Range SCD apply
- **GIVEN** a KeyMap in `range_scd` mode with `valid_from` / `valid_to`
- **WHEN** ApplyKeyMap runs with `as_of_column` set
- **THEN** the emitted join matches From equality and
  `event_time >= valid_from AND (valid_to IS NULL OR event_time < valid_to)`
- **AND** overlapping ranges for the same From are rejected at validate/save

#### Scenario: Default stays classic
- **GIVEN** a new KeyMap with time mode unset or `none`
- **WHEN** ApplyKeyMap is emitted
- **THEN** the join is equality on From only
