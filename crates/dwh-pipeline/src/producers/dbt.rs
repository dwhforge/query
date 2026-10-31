use crate::destination::{
    is_duckdb_to_postgres, route_allows_file_sources, DestinationKind, ExecutionEngine,
};
use crate::dialect::{
    validate_engine_execution, workspace_needs_s3_landing, WarehouseDialect,
};
use crate::emit::{
    emit_transform_step_ex, key_map_seed_csv_named, key_map_seed_name,
    substitute_query_placeholders, EmitSchemaOpts,
};
use crate::export_manifest::commit_export_plan;
use crate::graph::{sanitize_id, topo_queries};
use crate::model::{KeyMapEntry, TransformationStep, Workspace};
use crate::producers::{DbtTarget, OutputProducer};
use crate::schema::{infer_workspace_schemas, WorkspaceSchemas};
use crate::parquet_scan::read_parquet_call_opts;
use crate::sql_escape::escape_sql_string;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

fn dbt_ref_relations(models: &HashMap<String, String>) -> HashMap<String, String> {
    models
        .iter()
        .map(|(qid, m)| (qid.clone(), format!("{{{{ ref('{m}') }}}}")))
        .collect()
}

use crate::model::KeyMapStorage;

/// Seed-backed maps only (id → entries). Catalog wins; ApplyKeyMap snapshots fill gaps.
fn collect_seed_key_maps(workspace: &Workspace) -> BTreeMap<String, Vec<KeyMapEntry>> {
    let mut out: BTreeMap<String, Vec<KeyMapEntry>> = BTreeMap::new();
    for km in &workspace.key_maps {
        if km.is_seed_backed() {
            out.insert(km.id.clone(), km.entries.clone());
        }
    }
    for q in &workspace.queries {
        for step in &q.steps {
            if let TransformationStep::ApplyKeyMap {
                map_id, entries, ..
            } = step
            {
                let seed_backed = workspace
                    .key_map(map_id)
                    .map(|m| m.is_seed_backed())
                    .unwrap_or(true);
                if seed_backed {
                    out.entry(map_id.clone()).or_insert_with(|| entries.clone());
                }
            }
        }
    }
    out
}

/// map_id → SQL relation for ApplyKeyMap emit (`ref` / `source` / seed ref).
fn key_map_relations(workspace: &Workspace) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for km in &workspace.key_maps {
        let rel = match &km.storage {
            KeyMapStorage::Seed => {
                let seed = key_map_seed_name(&km.id);
                format!("{{{{ ref('{seed}') }}}}")
            }
            KeyMapStorage::Ref { model } => format!("{{{{ ref('{model}') }}}}"),
            KeyMapStorage::Source { source, table, .. } => {
                format!("{{{{ source('{source}', '{table}') }}}}")
            }
        };
        out.insert(km.id.clone(), rel);
    }
    // ApplyKeyMap without catalog entry → assume seed.
    for q in &workspace.queries {
        for step in &q.steps {
            if let TransformationStep::ApplyKeyMap { map_id, .. } = step {
                out.entry(map_id.clone()).or_insert_with(|| {
                    let seed = key_map_seed_name(map_id);
                    format!("{{{{ ref('{seed}') }}}}")
                });
            }
        }
    }
    out
}

/// map_id → (from_column, to_column) for ApplyKeyMap join emit.
fn key_map_columns(workspace: &Workspace) -> HashMap<String, (String, String)> {
    let mut out = HashMap::new();
    for km in &workspace.key_maps {
        let from = if km.from_column.trim().is_empty() {
            "from".into()
        } else {
            km.from_column.clone()
        };
        let to = if km.to_column.trim().is_empty() {
            "to".into()
        } else {
            km.to_column.clone()
        };
        out.insert(km.id.clone(), (from, to));
    }
    out
}

pub struct DbtProducer;

impl OutputProducer for DbtProducer {
    fn produce(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
        dialect: WarehouseDialect,
    ) -> Result<String, String> {
        self.produce_with_seeds(
            pipeline_name,
            workspace,
            output_dir,
            target,
            dialect,
            &HashMap::new(),
        )
    }
}

impl DbtProducer {
    /// Export with Load* column seeds for schema-aware emit (ADR-0018).
    pub fn produce_with_seeds(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
        dialect: WarehouseDialect,
        load_seeds: &HashMap<String, Vec<String>>,
    ) -> Result<String, String> {
        let has_files = workspace_needs_s3_landing(&workspace.queries)
            || workspace.queries.iter().any(|q| {
                q.steps.iter().any(|s| {
                    matches!(
                        s,
                        TransformationStep::LoadCsv { .. }
                            | TransformationStep::LoadParquet { .. }
                    )
                })
            });
        // Legacy UI knob was a single `target_dialect`. Files + "postgres" means the
        // Files/S3→PostgreSQL route (DuckDB engine, PG destination) — not dbt-postgres landing.
        let (engine, destination) = match (dialect, has_files) {
            (WarehouseDialect::Postgres, true) => {
                (ExecutionEngine::Duckdb, DestinationKind::Postgres)
            }
            (WarehouseDialect::Postgres, false) => {
                (ExecutionEngine::Postgres, DestinationKind::Postgres)
            }
            (WarehouseDialect::Duckdb, _) => (ExecutionEngine::Duckdb, DestinationKind::Duckdb),
        };
        self.produce_routed(
            pipeline_name,
            workspace,
            output_dir,
            target,
            engine,
            destination,
            load_seeds,
        )
    }

