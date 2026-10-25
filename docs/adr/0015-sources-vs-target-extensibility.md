# ADR-0015: Many source DBMS, one target DBMS

## Status

Accepted (2026-10-25)

## Context

Real DE projects read from **many** systems (Postgres, MySQL, MSSQL, files, S3, …) and materialize into **one** warehouse per dbt run. Extensibility must not conflate “how we connect to a source” with “which SQL we emit for models.”

Related: [ADR-0012](0012-connections.md) (Connection ≠ Source ≠ Query), [ADR-0014](0014-query-execution-affinity.md) (target dialect, structural preview).

## Decision

### 1. One project target

`Project.target_dialect` is **exactly one** warehouse DBMS for export / model SQL (v1: `duckdb` | `postgres`; later: more targets).

Changing target re-emits SQL; a project does not run two warehouse targets at once.

### 2. Many source kinds

Sources grow via **connectors**, not by forking the transform IR:

| Layer | Responsibility | Extensibility |
|-------|----------------|---------------|
| `ConnectionKind` + params | Auth / endpoint (PG DSN, S3, later MySQL, MSSQL, …) | Add kind + UI picker |
| `Load*` / SourceDef | Object identity (table, path) + `connection_id` | Add Load step variant or generic `LoadRemote` |
| Preview federation | Prefer DuckDB scanners / httpfs where available | Per-connector capability |
| Landing | When target cannot read source live | Required for some source×target pairs |

**Source DBMS type ≠ target DBMS type is supported and expected.**

### 3. Shared transform emit (mandatory direction)

Visual steps after Load (`Filter`, `Join`, `GroupBy`, …) emit through **one** dialect-aware module used by:

- structural DuckDB preview (`GraphCompiler`)
- dbt model SQL (`DbtProducer`)
- later: Run on warehouse

Do **not** add a third parallel step→SQL compiler. Load/FromQuery/SqlModel adapters may stay mode-specific (scan vs `source()` vs `ref()`); transforms stay unified.

### 4. Roadmap (ordered)

1. **Now:** unify transform emit; keep Load adapters split.  
2. **Next sources:** new `ConnectionKind` + catalog + `Load*` + DuckDB path or landing note (MySQL/MSSQL/…).  
3. **Next targets:** extend `WarehouseDialect` + emitter caps (not N copies of GraphCompiler).  
4. **Later:** opt-in **Run on warehouse** ([ADR-0014](0014-query-execution-affinity.md) §3).  
5. **Later:** generalize `OutputProducer` beyond dbt version knob.

### 5. Non-goals (yet)

- Multi-target projects (two warehouses in one Project).  
- Per-step source connection on CustomSql.  
- Native warehouse preview as v1 DoD.

## Consequences

- Product story: “many sources → one dbt target,” structural preview local.  
- Adding a source is a connector package; adding a target is dialect caps + profiles.  
- Docs/UI must label `export → <target>` separately from source connection kind.
