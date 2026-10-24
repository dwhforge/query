# Early technical brief (archive) — DWH-RS-QUERY

> Archived early design brief. Product name normalized to **DWH-RS-QUERY**.  
> Canonical engineering docs: [DESIGN.md](DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md), [SPEC.md](SPEC.md), [adr/](adr/).  
> Docs language: English (possible future OSS; not decided).

## 1. System context and invariants

DWH-RS-QUERY is a local desktop app on Tauri (Frontend: React/TS/Tailwind, Backend: Rust + embedded DuckDB).

Core principle: the **Rust backend does not keep row data in memory**. It owns only a step AST, translates it to SQL for DuckDB, and streams the first 50 rows (Preview) to the frontend.

Heavy work (out-of-core processing, spilling hash tables on `GROUP BY`) is DuckDB’s job. Processing stays local on the user’s Linux/macOS/Windows machine; raw data is not sent to the cloud.

> Later refinement: the canonical AST is a **multi-query Workspace**, not only a linear `Vec<TransformationStep>` — see ADR-0002.

## 2. Backend sketch (historical)

### 2.1 Transformation steps (early linear enum)

Early contract included: `LoadCsv`, `LoadParquet`, `LoadPostgres`, `Filter`, `SelectColumns`, `RenameColumn`, `DeriveColumn`, `GroupBy`, `SortBy`, `CustomSql` (`{{prev_step}}`).

**Superseded additions:** `Join`, `Append`, `Workspace` / `QueryDef` — see [SPEC.md](SPEC.md).

### 2.2 Pipeline compiler (CTE)

Early design: compile `TransformationStep[]` into a single `WITH step_0 AS (…), … SELECT * FROM step_N [LIMIT 50]`.

**Superseded by:** `GraphCompiler` over Workspace with CTE names `q_<id>_s<idx>`.

## 3. Output producers (historical)

- Trait `OutputProducer`  
- dbt producer with `stg_` / `mart_` and `{{ ref() }}`  
- Python/Polars method-chaining producer (conceptual)

Canonical v1 dbt layout: [SPEC.md §5](SPEC.md).

## 4. Frontend (historical)

- TS types for steps and schema  
- TanStack Table + row virtualization (required)  
- Preview debounce 150ms  

## 5. AI context engine (historical)

System prompt: emit **only** valid JSON `TransformationStep[]` from NL, using current schema + applied steps; DuckDB SQL for derived fields; no markdown fences.

## 6. Early MVP done definition

1. Linux: DuckDB session loads `postgres` and `spatial` without crashing.  
2. Change-history DnD with bottom-up schema validation; block breaking reorders.  
3. “Export to dbt” yields a project that runs via `dbt run` without hand-editing generated `.sql`.

These remain directional; current v1 DoD is in [SPEC.md](SPEC.md).
