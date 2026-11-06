# Import PostgreSQL relations into the project

## Why

Mapping tables already exist in PostgreSQL. Users need to bring selected tables and views into the open project as live queries and source-backed KeyMaps, then inspect a Join in Join Lens, without copying rows or inventing a second connection model.

## In scope

- Entry next to a Postgres connection: import selected schemas/relations into the current project
- Literal prefix candidates `map_` and `_map_`, editable and schema-limited, plus explicit include/exclude
- Confirmed source-backed KeyMap (composite From, multi-output, attrs, static or range SCD)
- Read-only view / materialized view queries; no write-back and no automatic refresh
- Optional confirmed working query that opens Join Lens
- Rescan, metadata diff, broken bindings, one project fold (stale / cancel / double-confirm)
- `format_version` 4 stamp for `pg_import` provenance

## Out of scope

- Save as Seed, snapshots, offline row copies
- dbt migration or export of the import itself
- DDL, new tables/columns/constraints, writing comments, altering views
- Automatic joins from foreign keys or similar names
- Decomposing a view into visual steps
- MappingCheck created by the import

## ADR

[ADR-0040](../../../docs/adr/0040-postgres-schema-import.md)
