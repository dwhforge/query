# Spec Delta: key-map-ir

## Purpose

Join-key remapping and deterministic key cleanup are first-class Workspace IR steps with portable preview and dbt emit.

## ADDED Requirements

### Requirement: KeyMap resource on Workspace

The system SHALL store named KeyMaps on `Workspace.key_maps` with unique `from` values (after trim) and non-empty `to`.

#### Scenario: Duplicate from rejected
- **WHEN** a KeyMap is validated with two entries sharing the same trimmed `from`
- **THEN** validation fails with an error naming the duplicate

### Requirement: NormalizeKey overwrites in place

`NormalizeKey` SHALL apply an ordered list of ops to named columns and overwrite those columns (same names) for downstream steps including Join.

#### Scenario: Trim then lower
- **GIVEN** a prior step with column `region`
- **WHEN** NormalizeKey columns=`[region]` ops=`[trim, lower]` is emitted for DuckDB
- **THEN** SQL nests the ops and projects `region` via overwrite (EXCLUDE or explicit list)

### Requirement: ApplyKeyMap remaps via map rows

`ApplyKeyMap` SHALL replace column values with `to` when `from` matches, else keep the original value (COALESCE).

#### Scenario: Preview VALUES join
- **GIVEN** entries `web→online`
- **WHEN** ApplyKeyMap is emitted for DuckDB preview
- **THEN** SQL LEFT JOINs a VALUES list and COALESCE’s the mapped `to`

#### Scenario: dbt seed ref
- **GIVEN** the same ApplyKeyMap during dbt export
- **THEN** SQL LEFT JOINs `{{ ref('map_<id>') }}` instead of inline VALUES
