# ADR-0008: PostgreSQL support is mandatory

## Status

Accepted (2026-10-24)

## Context

Sources today include CSV, Parquet, and Postgres. Treating Postgres as “best-effort / later” would undermine the dbt-help and multi-source goals: real warehouses and OLTP mirrors are usually Postgres (or Postgres-compatible).

## Decision

1. **PostgreSQL is a required first-class source** from v1 — same tier as CSV, not optional.  
2. AST step `LoadPostgres { connection_string, table_name }` stays in the canonical contract.  
3. Runtime preview: DuckDB `postgres` scanner (extension) must be **installed/loaded successfully** for the Postgres path; failure is a **hard, actionable error** when the user runs a workspace that includes `LoadPostgres` (not a silent skip).  
4. Startup may still attempt eager `INSTALL/LOAD postgres`; if that fails, CSV/Parquet work can continue, but any preview/export that touches `LoadPostgres` must fail with “Postgres extension unavailable: …”.  
5. dbt export: `LoadPostgres` → `source('postgres_raw', …)` + `sources.yml` (+ `profiles.yml.example` notes for Postgres target where relevant).  
6. UI: “Add Postgres query” is a v1 surface (connection + table), not hidden behind CustomSql.  
7. DoD includes a Postgres fixture path (local Postgres or documented docker) in addition to CSV join.

## Consequences

- Docs/DoD no longer list Postgres as “best-effort only”.  
- Spatial may remain best-effort; **postgres may not**.  
- Security: never log connection strings; prefer secret storage later.  
- CI/smoke should cover `LoadPostgres` when a Postgres service is available.
