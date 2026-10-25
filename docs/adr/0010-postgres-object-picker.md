# ADR-0010: Postgres object picker (schema-qualified)

## Status

Accepted (2026-10-24)

## Context

v1 UI collected a free-typed table name plus connection string and always scanned `public` ([ADR-0008](0008-postgres-required.md)). That is a surrogate: wrong schema, typos, no discovery of views — unacceptable for DBA/DE trust.

## Decision

1. **`LoadPostgres` includes `schema`** (default `"public"` for backward-compatible JSON).  
2. Preview: `ATTACH … (TYPE postgres)` then `SELECT * FROM alias."schema"."table"` (DuckDB 2.0+; not `postgres_scan`).  
3. UI **must** browse the live catalog and **select** a relation — not invent the name by typing alone.  
4. Backend command `list_postgres_objects(connection_string)` uses DuckDB `postgres_query` + `pg_catalog` (tables, partitioned tables, views, matviews, foreign tables).  
5. Optional `test_postgres_connection` for a cheap `SELECT 1`.  
6. dbt export: source table id = `{schema}__{table}` with YAML `schema` + `identifier`.  
7. Connection strings are not logged; errors redact the DSN / userinfo when echoed.

## Consequences

- Postgres add-flow is a modal picker (connect → filter schema → pick object → Add).  
- Free-typed table-only bar is removed.  
- Multi-schema databases work without CustomSql.
