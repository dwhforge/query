# ADR-0036 — Query-backed KeyMap (computed correspondence SoT)

## Status

**Accepted** (2026-11-05). OpenSpec: [`openspec/changes/query-backed-keymap/`](../../openspec/changes/query-backed-keymap/).

## Context

[ADR-0020](0020-join-key-mapping.md) binds maps as **seed** / **ref** / **source**. Users also need correspondences that are **computed in the workspace** (SQL/pipeline query) without copying rows into `entries`, seed CSV, or step snapshots. That is distinct from [ADR-0034](0034-keymap-authoring-context.md) authoring context (source/target queries for *create* intent only).

[ADR-0033](0033-mapping-data-plane.md) already refuses warehouse row bodies in the project document — query-backed maps stay empty of `entries` for the same reason.

## Decision

1. **`KeyMapStorage::Query { query_id }`** — local workspace query id is the SoT relation. From/To (and composite From order) live on `KeyMapDef` as today; they name columns on that query’s result.
2. **Static maps only** in the first slice: no attrs / range SCD / external project queries as the map relation.
3. **ApplyKeyMap** LEFT JOINs the live query result (preview CTE / export `ref()` of the exported model). Never materialize query rows into `entries`, seeds, or Apply snapshots.
4. **Dependency edge:** consumer query → KeyMap → map `query_id` → its upstream. Cycles (direct Apply inside the map query, or indirect via other queries/maps) are refused with a readable chain.
5. **Validation (full set):** NULL in any From part or To → error; duplicate From tuple → error (even same To); no “first row wins”; no implicit trim/case. UI sample LIMIT does not bound Apply or validation.
6. **Editor:** read-only row grid; Refresh; jump to map query. Settings may change binding; Save does not write rows into the query.
7. **dbt:** export map query (+ upstream) even if not a published output; no seed CSV for that map; Apply uses `ref(<exported model>)`; emit not_null / unique (or unique_combination_of_columns) tests matching validation. External `storage=ref` stays a separate variant.
8. **`format_version` → 2** ([ADR-0030](0030-project-format-version.md)): tagged storage enum is not additive for old clients. Migration `v1→v2` is a **stamp only** (no row transform).

## Consequences

- Amend ADR-0020 bind list: seed | ref | source | **query**.
- `keyMapRevision` / MappingCheck fingerprints for query maps use query definition (+ upstream), not `entries`.
- Batch remap / write-back / fuzzy accept into rows: out of scope (read-only SoT).
- OpenSpec change must merge into `openspec/specs/query-backed-keymap/` when done.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0024](0024-keymap-composite.md), [ADR-0030](0030-project-format-version.md), [ADR-0033](0033-mapping-data-plane.md), [ADR-0034](0034-keymap-authoring-context.md)