    /// Export with explicit execution engine and materialization destination.
    pub fn produce_routed(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
        engine: ExecutionEngine,
        destination: DestinationKind,
        load_seeds: &HashMap<String, Vec<String>>,
    ) -> Result<String, String> {
        // Pure postgres engine historically used `sys`; duckdb→pg marts use `public`.
        let default_schema = match engine {
            ExecutionEngine::Postgres => "sys",
            ExecutionEngine::Duckdb => "public",
        };
        self.produce_routed_with_schema(
            pipeline_name,
            workspace,
            output_dir,
            target,
            engine,
            destination,
            default_schema,
            &[],
            load_seeds,
        )
    }

    /// Like [`produce_routed`], with Postgres schema for published marts.
    /// `published_query_ids` empty → only `focus_query_id` is `mart_*` (legacy).
    pub fn produce_routed_with_schema(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
        engine: ExecutionEngine,
        destination: DestinationKind,
        postgres_schema: &str,
        published_query_ids: &[String],
        load_seeds: &HashMap<String, Vec<String>>,
    ) -> Result<String, String> {
        self.produce_routed_with_schema_and_sources(
            pipeline_name,
            workspace,
            output_dir,
            target,
            engine,
            destination,
            postgres_schema,
            published_query_ids,
            load_seeds,
            &[],
        )
    }

    pub fn produce_routed_with_schema_and_sources(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
        engine: ExecutionEngine,
        destination: DestinationKind,
        postgres_schema: &str,
        published_query_ids: &[String],
        load_seeds: &HashMap<String, Vec<String>>,
        sources: &[crate::project::SourceDef],
    ) -> Result<String, String> {
        if matches!(target, DbtTarget::V2) {
            return Err(
                "dbt v2 export is reserved (ADR-0006) but not implemented yet. Use dbt_target: v1."
                    .into(),
            );
        }

        let dialect = engine.dialect();
        let has_files = workspace_needs_s3_landing(&workspace.queries)
            || workspace.queries.iter().any(|q| {
                q.steps.iter().any(|s| {
                    matches!(
                        s,
                        TransformationStep::LoadCsv { .. }
                            | TransformationStep::LoadParquet { .. }
                    )
                })
            });

        // File/S3 sources require DuckDB execution engine (no silent landing).
        if has_files && !route_allows_file_sources(engine) {
            return Err(
                "execution_engine=postgres: file/S3 sources need landing into Postgres before dbt export, \
                 or use execution_engine=duckdb with destination=postgres (dbt-duckdb ATTACH route)."
                    .into(),
            );
        }

        for q in &workspace.queries {
            validate_engine_execution(q, engine)?;
        }

        let plan = build_export_plan_routed(
            pipeline_name,
            workspace,
            target,
            engine,
            destination,
            postgres_schema,
            published_query_ids,
            load_seeds,
            sources,
        )?;
        let root = Path::new(output_dir).join(pipeline_name);
        let manifest_tag = if is_duckdb_to_postgres(engine, destination) {
            "duckdb->postgres"
        } else {
            dialect.as_str()
        };
        commit_export_plan(&root, pipeline_name, manifest_tag, &plan)?;
        Ok(root.to_string_lossy().into_owned())
    }
}

/// Relative path → file body for a full dbt export tree (excl. manifest).
pub fn build_export_plan(
    pipeline_name: &str,
    workspace: &Workspace,
    target: DbtTarget,
    dialect: WarehouseDialect,
    load_seeds: &HashMap<String, Vec<String>>,
) -> Result<BTreeMap<String, String>, String> {
    // Legacy single-dialect export: postgres engine keeps historical target schema `sys`.
    let (dest, pg_schema) = match dialect {
        WarehouseDialect::Duckdb => (DestinationKind::Duckdb, "public"),
        WarehouseDialect::Postgres => (DestinationKind::Postgres, "sys"),
    };
    build_export_plan_routed(
        pipeline_name,
        workspace,
        target,
        ExecutionEngine::from_dialect(dialect),
        dest,
        pg_schema,
        &[],
        load_seeds,
        &[],
    )
}

