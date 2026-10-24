# DWH-RS-QUERY — Engineering Spec (v1)

Canon: product name **DWH-RS-QUERY**. Positioning — [ADR-0001](adr/0001-product-positioning.md).  
Docs language: English (OSS under consideration, not decided).

## 1. Workspace contract

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Workspace {
    pub queries: Vec<QueryDef>,
    pub focus_query_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct QueryDef {
    pub id: String,
    pub name: String,
    pub steps: Vec<TransformationStep>,
}
```

TypeScript mirror: `src/types/pipeline.ts`.

Compat: `preview_pipeline(steps)` ≡ workspace with a single query `id=main`, `focus=main`.

## 2. TransformationStep

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet { path: String },
    LoadPostgres { connection_string: String, table_name: String },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    DeriveColumn { name: String, expression: String },
    GroupBy { dimensions: Vec<String>, aggregates: Vec<String> },
    SortBy { column: String, descending: bool },
    Join {
        right_query_id: String,
        join_type: JoinType,
        left_on: Vec<String>,
        right_on: Vec<String>,
    },
    Append { other_query_ids: Vec<String> },
    CustomSql { raw_sql: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JoinType { Inner, Left, Right, Full }
```

Rules: [ADR-0002](adr/0002-multi-query-workspace.md), [ADR-0003](adr/0003-join-append-steps.md).

- `CustomSql` placeholders: `{{prev_step}}`; optional `{{query:<id>}}` → last CTE of that query.  
- Cycles via Join/Append → compile error.

## 3. GraphCompiler

`GraphCompiler::to_sql(workspace, is_preview) -> Result<String, String>`

- Topo-sort queries by Join/Append deps.  
- CTE names: `q_<id>_s<idx>` (`id` sanitized to alnum/underscore).  
- Preview: `LIMIT 50` on the focus query’s last step.

`PipelineCompiler` (linear) remains a thin wrapper over a single-query workspace.

## 4. Tauri commands

| Command | In | Out |
|---------|----|-----|
| `preview_workspace` | `Workspace` | `PreviewResult` |
| `preview_pipeline` | `steps[]` | `PreviewResult` (compat) |
| `export_dbt` | `pipeline_name`, `Workspace`, `output_dir` | `{ path }` |
| `describe_query` | `Workspace`, `query_id`, `upto_index` | `TableSchema` |
| `validate_reorder` | … | later |
| `export_python` / `ai_compile` | … | later / stub |

## 5. DbtProducer (v1 DoD)

### 5.0 dbt major targets

```rust
pub enum DbtTarget { V1, V2 }
```

| Target | Meaning | `require-dbt-version` (initial) | Ship order |
|--------|---------|----------------------------------|------------|
| `V1` | dbt Core / CLI **1.x** | `">=1.7.0,<2.0.0"` | **Now** |
| `V2` | dbt **2.x** / Fusion-era | `">=2.0.0,<3.0.0"` | **Required follow-up** |

See [ADR-0006](adr/0006-dbt-version-matrix.md). YAML `config-version: 2` ≠ dbt v2.

`export_dbt` accepts `dbt_target: "v1" | "v2"`. Unsupported target → clear error until implemented.

### 5.1 Layout

Generates:

```
{output_dir}/{pipeline_name}/
  dbt_project.yml          # includes require-dbt-version for target
  profiles.yml.example     # duckdb (v1); v2 may diverge
  models/sources.yml
  models/staging/stg_*.sql
  models/intermediate/int_*.sql
  models/marts/mart_*.sql
```

- Each source-query (starts with Load*) → staging model.  
- Join/transform work → intermediate (or collapsed per-query model in early slice).  
- **Simplification (allowed early):** one dbt model per query = SQL for that query’s step chain with `ref()`/`source()`.  
- Focus query’s last model → `mart_<name>.sql`.  
- DoD **per target**: `dbt run` with no hand-edits on fixture 2 CSVs + Join. V1 DoD can land before V2.

## 6. Frontend (v1)

- Queries list: add query, set focus, open a 2nd CSV as a new query.  
- **Add Postgres query** (connection string + table name) — required surface.  
- Steps editor: Filter + Join (right query, type, keys).  
- Virtualized preview; 150ms debounce.  
- **Export dbt** button (`DbtTarget`).  
- Read-only SQL panel (projection; see ADR-0004).

## 7. MVP Done Definition (v1)

1. Linux: DuckDB session; **`postgres` extension required when `LoadPostgres` is used** (hard actionable error if unavailable). Spatial may stay best-effort.  
2. Workspace: ≥2 queries (CSV and/or Postgres), Join, preview ≤50.  
3. UI can add a Postgres query (connection string + table).  
4. Export dbt → `dbt run` (multi-source + join; Postgres → `source()` + `sources.yml`) with no SQL hand-edits.  
5. Compiler tests: linear + join; `LoadPostgres` SQL shape covered.  

Postgres mandate: [ADR-0008](adr/0008-postgres-required.md).

## 8. Two-way visual ↔ text (roadmap, not v1 DoD)

See [ADR-0004](adr/0004-two-way-visual-text.md).

- **v1:** visual → AST → SQL/dbt (one-way). Optional read-only SQL panel.  
- **H1:** editable SQL per step + parse-back whitelist.  
- **H2:** Delphi-like sync visual ↔ dbt project / pure SQL bundle + conflict reconcile.

## 9. Non-goals (v1)

Fuzzy merge, full PQ catalog, AI (stub OK), Python producer polish, DnD validate, full two-way round-trip.
