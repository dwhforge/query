# ADR-0014: Query execution affinity + execution engine vs destination

## Status

Accepted (2026-10-25); **amended 2026-10-29** — split `target_dialect` into `execution_engine` + `destination`.

## Context

We follow a Power Query *mental model* (multi-query, Applied Steps) for strong DEs who ship dbt — not analyst-only M. Preview today always runs through DuckDB. Free SQL and warehouse-native steps need an honest place to run without pretending DuckDB is every dialect.

Product routes require **engine ≠ destination**:

| Route | execution_engine | destination |
|-------|------------------|---------------|
| PostgreSQL → PostgreSQL | postgres | postgres |
| Files/S3 → DuckDB | duckdb | duckdb |
| Files/S3 → PostgreSQL | duckdb | postgres (ATTACH) |
| DuckDB → PostgreSQL | duckdb | postgres |

Legacy `Project.target_dialect` conflated emit dialect and materialization target; file+postgres then wrongly demanded landing.

## Decision

### 1. Project execution engine + destination

- `execution_engine`: `duckdb` | `postgres` — SQL dialect for emit, Derive ops, free SQL honesty.
- `destination`: `{ kind, connection_id?, duckdb_path? }` — where dbt materializes published outputs.
- `dbt_target` / `dbt_runtime`: dbt Core line (v1/v2), not warehouse.
- Soft migration: old `target_dialect=postgres` → engine=postgres, destination=postgres (+ `target_connection_id`); duckdb likewise. Writers keep `target_dialect` in sync with engine for older readers.

Source DB type may differ from engine/destination — normal ([ADR-0015](0015-sources-vs-target-extensibility.md)).

### 2. Query execution affinity (one Query → one engine)

`QueryDef.execution`: `local` | `target` (default `local`). Affinity is per Query node; it does **not** spread to downstream Queries.

| Value | Meaning |
|-------|---------|
| `local` | Preview = DuckDB (federation OK). |
| `target` | SQL/dialect honesty for **execution_engine** (not destination). DuckDB→PG still authors DuckDB SQL. |

### 3. Preview policy

**Structural** preview in-process via DuckDB for IR / multi-source. Ready-made Derive ops may emit a DuckDB twin for local preview when engine=postgres.

Arbitrary PostgreSQL SQL: do **not** greenwash DuckDB preview as PG validation — label “not verified locally” or run on warehouse when available.

### 4. Validation

`execution=target` + `execution_engine=postgres` rejects LoadCsv / remote Parquet / LoadDuckdb without landing.

File/S3 sources require `execution_engine=duckdb`. Destination may still be postgres (ATTACH route).

### 5. Free SQL / Derive

`SqlModel` / `CustomSql` / Derive SQL mode are authored for `execution_engine`. Structured Derive ops regenerate dual-dialect SQL; editing as SQL freezes text and does not reverse-parse.

### 6. Export

Emit SQL for `execution_engine`. Profiles:

- engine=postgres → `type: postgres`
- engine=duckdb, dest=duckdb → `local.duckdb`
- engine=duckdb, dest=postgres → dbt-duckdb + ATTACH (`DWH_PG_DSN`)

## Consequences

- UI shows execution engine and destination separately (route badge `duckdb→postgres`).
- Structured emitters avoid DuckDB-only syntax when engine is postgres.
- Landing is required only for postgres **engine** + file/S3 — not for duckdb engine → postgres destination.
