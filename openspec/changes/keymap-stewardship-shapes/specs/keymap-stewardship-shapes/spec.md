# Spec Delta: keymap-stewardship-shapes

## ADDED Requirements

### Requirement: Optional attributes on every KeyMap path

The system SHALL allow authors to add zero or more attribute columns (e.g. reason, confidence, notes) on seed, source, and ref KeyMaps. Creating a map without attributes SHALL remain valid. ApplyKeyMap and dbt join emission SHALL continue to use From→To only.

#### Scenario: Seed map with reason
- **GIVEN** a seed KeyMap with editable column `reason`
- **WHEN** the map is saved and exported
- **THEN** `seeds/map_*.csv` includes a `reason` column
- **AND** ApplyKeyMap SQL does not reference `reason` in the join predicate

#### Scenario: Attrs not required
- **GIVEN** a new seed KeyMap with only From and To
- **WHEN** the author saves without adding attributes
- **THEN** the save succeeds

### Requirement: Optional time mode

A KeyMap SHALL declare a time mode of `none`, `point_in_time` (effectivity in From via composite columns), or `range_scd` (configurable valid-from / valid-to columns). Default for new maps SHALL be `none`.

#### Scenario: Range SCD apply
- **GIVEN** a KeyMap in `range_scd` mode with `valid_from` / `valid_to`
- **WHEN** ApplyKeyMap runs against a fact timestamp column
- **THEN** the emitted join matches From equality and the timestamp against the validity range per the locked inclusive/exclusive policy
- **AND** overlapping ranges for the same From are rejected at edit/save time

#### Scenario: Default stays classic
- **GIVEN** a new KeyMap with time mode unset or `none`
- **WHEN** ApplyKeyMap is emitted
- **THEN** the join is equality on From only (ADR-0020 / ADR-0024 behavior)
