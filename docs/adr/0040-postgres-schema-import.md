# ADR-0040 — Import PostgreSQL relations into the project

## Status

**Accepted** (2026-11-06). OpenSpec: [`openspec/changes/postgres-schema-import/`](../../openspec/changes/postgres-schema-import/).

## Context

Mapping tables already live in PostgreSQL. [ADR-0010](0010-postgres-object-picker.md) can attach one relation as a query. [ADR-0022](0022-keymap-postgres-live-bind.md) can bind one source KeyMap by hand. Neither path discovers `map_` / `_map_` relations, restores composite From and multi-output bindings, nor keeps a durable import identity across rescan.

The warehouse stays the system of record for rows ([ADR-0033](0033-mapping-data-plane.md)). The project stores definitions, bindings, and provenance.

## Decision

1. **One import operation, one connection.** The user picks a Postgres connection and explicit relations. The product does not import the whole database and does not invent Joins from foreign keys or column names.
2. **Reuse Source, Query, and KeyMap.** Each selected relation becomes a `Source` plus a live `LoadPostgres` query with no invented transforms. A confirmed mapping also becomes one `storage=source` KeyMap on that same relation. Query and Mapping are two views of one relation, not two row sets.
3. **Name rule is only a candidate.** Literal prefixes `map_` and `_map_` (underscore is not a wildcard), limited to chosen schemas. Priority: saved user decision (`force` / `exclude`) → prefix rule → ordinary relation. Exclude survives rescan. The name does not assign From, outputs, temporal mode, or write-back.
4. **Confirm the binding or leave a query.** Service PK `id` is not auto-assigned as From. From order is kept. Outputs, attrs, and temporal columns stay disjoint. Missing or ambiguous columns block a ready map. The relation can still be imported as a query, or an existing map can stay visible as broken. Data-quality notes (NULL, duplicate From, overlapping ranges) are separate and do not bypass Apply guards ([ADR-0037](0037-keymap-multi-output.md), [ADR-0038](0038-keymap-apply-operation.md)).
5. **Views and materialized views** import as read-only queries. A mapping on them does not offer write-back. An unavailable view definition is unavailable, not an empty script. No `REFRESH`. No guessed base table.
6. **Write-back is explicit** and only for tables after privilege, column, and uniqueness checks. Static identity is the From tuple. Range SCD identity is From + `valid_from`. Save stays on the existing paged delta path. Storage is not switched and the table is not replaced.
7. **Provenance** is `(connection_id, schema, name)` plus kind, a diagnostic catalog oid, and a schema fingerprint. Oid is not the durable key. Rescan does not fuzzy-match a rename. Secrets are not stored on the import record.
8. **Plan, review, commit.** The wizard holds a session draft. Commit checks a project fingerprint and fresh catalog metadata, then applies one fold. Stale plan, in-flight Save, and unconfirmed dirty edits refuse. A repeated commit token does not duplicate objects. Cancel commits nothing. Project save to disk stays the existing command.
9. **Working analysis query is a separate confirmed step** (left query, map, bindings, optional Join). It opens the existing Join Lens. It does not create a MappingCheck.
10. **`format_version` 4** ([ADR-0030](0030-project-format-version.md)). `pg_import` is optional metadata. `migrate_v3_to_v4` is a stamp so older apps refuse the file instead of dropping provenance on save.

## Consequences

- Amends ADR-0030 current version from 3 to 4.
- Does not add Seed snapshots, dbt migration, DDL, or row copies.
- OpenSpec change: [`openspec/changes/postgres-schema-import/`](../../openspec/changes/postgres-schema-import/).

## References

- [ADR-0010](0010-postgres-object-picker.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0024](0024-keymap-composite.md), [ADR-0028](0028-keymap-stewardship-shapes.md), [ADR-0030](0030-project-format-version.md), [ADR-0033](0033-mapping-data-plane.md), [ADR-0037](0037-keymap-multi-output.md), [ADR-0038](0038-keymap-apply-operation.md)