/// Export plan with explicit engine × destination (four routes).
/// `postgres_schema` = where marts land when destination is Postgres (default callers use `public`).
/// `published_query_ids` empty → only focus query is `mart_*`.
pub fn build_export_plan_routed(
    pipeline_name: &str,
    workspace: &Workspace,
    target: DbtTarget,
    engine: ExecutionEngine,
    destination: DestinationKind,
    postgres_schema: &str,
    published_query_ids: &[String],
    load_seeds: &HashMap<String, Vec<String>>,
    sources: &[crate::project::SourceDef],
) -> Result<BTreeMap<String, String>, String> {
    let dialect = engine.dialect();
    let mut plan = BTreeMap::new();

    let key_maps = collect_seed_key_maps(workspace);
    let seed_paths_line = if key_maps.is_empty() {
        String::new()
    } else {
        "seed-paths: [\"seeds\"]\n".into()
    };
    // Force VARCHAR so codes like "001" stay strings (dbt otherwise infers INTEGER).
    // Nesting must be seeds → project_name → seed_name (dbt 1.x config).
    let mut seeds_cfg = String::new();
    if !key_maps.is_empty() {
        seeds_cfg.push_str("seeds:\n");
        seeds_cfg.push_str(&format!("  {pipeline_name}:\n"));
        for map_id in key_maps.keys() {
            let seed = key_map_seed_name(map_id);
            let (from_col, to_col) = workspace
                .key_map(map_id)
                .map(|m| {
                    (
                        if m.from_column.trim().is_empty() {
                            "from".to_string()
                        } else {
                            m.from_column.clone()
                        },
                        if m.to_column.trim().is_empty() {
                            "to".to_string()
                        } else {
                            m.to_column.clone()
                        },
                    )
                })
                .unwrap_or_else(|| ("from".into(), "to".into()));
            seeds_cfg.push_str(&format!(
                "    {seed}:\n      +column_types:\n        {from_col}: varchar\n        {to_col}: varchar\n"
            ));
        }
    }
    let pg_schema_raw = postgres_schema.trim();
    let pg_schema = sanitize_id(if pg_schema_raw.is_empty() {
        "public"
    } else {
        pg_schema_raw
    });
    // duckdb→postgres: stg/int stay in DuckDB `main`; marts write into ATTACH alias `pg`.
    let marts_block = if is_duckdb_to_postgres(engine, destination) {
        format!(
            "    marts:\n      +materialized: table\n      +database: pg\n      +schema: {pg_schema}\n"
        )
    } else if matches!(destination, DestinationKind::Postgres) {
        format!("    marts:\n      +materialized: table\n      +schema: {pg_schema}\n")
    } else {
        "    marts:\n      +materialized: table\n".into()
    };
    // Without this macro dbt default is `{target.schema}_{custom}` → DuckDB `main` +
    // `public` becomes Postgres schema `main_public`.
    let macro_paths_line = if matches!(destination, DestinationKind::Postgres) {
        "macro-paths: [\"macros\"]\n"
    } else {
        ""
    };
    if matches!(destination, DestinationKind::Postgres) {
        plan.insert(
            "macros/generate_schema_name.sql".into(),
            "{% macro generate_schema_name(custom_schema_name, node) -%}\n\
  {%- if custom_schema_name is none -%}\n\
    {{ target.schema }}\n\
  {%- else -%}\n\
    {{ custom_schema_name | trim }}\n\
  {%- endif -%}\n\
{%- endmacro %}\n"
                .into(),
        );
    }
    plan.insert(
        "dbt_project.yml".into(),
        format!(
            "name: '{pipeline_name}'\n\
version: '1.0.0'\n\
config-version: 2\n\
profile: '{pipeline_name}'\n\
model-paths: [\"models\"]\n\
{macro_paths_line}\
{seed_paths_line}\
models:\n  {pipeline_name}:\n    staging:\n      +materialized: view\n    intermediate:\n      +materialized: view\n\
{marts_block}\
{seeds_cfg}\
# Generated by DWHForge Query for dbt {target}\n",
            target = target.as_str()
        ),
    );

    for (map_id, entries) in &key_maps {
        let seed = key_map_seed_name(map_id);
        let (from_col, to_col) = workspace
            .key_map(map_id)
            .map(|m| {
                (
                    if m.from_column.trim().is_empty() {
                        "from".to_string()
                    } else {
                        m.from_column.clone()
                    },
                    if m.to_column.trim().is_empty() {
                        "to".to_string()
                    } else {
                        m.to_column.clone()
                    },
                )
            })
            .unwrap_or_else(|| ("from".into(), "to".into()));
        plan.insert(
            format!("seeds/{seed}.csv"),
            key_map_seed_csv_named(entries, &from_col, &to_col),
        );
    }

    // Adapter follows execution_engine; destination=postgres with duckdb engine uses ATTACH.
    let profiles = match (engine, destination) {
        (ExecutionEngine::Postgres, _) => format!(
            "{pipeline_name}: # must match profile: in dbt_project.yml\n  outputs:\n    dev:\n      type: postgres\n      host: localhost\n      user: postgres\n      password: \"{{{{ env_var('DWH_PG_PASSWORD', '') }}}}\"\n      port: 5432\n      dbname: dwh\n      schema: {pg_schema}\n      threads: 4\n  target: dev\n"
        ),
        (ExecutionEngine::Duckdb, DestinationKind::Postgres) => format!(
            "{pipeline_name}:\n  outputs:\n    dev:\n      type: duckdb\n      path: 'local.duckdb'\n      threads: 4\n      # Writable Postgres catalog via ATTACH (set DWH_PG_DSN before dbt build).\n      # Default lets `dbt parse` succeed offline; real DSN required for build/run.\n      attach:\n        - path: \"{{{{ env_var('DWH_PG_DSN', 'postgresql://localhost/dwh') }}}}\"\n          type: postgres\n          alias: pg\n          read_only: false\n  target: dev\n"
        ),
        (ExecutionEngine::Duckdb, DestinationKind::Duckdb) => format!(
            "{pipeline_name}:\n  outputs:\n    dev:\n      type: duckdb\n      path: 'local.duckdb'\n      threads: 4\n  target: dev\n"
        ),
    };
    plan.insert("profiles.yml".into(), profiles.clone());
    plan.insert("profiles.yml.example".into(), profiles);
    if is_duckdb_to_postgres(engine, destination) {
        plan.insert(
            "README.destination.md".into(),
            format!(
                "# DuckDB execution → PostgreSQL destination\n\n\
**In the app:** File → Build export uses the project's destination Postgres\n\
connection (injects `DWH_PG_DSN` from secrets).\n\n\
**Where data lands:** staging/intermediate → DuckDB `main`;\n\
marts → Postgres schema `{pg_schema}` via ATTACH alias `pg`\n\
(`+database: pg`; `generate_schema_name` keeps the schema name as-is,\n\
not `main_{pg_schema}`).\n\n\
**CLI:** set `DWH_PG_DSN` (e.g. `postgresql://user:pass@host:5432/db`) then:\n\n\
```bash\ncd <export_root>\ndbt build --profiles-dir .\n```\n\n\
Working file `local.duckdb` is separate from any DuckDB *source* files.\n"
            ),
        );
    }

    let order = topo_queries(workspace)?;
    let schemas = infer_workspace_schemas(workspace, load_seeds)?;
    let mut model_name_by_query: HashMap<String, String> = HashMap::new();
    let mut pg_by_schema: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for qid in &order {
        let query = workspace
            .query(qid)
            .ok_or_else(|| format!("missing query {qid}"))?;
        let model_name = dbt_model_name(workspace, query, published_query_ids);
        let folder = if model_name.starts_with("mart_") {
            "models/marts"
        } else if model_name.starts_with("stg_") {
            "models/staging"
        } else {
            "models/intermediate"
        };
        let sql = compile_query_as_dbt_model(
            workspace,
            query,
            &model_name_by_query,
            dialect,
            &schemas,
            sources,
        )?;
        plan.insert(format!("{folder}/{model_name}.sql"), sql);
        model_name_by_query.insert(qid.clone(), model_name);

        for step in &query.steps {
            match step {
                TransformationStep::LoadPostgres {
                    schema,
                    table_name,
                    ..
                } => {
                    pg_by_schema
                        .entry(sanitize_id(schema))
                        .or_default()
                        .insert(sanitize_id(table_name));
                }
                TransformationStep::LoadDuckdb {
                    schema,
                    table_name,
                    ..
                } => {
                    // External DuckDB relations are declared as dbt sources under schema name.
                    pg_by_schema
                        .entry(sanitize_id(schema))
                        .or_default()
                        .insert(sanitize_id(table_name));
                }
                _ => {}
            }
        }
    }

    // KeyMap storage=source also needs dbt sources.yml entries.
    for km in &workspace.key_maps {
        if let KeyMapStorage::Source { source, table, .. } = &km.storage {
            if !source.trim().is_empty() && !table.trim().is_empty() {
                pg_by_schema
                    .entry(sanitize_id(source))
                    .or_default()
                    .insert(sanitize_id(table));
            }
        }
    }

    let sources_yml = if pg_by_schema.is_empty() {
        "version: 2\n# No postgres sources in this export.\nsources: []\n".to_string()
    } else {
        let mut sources_yml = String::from("version: 2\nsources:\n");
        for (schema, tables) in &pg_by_schema {
            sources_yml.push_str(&format!(
                "  - name: {schema}\n    schema: {schema}\n    tables:\n"
            ));
            for table in tables {
                sources_yml.push_str(&format!("      - name: {table}\n"));
            }
        }
        sources_yml
    };
    plan.insert("models/sources.yml".into(), sources_yml);

    Ok(plan)
}

