# Design — PostgreSQL schema import

## Models

No new Connection, Query, or KeyMap types. The fold creates:

- `SourceDef` (`kind=postgres`, `connection_id`, schema, table, no DSN)
- `QueryDef` whose only step is `LoadPostgres`
- `KeyMapDef` with `KeyMapStorage::Source` when the user confirms a binding

Provenance lives on `Project.pg_import` (`PgImportRegistry`): prefixes, rule schemas, per-relation identity, fingerprint, decisions, binding status, quality notes, write-back flag, view definition. Match key is connection id + schema + relation name. `catalog_oid` is diagnostic only.

## Fold

`commit_pg_import` is pure. It refuses a stale `expected_fingerprint`, a Save in flight, and dirty binding edits without `discard_confirmed`. The same `commit_token` is a no-op. Relations the plan does not mention are left in place. Missing columns do not fuzzy-rename a binding.

The host re-reads catalog metadata (no row bodies) and refuses when the plan's fingerprint, kind, oid, or view definition no longer matches.

## Catalog

Scan SQL is `SELECT` against `pg_catalog` / `information_schema` plus per-view `pg_get_viewdef`. A failure to read a definition is `view_definition_available=false`, not `""`. Diagnosis of NULL / duplicate / overlap is a separate aggregate, stored as notes, and is not a copy of rows. No `REFRESH`, DDL, or DML.

## UI

Session draft until commit. Review lists creates, reuses, bindings, read-only vs write-back, the optional analysis query, and states that PostgreSQL is unchanged. After a working Join is committed, the app selects that Join step and mounts the existing Join Lens.

## Compatibility

`PROJECT_FORMAT_VERSION = 4`. v3→v4 stamps the version and does not rewrite rows. Older apps refuse the file.
