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

`Project.target_dialect`: `duckdb` | `postgres` (export emit; labels free SQL / Model tab).

Optional `Project.target_connection_id`: postgres Connection for profiles hint and **later** warehouse run.

`dbt_target` remains **dbt version** (v1/v2), not warehouse dialect.

Source DB type may differ from target (e.g. PG source, DuckDB or later MSSQL target) — normal. Canon for many sources / one target: [ADR-0015](0015-sources-vs-target-extensibility.md).

### 2. Query execution affinity (one Query → one engine)

`QueryDef.execution`: `local` | `target` (default `local`). Affinity is per Query node; it does **not** spread to downstream Queries.

| Value | Meaning |
|-------|---------|
| `local` | Preview engine = DuckDB (federation OK). When `target_dialect=duckdb`, ≈ `dbt run` on DuckDB. |
| `target` | Intent: this node’s SQL/dialect is the **warehouse target** (export honesty). |

- No mid-chain engine split inside one Query.
- Jump / merge in DuckDB only at **Query boundaries** during local preview.

### 3. Preview policy (v1 vs later)

**v1 (must):** *structural* preview in-process via DuckDB for IR / multi-source — catch bad joins, missing columns, grain. Show target-dialect SQL in Model tab. Do **not** require native warehouse round-trips for everyday editing.

**Later (goal, opt-in):** **Run on warehouse** — execute on `target_dialect` connection to validate vendor functions, plans, and real warehouse behavior. Not a v1 DoD item; ship when unify-emit + PreviewEngine exist. Until then, UI may label DuckDB results as structural / not warehouse-native when `target_dialect ≠ duckdb`.

### 4. Validation

`execution=target` is invalid for export/run-on-warehouse if the chain needs what the warehouse cannot run without landing (e.g. `LoadCsv` / remote Parquet when dialect is `postgres`). Fail loud on export; do not pretend file sources are already on PG.

### 5. Free SQL

`SqlModel` / `CustomSql` are authored in **target** dialect (not source). No per-step `connection_id` on those steps. v1: show SQL + structural DuckDB when feasible; vendor-faithful execute = later Run on warehouse.

### 6. Export

Each Query → dbt model SQL emitted for `target_dialect`. S3/file sources with `postgres` dialect require landing (warn/block until landing exists).

## Consequences

- UI shows `export → duckdb|postgres` and per-query `local|target`.
- Structured emitters must avoid DuckDB-only syntax when dialect is `postgres` (e.g. `EXCLUDE`, `UNION ALL BY NAME`).
- Do not block v1 on native target preview; keep **Run on warehouse** on the roadmap after unify emit.
