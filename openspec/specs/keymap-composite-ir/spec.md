# Spec: keymap-composite-ir

## Requirements

### Requirement: KeyMap From arity N

The system SHALL represent KeyMap From as an ordered list `from_columns` (length ≥ 1) and each entry as `from_parts` of the same length. Legacy `from_column` / `from` SHALL soft-migrate to length-1 lists.

#### Scenario: Legacy single-column project loads
- **GIVEN** a KeyMap with only `from_column: "from"` and entries `{ from, to }`
- **WHEN** the project is loaded
- **THEN** effective `from_columns` is `["from"]` and each entry has `from_parts: [from]`

#### Scenario: Duplicate tuple rejected
- **GIVEN** a KeyMap with `from_columns: ["ext_id", "day"]`
- **WHEN** two entries share the same trimmed `(from_parts[0], from_parts[1])`
- **THEN** validation fails

#### Scenario: Single-column duplicate still rejected
- **GIVEN** arity 1
- **WHEN** two entries share the same trimmed from
- **THEN** validation fails as today

### Requirement: ApplyKeyMap multi-column join

`ApplyKeyMap` SHALL accept `columns` (length = map arity) and remap by joining all From equalities, writing `COALESCE(map.to, original)` into `output_column` (default first of `columns`).

#### Scenario: Composite Apply in DuckDB preview
- **GIVEN** map arity 2 and ApplyKeyMap columns `[ext_offer_id, day]`
- **WHEN** preview SQL is emitted
- **THEN** the join ON includes both columns and the output overwrites the configured output column with COALESCE to

#### Scenario: Legacy ApplyKeyMap column field
- **GIVEN** ApplyKeyMap with only `column: "sku"`
- **WHEN** emitted
- **THEN** behavior matches arity-1 Apply as before
