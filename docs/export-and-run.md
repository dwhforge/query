# Export, publish, parse, and build

How DWHForge Query turns a visual workspace into a **runnable dbt project**, and how that project lands data in DuckDB or PostgreSQL.

See also: [Getting started](GETTING_STARTED.md) · [ADR-0014](adr/0014-query-execution-affinity.md) · [ADR-0015](adr/0015-sources-vs-target-extensibility.md) · [ADR-0017](adr/0017-export-offline-dbt-parse.md)

---

## Product model

```text
Many sources  →  one execution engine (SQL dialect)
              →  one destination (where published marts materialize)
```

| Concept | Meaning |
|---------|---------|
| **Execution engine** | Dialect for emit / Derive / free SQL honesty (`duckdb` or `postgres`). |
| **Destination** | Sink for **published** models (`duckdb` file or Postgres via connection). |
| **Publish to destination** | Marks a query as `mart_*` on export (`Project.outputs`). |
| **Focus ★** | Default mart when `outputs` is empty; also the primary preview target. |

Engine and destination may differ. The important route for files → warehouse:

**engine = DuckDB, destination = PostgreSQL** → dbt-duckdb + `ATTACH` (no CSV landing into Postgres required).

---

## Four routes

| Route | Engine | Destination | Adapter |
|-------|--------|-------------|---------|
| Files/S3 → DuckDB | duckdb | duckdb | `local.duckdb` |
| Files/S3 → PostgreSQL | duckdb | postgres | duckdb + ATTACH `pg` |
| DuckDB file → PostgreSQL | duckdb | postgres | same ATTACH path |
| PostgreSQL → PostgreSQL | postgres | postgres | dbt-postgres |

File/S3 sources **require** DuckDB engine. Pure postgres engine + files needs landing (not the silent path).

---

## What gets which prefix

On Export, query names stay plain in the UI; model files get layers:

| Rule | Prefix | Folder |
|------|--------|--------|
| Single Load\* step | `stg_` | `models/staging/` |
| In `outputs` (or focus if `outputs` empty) | `mart_` | `models/marts/` |
| Everything else | `int_` | `models/intermediate/` |

KeyMaps with seed storage → `seeds/map_*.csv` (DuckDB on build, not auto-copied to Postgres).

---

## DuckDB → Postgres materialization

Generated `dbt_project.yml` (simplified):

- **staging / intermediate** → views in DuckDB `main`  
- **marts** → `+database: pg`, `+schema: <destination schema>` (default `public`)  
- **`macros/generate_schema_name.sql`** → schema name as-is (avoids dbt’s default `main_public`)

`profiles.yml` ATTACH:

```yaml
attach:
  - path: "{{ env_var('DWH_PG_DSN', 'postgresql://localhost/dwh') }}"
    type: postgres
    alias: pg
    read_only: false
```

**File → Build export** injects `DWH_PG_DSN` (and password when parseable) from the destination connection. CLI users set the env var themselves.

---

## UI operations & progress

| Menu | Progress phases |
|------|-----------------|
| **File → Export dbt…** | Writing files → `dbt parse` |
| **File → Parse export…** | `dbt parse` |
| **File → Build export…** | `dbt build` (seed + run + tests) |

A bottom progress bar shows the active phase. Menu actions are disabled while an op runs.

Semantics:

- **Parse** — offline author gate (YAML/Jinja/`ref`). Does not prove data.  
- **Build** — creates seeds and models; for duckdb→postgres, marts appear in Postgres.

---

## Safe re-export

`.dwhforge-export.json` tracks hashes of generator-owned files. Hand-edits to those paths block overwrite until you sync or export to a new folder ([ADR-0018](adr/0018-return-and-edit.md)).

---

## CLI cheatsheet

```bash
# After UI Export to /tmp/out/my_pipeline
cd /tmp/out/my_pipeline

# Author gate
../dbt-venv/bin/dbt parse --profiles-dir .   # or absolute path to venv

# Full materialize (duckdb→postgres)
export DWH_PG_DSN='postgresql://…'
../dbt-venv/bin/dbt build --profiles-dir .
```

Smoke for ATTACH (CI): `./scripts/ci-duckdb-pg-attach.sh` with `DWH_PG_DSN` set.
