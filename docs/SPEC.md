# DWHForge Query — Engineering Spec (v1 baseline)

Canon: product name **DWHForge Query** ([ADR-0016](adr/0016-product-rename-dwhforge-query.md)). Positioning — [ADR-0001](adr/0001-product-positioning.md).  
Docs language: English. License: **MIT**.

**Active product DoD:** [DESIGN.md](DESIGN.md) §10 · decisions [ADR-0018](adr/0018-return-and-edit.md).  
This SPEC remains the **engineering contract** and **v1 baseline** checklist (§5–§7).

**Local app dir** `~/.dwhforge-query/`: `secrets.json` (credentials) · `settings.json` (defaults / last-used Export dialect). Project IR stays in `.dwhproj.json` (`target_dialect` per project).

## 1. Project + Workspace contract

Reuse industry names ([ADR-0009](adr/0009-project-explorer.md)):

```typescript
// Project = dbt/IDE project container
interface Project {
  id: string;
  name: string;
  root_path?: string;
  connections: ConnectionDef[]; // ADR-0012 — credentials / endpoints
  sources: SourceDef[];         // objects; may reference connection_id
  workspace: Workspace;
  dbt_target: "v1" | "v2";
  last_dbt_export_path?: string;
  canvas?: { positions: Record<string, { x: number; y: number }> }; // React Flow layout
}

interface ConnectionDef {
  id: string;
  name: string;
  kind: "postgres" | "s3";
  postgres?: { connection_string: string };
  s3?: {
    provider: "config" | "credential_chain";
    region?, endpoint?, access_key_id?, secret_access_key?, session_token?;
    url_style?: "path" | "vhost";
    use_ssl: boolean;
    verify_ssl: boolean;      // false for self-signed / lab MinIO
  };
}

interface SourceDef {
  id: string;
  name: string;
  kind: "csv" | "parquet" | "postgres";
  path?: string;
  connection_id?: string;
  connection_string?: string; // legacy only
  schema?: string;
  table_name?: string;
}

interface Workspace {
  queries: QueryDef[];
  focus_query_id: string;
}
```

Rust runtime compile/preview still takes `Workspace`. Project is the FE/persistence unit (save `project.json` later).

TypeScript: `src/types/pipeline.ts`.

Compat: `preview_pipeline(steps)` ≡ workspace with a single query `id=main`, `focus=main`.

Explorer tree: `Project → Sources | Queries | Export`.

## 2. TransformationStep

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet { path: String },
    LoadPostgres {
        connection_string: String,
        schema: String,          // default "public" if omitted in JSON
        table_name: String,
    },
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
| `preview_workspace` | `Workspace`, `connections[]` | `PreviewResult` |
| `preview_pipeline` | `steps[]`, `connections[]` | `PreviewResult` (compat) |
| `export_dbt` | `pipeline_name`, `Workspace`, `output_dir`, `dbt_target?` | `{ path, files[], dbt_parse_ok, dbt_parse_log }` — always writes tree, then offline `dbt parse` ([§5.2](#52-export-validation-offline-parse)) |
| `list_export_tree` | `path` | `string[]` — refresh Explorer after open project |
| `list_postgres_objects` | `connection_string` | `{ schema, name, kind }[]` |
| `describe_postgres_object` | `connection_string`, `schema`, `table_name` | `{ name, data_type, is_nullable, ordinal_position }[]` |
| `test_postgres_connection` | `connection_string` | `()` |
| `save_project` | `path`, `Project` | `()` — writes `project.json` / `.dwhproj.json` |
| `load_project` | `path` | `Project` |
| `get_app_settings` | — | `{ default_target_dialect, default_dbt_target }` from `~/.dwhforge-query/settings.json` |
| `set_app_settings` | same shape | `()` — writes settings (not secrets; not project IR) |
| `describe_query` | `Workspace`, `query_id`, `upto_index` | `TableSchema` |
| `validate_reorder` | … | later |
| `export_python` / `ai_compile` | … | later / stub |

CLI twin (same IR): `dwh-export <project.json> <output_dir> [--name NAME] [--target v1|v2] [--validate]` → prints path + file tree. `--validate` is **off** by default (headless/CI without dbt); UI Export always validates.

Postgres UI: object picker — connect → browse catalog → select schema-qualified relation ([ADR-0010](adr/0010-postgres-object-picker.md)). Describe: select Postgres source → column/types in inspector.

## 5. DbtProducer (v1 baseline DoD)

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
- Baseline DoD **per target**: `dbt run` with no hand-edits on fixture 2 CSVs + Join. V1 can land before V2.  
- **Next:** re-export stability + result check vs preview — [DESIGN.md](DESIGN.md) §10 B–C · [ADR-0018](adr/0018-return-and-edit.md).

### 5.2 Export validation (offline parse)

Author-first: Export generates the project for git / another machine. After write, the app runs:

```text
dbt parse --no-partial-parse --project-dir <root> --profiles-dir <root>
```

- **In scope:** project structure, YAML, Jinja, `ref`/`source` graph — **no warehouse connection**.
- **Out of scope on Export:** `dbt debug`, `dbt compile`, `dbt run` (those need a data platform; `run` remains DoD on the target machine / CI).
- Missing `dbt`: soft-fail (`dbt_parse_ok: false` + install hint); **files still written**.
- Resolve binary: `src-tauri/dbt-venv/bin/dbt` ([`scripts/fetch-dbt-venv.sh`](../scripts/fetch-dbt-venv.sh)) → else `PATH`.

## 6. Frontend (v1)

- Queries list: add query, set focus, open a 2nd CSV as a new query.  
- **Add Postgres query** (connection string + table name) — required surface.  
- Steps editor: Filter + Join (right query, type, keys).  
- Virtualized preview; 150ms debounce.  
- **Export dbt** button (`DbtTarget`).  
- Read-only SQL panel (projection; see ADR-0004).

## 7. MVP Done Definition (v1 baseline)

> **Status:** baseline acceptance for the first shippable loop. **Not** the active release bar — see [DESIGN.md](DESIGN.md) §10.

1. Linux: DuckDB session; **`postgres` extension required when `LoadPostgres` is used** (offline-first load — [ADR-0011](adr/0011-offline-duckdb-extensions.md)). **Parquet** via core `read_parquet` (UI + AST). Spatial may stay best-effort.  
2. Workspace: ≥2 queries (CSV and/or Postgres), Join, preview ≤50.  
3. UI can add a Postgres query via **object picker** (connection → list schemas/tables/views → select).  
4. Export dbt → `dbt run` (multi-source + join; Postgres → `source()` + `sources.yml`) with no SQL hand-edits.  
5. Compiler tests: linear + join; `LoadPostgres` SQL shape covered.  

Postgres mandate: [ADR-0008](adr/0008-postgres-required.md).

## 8. Two-way visual ↔ text (deferred)

See [ADR-0004](adr/0004-two-way-visual-text.md). **Near-term substitute:** deterministic re-export ([ADR-0018](adr/0018-return-and-edit.md)) — not H1 parse-back.

- **Baseline:** visual → AST → SQL/dbt (one-way). Optional read-only SQL panel.  
- **H1 (later):** editable SQL per step + parse-back whitelist.  
- **H2 (later):** Delphi-like sync visual ↔ dbt project / pure SQL bundle + conflict reconcile.

## 9. Non-goals

Fuzzy merge, full PQ catalog, AI (stub OK until schema/re-export land), Python producer polish, DnD validate, full two-way round-trip.  
Also deferred: [DESIGN.md](DESIGN.md) §7 · [ADR-0018](adr/0018-return-and-edit.md).
