# ADR-0014: Query execution affinity + warehouse dialect

## Status

Accepted (2026-10-25)

## Context

We follow a Power Query *mental model* (multi-query, Applied Steps) for strong DEs who ship dbt — not analyst-only M. Preview today always runs through DuckDB. Free SQL and warehouse-native steps need an honest place to run without pretending DuckDB is every dialect.

Tension:

- Mid-chain `CustomSql` rewrites `{{prev_step}}` inside one CTE chain — it cannot own a separate DB connection.
- Source `connection_id` (`LoadPostgres`) ≠ warehouse where dbt models materialize.
- Cross-query Join after a warehouse-native query needs a local merge engine (DuckDB).

## Decision

### 1. Project warehouse target

`Project.target_dialect`: `duckdb` | `postgres` (export emit + default for `execution=target` preview).

Optional `Project.target_connection_id`: postgres Connection used when dialect is `postgres` (live target preview / profiles hint).

`dbt_target` remains **dbt version** (v1/v2), not warehouse dialect.

### 2. Query execution affinity (one Query → one engine)

`QueryDef.execution`: `local` | `target` (default `local`).

| Value | Preview |
|-------|---------|
| `local` | Entire step chain in DuckDB (federation OK). When project dialect is `duckdb`, this ≈ `dbt run` on DuckDB. |
| `target` | Entire step chain on project warehouse. All steps of **this** node only. |

- No mid-chain engine split inside one Query.
- Affinity does **not** spread to downstream Queries. A later Join-query may stay `local` (pull → DuckDB merge).
- Jump warehouse → DuckDB only at **Query boundaries** during preview.

### 3. Validation

`execution=target` is invalid if the chain needs what the warehouse cannot run without landing (e.g. `LoadCsv` / remote Parquet when dialect is `postgres`). Fail loud; no silent DuckDB fallback for target queries.

### 4. Free SQL

`SqlModel` / `CustomSql` inherit the Query’s engine. No per-step `connection_id` on those steps. On `execution=target` they are first-class native SQL for `target_dialect`.

### 5. Export

Each Query → dbt model SQL emitted for `target_dialect`. S3/file sources with `postgres` dialect require an explicit landing story (warn/block until landing exists).

## Consequences

- UI shows `export → duckdb|postgres` and per-query `local|target`.
- Structured emitters must avoid DuckDB-only syntax when dialect is `postgres` (e.g. `EXCLUDE`, `UNION ALL BY NAME`).
- Native target preview for `execution=target` is required for DE honesty; local remains the multi-source default.
