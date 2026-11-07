# Query-backed KeyMap

## Why

Correspondences often already exist as a workspace query. Users need that query as the KeyMap SoT — previewable, Applyable, and dbt-exported — without copying rows into seed/`entries`.

Not the same as ADR-0034 authoring context (create wizard source/target).

## In scope

- `KeyMapStorage::Query { query_id }` + `format_version` 2 (stamp migration)
- Column binding validation; full-set NULL/duplicate checks
- Read-only editor preview + Refresh; Apply via live relation
- Dependency / cycle detection through maps
- dbt: forced model include, no seed CSV, data tests
- Tests covering acceptance scenarios in the product plan

## Out of scope

- Write-back / edit query result rows
- Auto-compute map from two datasets
- External project query as map SoT
- Attrs / range SCD on query maps
- dbt 2 expansion; converting existing maps automatically
- Batch remap into query-backed maps

## ADR

[ADR-0036](../../../docs/adr/0036-query-backed-keymap.md)