fn is_source_only_query(query: &crate::model::QueryDef) -> bool {
    matches!(
        query.steps.first(),
        Some(
            TransformationStep::LoadCsv { .. }
                | TransformationStep::LoadParquet { .. }
                | TransformationStep::LoadPostgres { .. }
                | TransformationStep::LoadDuckdb { .. }
        )
    ) && query.steps.len() == 1
}

/// dbt model file stem for a query (`stg_` / `int_` / `mart_`).
/// Layer prefixes are export-only — query names in the UI normally omit them.
/// If a user already put `stg_`/`int_`/`mart_` in the query name, keep as-is.
///
/// Published marts: `published` non-empty → those query ids; empty → `focus_query_id` only.
pub fn dbt_model_name(
    workspace: &Workspace,
    query: &crate::model::QueryDef,
    published: &[String],
) -> String {
    let stem = sanitize_id(&query.name);
    if stem.starts_with("stg_") || stem.starts_with("int_") || stem.starts_with("mart_") {
        return stem;
    }
    let is_mart = if published.is_empty() {
        query.id == workspace.focus_query_id
    } else {
        published.iter().any(|id| id == &query.id)
    };
    let prefix = if is_mart {
        "mart"
    } else if is_source_only_query(query) {
        "stg"
    } else {
        "int"
    };
    format!("{prefix}_{stem}")
}

/// Build query-id → model-name map in dependency order (for `ref()`).
pub fn dbt_model_names(workspace: &Workspace) -> Result<std::collections::HashMap<String, String>, String> {
    dbt_model_names_published(workspace, &[])
}

/// Like [`dbt_model_names`], with explicit published query ids (`Project.outputs`).
pub fn dbt_model_names_published(
    workspace: &Workspace,
    published: &[String],
) -> Result<std::collections::HashMap<String, String>, String> {
    let order = topo_queries(workspace)?;
    let mut map = std::collections::HashMap::new();
    for qid in order {
        let query = workspace
            .query(&qid)
            .ok_or_else(|| format!("missing query {qid}"))?;
        map.insert(qid, dbt_model_name(workspace, query, published));
    }
    Ok(map)
}

/// Compiled dbt model SQL for one query (same body as export). Live Model tab.
pub fn preview_dbt_model_sql(
    workspace: &Workspace,
    query_id: &str,
    dialect: WarehouseDialect,
) -> Result<PreviewDbtModel, String> {
    preview_dbt_model_sql_with_seeds(workspace, query_id, dialect, &HashMap::new())
}

/// Like [`preview_dbt_model_sql`], with Load* column seeds (catalog/describe) for schema emit.
pub fn preview_dbt_model_sql_with_seeds(
    workspace: &Workspace,
    query_id: &str,
    dialect: WarehouseDialect,
    load_seeds: &HashMap<String, Vec<String>>,
) -> Result<PreviewDbtModel, String> {
    preview_dbt_model_sql_with_seeds_and_sources(
        workspace,
        query_id,
        dialect,
        load_seeds,
        &[],
    )
}

