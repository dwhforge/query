# Spec Delta: step-schema

## Purpose

Derived per-step column schemas drive portable SQL emit so preview (DuckDB) and dbt export (including Postgres) share BY-NAME semantics without relying on stale physical relations after Rename/Select.

## ADDED Requirements

### Requirement: Schema is derived, not editable state

The system SHALL derive each step’s result column names from the Workspace AST and Load* metadata seeds. Schema SHALL NOT be stored as a separately user-edited document.

#### Scenario: Inference from seeds and steps
- **WHEN** a workspace is compiled with Load* seeds for source queries
- **THEN** downstream FromQuery / Rename / Select / Derive / Append / Join update schema by explicit rules
- **AND** GroupBy, CustomSql, and SqlModel without describe yield unknown schema

### Requirement: Explicit names required for propagation

Schema propagation SHALL require explicit output names. Steps whose outputs are raw expressions without known aliases SHALL produce an unknown schema.

#### Scenario: GroupBy without aliases
- **GIVEN** a prior known schema
- **WHEN** a GroupBy step uses aggregate expressions without guaranteed aliases
- **THEN** the result schema after that step is unknown

### Requirement: Export collects Load* seeds

On export (and when previewing dbt SQL with schema-aware emit), the system SHALL collect column-name seeds for each Load* query from live metadata (Postgres describe and/or DuckDB file describe) when credentials/paths allow.

#### Scenario: Postgres Load seed
- **GIVEN** a query whose first step is LoadPostgres with a resolvable connection
- **WHEN** the user exports dbt
- **THEN** that query’s seed columns match `information_schema` / describe order
- **AND** those seeds are used for workspace schema inference during emit

#### Scenario: File Load seed
- **GIVEN** a query whose first step is LoadCsv or LoadParquet with a readable path
- **WHEN** the user exports dbt
- **THEN** seed column names come from a DuckDB describe of that file

### Requirement: Portable emit when schema is known

When the previous step schema and Append right-query schemas are known, Postgres (and portable) Append/Rename SHALL emit explicit column-aligned SQL (NULL fillers, actual source spellings under ASCII fold). The system SHALL NOT use positional `UNION ALL` for Append.

#### Scenario: Rename then Append with seeds
- **GIVEN** seeds for left and right source queries
- **WHEN** a consumer does FromQuery → RenameColumn → Append(right)
- **THEN** export SQL contains an explicit rename projection and name-aligned UNION
- **AND** export does not depend on jinja `get_columns_in_relation` for that Append

#### Scenario: Unknown schema after Rename without seeds
- **GIVEN** no Load* seeds and no left physical relation after Rename
- **WHEN** Append is emitted for Postgres
- **THEN** the system fails with a clear error rather than positional UNION ALL

### Requirement: ASCII fold and ambiguity

Column matching SHALL use ASCII A–Z case-folding only. Within one relation, colliding fold keys (exact duplicate or Amount/amount) SHALL fail loudly.

#### Scenario: Non-ASCII distinct
- **WHEN** columns `Имя` and `имя` appear across Append inputs
- **THEN** they remain two distinct result columns