/// Like [`preview_dbt_model_sql_with_seeds`], with project sources (Hive partitioning).
pub fn preview_dbt_model_sql_with_seeds_and_sources(
    workspace: &Workspace,
    query_id: &str,
    dialect: WarehouseDialect,
    load_seeds: &HashMap<String, Vec<String>>,
    sources: &[crate::project::SourceDef],
) -> Result<PreviewDbtModel, String> {
    let query = workspace
        .query(query_id)
        .ok_or_else(|| format!("query '{query_id}' not found"))?;
    let names = dbt_model_names(workspace)?;
    let schemas = infer_workspace_schemas(workspace, load_seeds)?;
    let sql = compile_query_as_dbt_model(
        workspace,
        query,
        &names,
        dialect,
        &schemas,
        sources,
    )?;
    let model_name = names
        .get(query_id)
        .cloned()
        .unwrap_or_else(|| dbt_model_name(workspace, query, &[]));
    Ok(PreviewDbtModel {
        query_id: query_id.to_string(),
        model_name,
        sql,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PreviewDbtModel {
    pub query_id: String,
    pub model_name: String,
    pub sql: String,
}

fn known_query_columns(schemas: &WorkspaceSchemas) -> HashMap<String, Vec<String>> {
    schemas
        .query_out
        .iter()
        .filter_map(|(id, s)| s.as_ref().map(|cols| (id.clone(), cols.clone())))
        .collect()
}

fn compile_query_as_dbt_model(
    workspace: &Workspace,
    query: &crate::model::QueryDef,
    models: &std::collections::HashMap<String, String>,
    dialect: WarehouseDialect,
    schemas: &WorkspaceSchemas,
    sources: &[crate::project::SourceDef],
) -> Result<String, String> {
    // v1: collapse query into one model SQL (WITH inside file) using ref() for deps.
    if query.steps.is_empty() {
        return Err(format!("query '{}' empty", query.id));
    }

    // Single Load* / FromQuery — one-shot select.
    if query.steps.len() == 1 {
        return Ok(match &query.steps[0] {
            TransformationStep::LoadCsv { path } => format!(
                "-- source: csv\nselect * from read_csv_auto('{}')\n",
                escape_sql_string(path)
            ),
            TransformationStep::LoadParquet {
                path,
                connection_id,
            } => {
                let hive = crate::project::parquet_hive_partitioning(
                    sources,
                    path,
                    connection_id.as_deref(),
                );
                format!(
                    "-- source: parquet\nselect * from {}\n",
                    read_parquet_call_opts(path, hive)
                )
            }
            TransformationStep::LoadPostgres {
                schema,
                table_name,
                ..
            } => {
                let (src, tbl) = pg_dbt_source_ref(schema, table_name);
                format!("select * from {{{{ source('{src}', '{tbl}') }}}}\n")
            }
            TransformationStep::LoadDuckdb {
                schema,
                table_name,
                ..
            } => {
                let (src, tbl) = pg_dbt_source_ref(schema, table_name);
                format!(
                    "-- source: duckdb file (ATTACH read-only in profile / pre-hook)\n\
                     select * from {{{{ source('{src}', '{tbl}') }}}}\n"
                )
            }
            TransformationStep::FromQuery { query_id } => {
                let m = models.get(query_id).ok_or_else(|| {
                    format!("dbt FromQuery: missing model for '{query_id}'")
                })?;
                format!("select * from {{{{ ref('{m}') }}}}\n")
            }
            TransformationStep::SqlModel { raw_sql } => {
                let mut sql =
                    substitute_query_placeholders(raw_sql, &dbt_ref_relations(models));
                if !sql.ends_with('\n') {
                    sql.push('\n');
                }
                sql
            }
            _ => {
                return Err(
                    "single-step query must be Load*, FromQuery, or SqlModel".into(),
                )
            }
        });
    }

    let relations = dbt_ref_relations(models);
    let qcols = known_query_columns(schemas);
    let step_schemas = schemas.steps.get(&query.id);
    let mut ctes = Vec::new();
    // Bare dbt call for left-side columns (join merge / jinja fallback); cleared after schema change.
    let mut left_dbt: Option<String> = None;
    for (idx, step) in query.steps.iter().enumerate() {
        let name = format!("s{idx}");
        let prev = if idx > 0 {
            format!("s{}", idx - 1)
        } else {
            String::new()
        };
        let prev_columns = if idx > 0 {
            step_schemas
                .and_then(|v| v.get(idx - 1))
                .and_then(|s| s.as_ref())
                .map(|c| c.as_slice())
        } else {
            None
        };
        let body = match step {
            TransformationStep::LoadCsv { path } => {
                left_dbt = None;
                format!(
                    "select * from read_csv_auto('{}')",
                    escape_sql_string(path)
                )
            }
            TransformationStep::LoadParquet {
                path,
                connection_id,
            } => {
                left_dbt = None;
                let hive = crate::project::parquet_hive_partitioning(
                    sources,
                    path,
                    connection_id.as_deref(),
                );
                format!("select * from {}", read_parquet_call_opts(path, hive))
            }
            TransformationStep::LoadPostgres {
                schema,
                table_name,
                ..
            } => {
                let (src, tbl) = pg_dbt_source_ref(schema, table_name);
                left_dbt = Some(format!("source('{src}', '{tbl}')"));
                format!("select * from {{{{ source('{src}', '{tbl}') }}}}")
            }
            TransformationStep::LoadDuckdb {
                schema,
                table_name,
                ..
            } => {
                let (src, tbl) = pg_dbt_source_ref(schema, table_name);
                left_dbt = Some(format!("source('{src}', '{tbl}')"));
                format!("select * from {{{{ source('{src}', '{tbl}') }}}}")
            }
            TransformationStep::FromQuery { query_id } => {
                if !prev.is_empty() {
                    return Err("dbt FromQuery must be the first step".into());
                }
                let m = models.get(query_id).ok_or_else(|| {
                    format!("dbt FromQuery: missing model for '{query_id}'")
                })?;
                left_dbt = Some(format!("ref('{m}')"));
                format!("select * from {{{{ ref('{m}') }}}}")
            }
            TransformationStep::SqlModel { raw_sql } => {
                if !prev.is_empty() {
                    return Err("dbt SqlModel must be the first step".into());
                }
                left_dbt = None;
                substitute_query_placeholders(raw_sql, &relations)
            }
            other => {
                let key_map_relations = key_map_relations(workspace);
                let key_map_columns = key_map_columns(workspace);
                let sql = emit_transform_step_ex(
                    other,
                    &prev,
                    &relations,
                    dialect,
                    EmitSchemaOpts {
                        left_dbt_relation: left_dbt.as_deref(),
                        prev_columns,
                        query_columns: Some(&qcols),
                        key_map_relations: Some(&key_map_relations),
                        key_map_columns: Some(&key_map_columns),
                    },
                )?;
                // Physical left relation no longer matches CTE column set.
                if matches!(
                    other,
                    TransformationStep::Join { .. }
                        | TransformationStep::Append { .. }
                        | TransformationStep::SelectColumns { .. }
                        | TransformationStep::RenameColumn { .. }
                        | TransformationStep::DeriveColumn { .. }
                        | TransformationStep::GroupBy { .. }
                        | TransformationStep::CustomSql { .. }
                        | TransformationStep::NormalizeKey { .. }
                        | TransformationStep::ApplyKeyMap { .. }
                ) {
                    left_dbt = None;
                }
                sql
            }
        };
        ctes.push(format!("  {name} as (\n    {body}\n  )"));
    }

    let last = format!("s{}", query.steps.len() - 1);
    Ok(format!(
        "with\n{}\nselect * from {last}\n",
        ctes.join(",\n")
    ))
}

/// dbt `source(schema, table)` — source name equals Postgres schema (see sources.yml).
fn pg_dbt_source_ref(schema: &str, table: &str) -> (String, String) {
    (sanitize_id(schema), sanitize_id(table))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export_manifest::hash_content;
    use crate::model::{JoinType, QueryDef, TransformationStep};
    use std::env::temp_dir;
    use std::fs;

    #[test]
    fn exports_join_workspace() {
        let dir = temp_dir().join(format!("dwh_dbt_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim_region".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "dim.csv".into(),
                    }],
                 execution: Default::default(),
},
                QueryDef {
                    id: "fact".into(),
                    name: "fact_sales".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: "fact.csv".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                 execution: Default::default(),
},
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };

        let path = DbtProducer
            .produce(
                "demo",
                &ws,
                dir.to_str().unwrap(),
                DbtTarget::V1,
                WarehouseDialect::Duckdb,
            )
            .unwrap();
        assert!(Path::new(&path).join("dbt_project.yml").exists());
        assert!(Path::new(&path).join("profiles.yml").exists());
        let project = std::fs::read_to_string(Path::new(&path).join("dbt_project.yml")).unwrap();
        assert!(!project.contains("require-dbt-version"));
        // YAML indent: models.<name> at 2 spaces, folder keys at 4, +materialized at 6.
        assert!(project.contains("models:\n  demo:\n    staging:\n      +materialized: view\n"));
        let profiles = std::fs::read_to_string(Path::new(&path).join("profiles.yml")).unwrap();
        assert!(profiles.contains("type: duckdb"));
        assert!(Path::new(&path)
            .join("models/staging/stg_dim_region.sql")
            .exists());
        assert!(Path::new(&path)
            .join("models/marts/mart_fact_sales.sql")
            .exists());
        let mart = std::fs::read_to_string(
            Path::new(&path).join("models/marts/mart_fact_sales.sql"),
        )
        .unwrap();
        assert!(mart.contains("ref('stg_dim_region')"));

        let v2 = DbtProducer.produce(
            "demo_v2",
            &ws,
            dir.to_str().unwrap(),
            DbtTarget::V2,
            WarehouseDialect::Duckdb,
        );
        assert!(v2.is_err());
    }

    #[test]
    fn explicit_layer_prefix_not_doubled() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "stg_sales".into(),
                steps: vec![TransformationStep::LoadCsv {
                    path: "x.csv".into(),
                }],
             execution: Default::default(),
}],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let q = ws.query("q").unwrap();
        assert_eq!(dbt_model_name(&ws, q, &[]), "stg_sales");
    }

    #[test]
    fn files_plus_postgres_dialect_routes_to_duckdb_engine() {
        let dir = temp_dir().join(format!("dwh_files_pg_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv {
                    path: "sales.csv".into(),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let path = DbtProducer
            .produce_with_seeds(
                "files_to_pg",
                &ws,
                dir.to_str().unwrap(),
                DbtTarget::V1,
                WarehouseDialect::Postgres,
                &HashMap::new(),
            )
            .expect("Files→PG via duckdb engine must not require landing");
        let profiles = fs::read_to_string(Path::new(&path).join("profiles.yml")).unwrap();
        assert!(
            profiles.contains("type: duckdb") && profiles.contains("attach:"),
            "expected dbt-duckdb + PG attach, got:\n{profiles}"
        );
        let proj = fs::read_to_string(Path::new(&path).join("dbt_project.yml")).unwrap();
        assert!(
            proj.contains("+database: pg") && proj.contains("+schema: public"),
            "marts must materialize into ATTACH catalog pg, got:\n{proj}"
        );
        assert!(
            Path::new(&path)
                .join("macros/generate_schema_name.sql")
                .is_file(),
            "need generate_schema_name so PG schema is public not main_public"
        );
        assert!(Path::new(&path).join("README.destination.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn postgres_sources_grouped_by_schema() {
        let dir = temp_dir().join(format!("dwh_dbt_pg_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "a".into(),
                    name: "sys_data_source_items".into(),
                    steps: vec![TransformationStep::LoadPostgres {
                        connection_id: Some("pg".into()),
                        connection_string: String::new(),
                        schema: "sys".into(),
                        table_name: "data_source_items".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "b".into(),
                    name: "sys_data_extraction_sources".into(),
                    steps: vec![TransformationStep::LoadPostgres {
                        connection_id: Some("pg".into()),
                        connection_string: String::new(),
                        schema: "sys".into(),
                        table_name: "data_extraction_sources".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "c".into(),
                    name: "sys_data_extraction_sources_derived".into(),
                    steps: vec![TransformationStep::FromQuery {
                        query_id: "b".into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "c".into(),
            key_maps: vec![],
        };

        let path = DbtProducer
            .produce(
                "demo_sales",
                &ws,
                dir.to_str().unwrap(),
                DbtTarget::V1,
                WarehouseDialect::Postgres,
            )
            .unwrap();
        let sources = std::fs::read_to_string(Path::new(&path).join("models/sources.yml")).unwrap();
        assert!(sources.contains("  - name: sys\n    schema: sys\n    tables:\n"));
        assert!(sources.contains("      - name: data_source_items\n"));
        assert!(sources.contains("      - name: data_extraction_sources\n"));
        assert!(!sources.contains("postgres_raw"));
        let stg = std::fs::read_to_string(
            Path::new(&path).join("models/staging/stg_sys_data_source_items.sql"),
        )
        .unwrap();
        assert_eq!(
            stg.trim(),
            "select * from {{ source('sys', 'data_source_items') }}"
        );
        let profiles = std::fs::read_to_string(Path::new(&path).join("profiles.yml")).unwrap();
        assert!(profiles.contains("type: postgres"));
        assert!(profiles.contains("user: postgres"));
        assert!(
            profiles.contains("type: postgres") && profiles.contains("DWH_PG_PASSWORD"),
            "postgres profiles should use env secret, got:\n{profiles}"
        );
        assert!(profiles.contains("dbname: dwh"));
        assert!(profiles.contains("schema: sys"));
    }

    #[test]
    fn postgres_rename_then_append_with_seeds_uses_portable_sql() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "eu".into(),
                    name: "sales_eu".into(),
                    steps: vec![TransformationStep::LoadPostgres {
                        connection_id: Some("pg".into()),
                        connection_string: String::new(),
                        schema: "sales".into(),
                        table_name: "eu".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "us".into(),
                    name: "sales_us".into(),
                    steps: vec![TransformationStep::LoadPostgres {
                        connection_id: Some("pg".into()),
                        connection_string: String::new(),
                        schema: "sales".into(),
                        table_name: "us".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "all".into(),
                    name: "sales_all".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "eu".into(),
                        },
                        TransformationStep::RenameColumn {
                            from: "amt".into(),
                            to: "amount".into(),
                        },
                        TransformationStep::Append {
                            other_query_ids: vec!["us".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "all".into(),
            key_maps: vec![],
        };

        let mut seeds = HashMap::new();
        seeds.insert("eu".into(), vec!["id".into(), "amt".into()]);
        seeds.insert(
            "us".into(),
            vec!["id".into(), "amount".into(), "currency".into()],
        );

        let sql = preview_dbt_model_sql_with_seeds(&ws, "all", WarehouseDialect::Postgres, &seeds)
            .unwrap()
            .sql;
        assert!(!sql.contains("UNION ALL SELECT *"));
        assert!(!sql.contains("_lmap"), "schema path must not need jinja maps");
        assert!(sql.contains("\"amt\" AS \"amount\""));
        assert!(sql.contains("NULL AS \"currency\""));
        assert!(sql.contains("ref('stg_sales_us')"));

        // Without seeds, Append after Rename still refuses (no left_dbt, no schema).
        let err = preview_dbt_model_sql(&ws, "all", WarehouseDialect::Postgres).unwrap_err();
        assert!(
            err.contains("left relation") || err.contains("schema"),
            "unexpected err: {err}"
        );
    }

    #[test]
    fn model_names_stable_when_unrelated_query_added() {
        let mut ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim_region".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "dim.csv".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact_sales".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: "fact.csv".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let before = dbt_model_names(&ws).unwrap();
        assert_eq!(before.get("dim").unwrap(), "stg_dim_region");
        assert_eq!(before.get("fact").unwrap(), "mart_fact_sales");

        ws.queries.push(QueryDef {
            id: "extra".into(),
            name: "orphan_csv".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "extra.csv".into(),
            }],
            execution: Default::default(),
        });
        let after = dbt_model_names(&ws).unwrap();
        assert_eq!(after.get("dim"), before.get("dim"));
        assert_eq!(after.get("fact"), before.get("fact"));
        assert_eq!(after.get("extra").unwrap(), "stg_orphan_csv");
    }

    #[test]
    fn published_outputs_mark_multiple_marts() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "daily".into(),
                    name: "daily_pnl".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "a.csv".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "monthly".into(),
                    name: "monthly_pnl".into(),
                    steps: vec![TransformationStep::FromQuery {
                        query_id: "daily".into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "daily".into(),
            key_maps: vec![],
        };
        let n_focus = dbt_model_names(&ws).unwrap();
        assert_eq!(n_focus.get("daily").unwrap(), "mart_daily_pnl");
        assert_eq!(n_focus.get("monthly").unwrap(), "int_monthly_pnl");
        let published = vec!["daily".into(), "monthly".into()];
        let n_pub = dbt_model_names_published(&ws, &published).unwrap();
        assert_eq!(n_pub.get("daily").unwrap(), "mart_daily_pnl");
        assert_eq!(n_pub.get("monthly").unwrap(), "mart_monthly_pnl");
    }

    #[test]
    fn focus_change_only_swaps_mart_prefix_on_involved_queries() {
        let mut ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "a".into(),
                    name: "sales_eu".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "eu.csv".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "b".into(),
                    name: "sales_us".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "us.csv".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "all".into(),
                    name: "sales_all".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "a".into(),
                        },
                        TransformationStep::Append {
                            other_query_ids: vec!["b".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "all".into(),
            key_maps: vec![],
        };
        let n1 = dbt_model_names(&ws).unwrap();
        assert_eq!(n1.get("a").unwrap(), "stg_sales_eu");
        assert_eq!(n1.get("b").unwrap(), "stg_sales_us");
        assert_eq!(n1.get("all").unwrap(), "mart_sales_all");

        ws.focus_query_id = "a".into();
        let n2 = dbt_model_names(&ws).unwrap();
        assert_eq!(n2.get("b").unwrap(), "stg_sales_us", "unrelated staging stays");
        assert_eq!(n2.get("a").unwrap(), "mart_sales_eu");
        assert_eq!(n2.get("all").unwrap(), "int_sales_all");
    }

    #[test]
    fn noop_reexport_hash_stable() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv {
                    path: "x.csv".into(),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let plan1 = build_export_plan(
            "stable",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        let plan2 = build_export_plan(
            "stable",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan1, plan2);
        for (path, body) in &plan1 {
            assert_eq!(hash_content(body), hash_content(plan2.get(path).unwrap()));
        }
    }

    #[test]
    fn keymap_export_writes_seed_and_ref() {
        use crate::model::{KeyMapDef, KeyMapEntry};
        let mut map = KeyMapDef::new("channel_alias", "channel");
        map.entries = vec![KeyMapEntry {
            from: "www".into(),
            to: "web".into(),
            ..Default::default()
        }];
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "sales".into(),
                steps: vec![
                    TransformationStep::LoadCsv {
                        path: "x.csv".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "channel".into(),
                        map_id: map.id.clone(),
                        entries: map.entries.clone(),
                    },
                ],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        };
        let plan = build_export_plan(
            "keymap_demo",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        assert!(plan.contains_key("seeds/map_channel_alias.csv"));
        assert!(plan["dbt_project.yml"].contains("seed-paths"));
        assert!(
            plan["dbt_project.yml"].contains("+column_types"),
            "seeds must force varchar column_types so codes like 001 stay strings"
        );
        assert!(
            plan["dbt_project.yml"].contains("seeds:\n  keymap_demo:\n    map_"),
            "column_types must nest under project name, got:\n{}",
            plan["dbt_project.yml"]
        );
        assert!(plan["dbt_project.yml"].contains("from: varchar"));
        let seed = &plan["seeds/map_channel_alias.csv"];
        assert!(seed.contains("www") && seed.contains("web"));
        let model = plan
            .iter()
            .find(|(p, _)| p.ends_with("stg_sales.sql") || p.ends_with("mart_sales.sql"))
            .map(|(_, b)| b.as_str())
            .expect("sales model");
        assert!(
            model.contains("ref('map_channel_alias')"),
            "expected seed ref in model, got:\n{model}"
        );
        let plan2 = build_export_plan(
            "keymap_demo",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            plan["seeds/map_channel_alias.csv"],
            plan2["seeds/map_channel_alias.csv"]
        );
    }

    #[test]
    fn keymap_source_storage_lands_in_sources_yml() {
        use crate::model::{KeyMapDef, KeyMapEntry, KeyMapStorage};
        let mut map = KeyMapDef::new("dict_aliases", "dict");
        map.storage = KeyMapStorage::Source {
            source: "dict".into(),
            table: "aliases".into(),
            connection_id: Some("pg1".into()),
        };
        map.entries = vec![KeyMapEntry {
            from: "www".into(),
            to: "web".into(),
            ..Default::default()
        }];
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "sales".into(),
                steps: vec![
                    TransformationStep::LoadCsv {
                        path: "x.csv".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "channel".into(),
                        map_id: map.id.clone(),
                        entries: map.entries.clone(),
                    },
                ],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        };
        let plan = build_export_plan(
            "keymap_src",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        let sources = &plan["models/sources.yml"];
        assert!(
            sources.contains("name: dict") && sources.contains("name: aliases"),
            "expected KeyMap source in sources.yml, got:\n{sources}"
        );
        let model = plan
            .iter()
            .find(|(p, _)| p.ends_with(".sql"))
            .map(|(_, b)| b.as_str())
            .expect("model");
        assert!(
            model.contains("source('dict', 'aliases')"),
            "expected source() in model, got:\n{model}"
        );
    }
}
