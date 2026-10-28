//! Command dispatch — same surface as the former Tauri invoke API (camelCase args).

use crate::connections_io;
use crate::secrets_io;
use crate::settings_io::{self, AppSettings};
use dwh_engine::{
    collect_load_seeds, describe_postgres_object as run_describe_postgres_object,
    explain_join_rows as run_explain_join_rows, join_diagnostics as run_join_diagnostics,
    list_postgres_objects as run_list_postgres_objects, preview_pipeline as run_preview_steps,
    preview_workspace as run_preview_workspace, set_extensions_dir,
    test_postgres_connection as run_test_postgres_connection, DbSession, ExplainJoinRowsResult,
    JoinDiagnostics, JoinKeyTuple, PostgresColumn, PostgresObject, PreviewResult,
};
use dwh_pipeline::{
    dbt_parse, list_export_tree as walk_export_tree, preview_dbt_model_sql,
    preview_dbt_model_sql_with_seeds, resolve_dbt_bin, ConnectionDef, DbtProducer, DbtTarget,
    ExportResult, PreviewDbtModel, Project, QueryDef, TransformationStep, WarehouseDialect,
    Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static FIXTURES_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AppSession {
    #[serde(default)]
    last_project_path: Option<String>,
}

fn session_file() -> Result<PathBuf, String> {
    Ok(secrets_io::dwh_home_dir()?.join("session.json"))
}

fn remember_project_path(path: &str) -> Result<(), String> {
    let file = session_file()?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let session = AppSession {
        last_project_path: Some(path.to_string()),
    };
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

fn fixtures_dir_complete(dir: &Path) -> bool {
    dir.join("sample.csv").is_file()
        && dir.join("dim_region.csv").is_file()
        && dir.join("sales_eu.csv").is_file()
        && dir.join("sales_us.csv").is_file()
}

fn set_fixtures_dir(dir: PathBuf) {
    let _ = FIXTURES_DIR.set(dir);
}

/// Resolve extensions + fixtures from env / beside binary / repo.
pub fn configure_paths() {
    if let Ok(ext) = std::env::var("DWH_EXTENSIONS_DIR") {
        let p = PathBuf::from(ext);
        if p.is_dir() {
            eprintln!("[dwh-host] extensions (env): {}", p.display());
            set_extensions_dir(p);
        }
    } else if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("extensions"),
                parent.join("resources").join("extensions"),
            ] {
                if cand.is_dir() {
                    eprintln!("[dwh-host] extensions: {}", cand.display());
                    set_extensions_dir(cand);
                    break;
                }
            }
        }
    }
    if FIXTURES_DIR.get().is_none() {
        // fall through — find later
    }

    if let Ok(fx) = std::env::var("DWH_FIXTURES_DIR") {
        let p = PathBuf::from(fx);
        if fixtures_dir_complete(&p) {
            eprintln!("[dwh-host] fixtures (env): {}", p.display());
            set_fixtures_dir(p);
            return;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("fixtures"),
                parent.join("resources").join("fixtures"),
            ] {
                if fixtures_dir_complete(&cand) {
                    eprintln!("[dwh-host] fixtures: {}", cand.display());
                    set_fixtures_dir(cand);
                    return;
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    if fixtures_dir_complete(&dev) {
        eprintln!("[dwh-host] fixtures (dev): {}", dev.display());
        set_fixtures_dir(dev);
    }
    let dev_ext = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extensions");
    if std::env::var_os("DWH_EXTENSIONS_DIR").is_none() && dev_ext.is_dir() {
        set_extensions_dir(dev_ext);
    }
}

fn find_fixtures_dir() -> Result<PathBuf, String> {
    if let Some(dir) = FIXTURES_DIR.get() {
        if fixtures_dir_complete(dir) {
            return Ok(dir.clone());
        }
    }
    configure_paths();
    FIXTURES_DIR
        .get()
        .cloned()
        .filter(|d| fixtures_dir_complete(d))
        .ok_or_else(|| {
            "Could not find fixtures/ (sample, dim_region, sales_eu, sales_us)".into()
        })
}

fn dbt_bin_candidates() -> Vec<PathBuf> {
    let mut extra = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            extra.push(parent.join("dbt-venv/bin/dbt"));
            extra.push(parent.join("resources").join("dbt-venv/bin/dbt"));
        }
    }
    if let Ok(home) = secrets_io::dwh_home_dir() {
        extra.push(home.join("dbt-venv/bin/dbt"));
    }
    extra.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dbt-venv/bin/dbt"));
    extra
}

fn fixture_csv(fixtures: &Path, name: &str) -> Result<String, String> {
    fixtures
        .join(name)
        .canonicalize()
        .map_err(|e| format!("fixture {name}: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

fn demo_sales(fixtures: &Path) -> Result<Workspace, String> {
    let fact = fixture_csv(fixtures, "sample.csv")?;
    let dim = fixture_csv(fixtures, "dim_region.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "dim_region".into(),
                name: "dim_region".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv { path: fact }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_clean".into(),
                name: "sales_clean".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::RenameColumn {
                        from: "amount".into(),
                        to: "revenue".into(),
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "date".into(),
                            "region".into(),
                            "revenue".into(),
                            "qty".into(),
                        ],
                    },
                    TransformationStep::DeriveColumn {
                        name: "amount_per_unit".into(),
                        expression: "revenue / nullif(qty, 0)".into(),
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "fact_sales".into(),
                name: "fact_sales".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_region".into(),
                        join_type: dwh_pipeline::JoinType::Inner,
                        left_on: vec!["region".into()],
                        right_on: vec!["region".into()],
                    },
                    TransformationStep::Filter {
                        condition: "amount > 1000".into(),
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "top_sales".into(),
                name: "top_sales".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::SortBy {
                        column: "qty".into(),
                        descending: true,
                    },
                    TransformationStep::Limit { n: 10 },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "top_by_region".into(),
                name: "top_by_region".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "fact_sales".into(),
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec!["region".into()],
                        aggregates: vec![
                            "sum(qty) as qty".into(),
                            "sum(amount) as amount".into(),
                            "count(*) as n_rows".into(),
                        ],
                    },
                    TransformationStep::SortBy {
                        column: "qty".into(),
                        descending: true,
                    },
                    TransformationStep::Limit { n: 10 },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "top_by_region".into(),
    })
}

fn demo_union(fixtures: &Path) -> Result<Workspace, String> {
    let eu = fixture_csv(fixtures, "sales_eu.csv")?;
    let us = fixture_csv(fixtures, "sales_us.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "sales_eu".into(),
                name: "sales_eu".into(),
                steps: vec![TransformationStep::LoadCsv { path: eu }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_us".into(),
                name: "sales_us".into(),
                steps: vec![TransformationStep::LoadCsv { path: us }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_all".into(),
                name: "sales_all".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_eu".into(),
                    },
                    TransformationStep::Append {
                        other_query_ids: vec!["sales_us".into()],
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "by_region".into(),
                name: "by_region".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_all".into(),
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec!["region".into()],
                        aggregates: vec![
                            "sum(qty) as qty".into(),
                            "sum(amount) as amount".into(),
                            "count(*) as n_rows".into(),
                        ],
                    },
                    TransformationStep::SortBy {
                        column: "amount".into(),
                        descending: true,
                    },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "by_region".into(),
    })
}

fn demo_sql(fixtures: &Path) -> Result<Workspace, String> {
    let fact = fixture_csv(fixtures, "sample.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "calendar".into(),
                name: "calendar".into(),
                steps: vec![TransformationStep::SqlModel {
                    raw_sql: "select * from (values \
                        (date '2024-01-01', 'EU'), \
                        (date '2024-01-02', 'US'), \
                        (date '2024-01-03', 'EU'), \
                        (date '2024-01-04', 'APAC'), \
                        (date '2024-01-05', 'EU'), \
                        (date '2024-01-06', 'US'), \
                        (date '2024-01-07', 'EU'), \
                        (date '2024-01-08', 'APAC'), \
                        (date '2024-01-09', 'EU'), \
                        (date '2024-01-10', 'US')\
                    ) as t(day, region)"
                        .into(),
                }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv { path: fact }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_enriched".into(),
                name: "sales_enriched".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::CustomSql {
                        raw_sql: "select *, row_number() over (\
                            partition by region order by amount desc\
                        ) as region_rank from {{prev_step}}"
                            .into(),
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_top3".into(),
                name: "sales_top3".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_enriched".into(),
                    },
                    TransformationStep::Filter {
                        condition: "region_rank <= 3".into(),
                    },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "sales_enriched".into(),
    })
}

fn load_demo_workspace(name: &str) -> Result<Workspace, String> {
    let fixtures = find_fixtures_dir()?;
    match name.trim().to_ascii_lowercase().as_str() {
        "sales" | "sample" | "" => demo_sales(&fixtures),
        "union" => demo_union(&fixtures),
        "sql" | "sql_hybrid" | "hybrid" => demo_sql(&fixtures),
        other => Err(format!(
            "Unknown demo '{other}'. Use: sales | union | sql"
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArgs {
    workspace: Option<Workspace>,
    steps: Option<Vec<TransformationStep>>,
    connections: Option<Vec<ConnectionDef>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinDiagArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    connections: Option<Vec<ConnectionDef>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    keys: Option<Vec<JoinKeyTuple>>,
    preview_offsets: Option<Vec<u64>>,
    connections: Option<Vec<ConnectionDef>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDbtArgs {
    workspace: Workspace,
    query_id: String,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportArgs {
    pipeline_name: String,
    workspace: Workspace,
    output_dir: String,
    dbt_target: Option<DbtTarget>,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnStrArgs {
    connection_string: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DescribeArgs {
    connection_string: String,
    schema: String,
    table_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProjectArgs {
    path: String,
    project: Project,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsArgs {
    settings: AppSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalConnectionsArgs {
    connections: Vec<ConnectionDef>,
}

/// Small LRU for structural DuckDB previews (LIMIT 50). Avoids recompile+rerun
/// when the UI re-requests the same workspace (step select, tab switch, Lens).
struct PreviewCache {
    map: HashMap<u64, Value>,
    order: Vec<u64>,
    capacity: usize,
}

impl PreviewCache {
    fn new(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            capacity,
        }
    }

    fn get(&mut self, key: u64) -> Option<Value> {
        if !self.map.contains_key(&key) {
            return None;
        }
        self.order.retain(|k| *k != key);
        self.order.push(key);
        self.map.get(&key).cloned()
    }

    fn insert(&mut self, key: u64, value: Value) {
        if self.map.insert(key, value).is_none() {
            self.order.push(key);
        } else {
            self.order.retain(|k| *k != key);
            self.order.push(key);
        }
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.first().copied() {
                self.order.remove(0);
                self.map.remove(&old);
            } else {
                break;
            }
        }
    }
}

fn fingerprint_json(parts: &[&Value]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts {
        if let Ok(bytes) = serde_json::to_vec(p) {
            bytes.hash(&mut h);
        }
    }
    h.finish()
}

pub struct HostState {
    pub db: Mutex<DbSession>,
    preview_cache: Mutex<PreviewCache>,
}

impl HostState {
    pub fn new() -> Result<Self, String> {
        configure_paths();
        Ok(Self {
            db: Mutex::new(DbSession::new()?),
            preview_cache: Mutex::new(PreviewCache::new(8)),
        })
    }

    pub fn dispatch(&self, cmd: &str, args: Value) -> Result<Value, String> {
        match cmd {
            "preview_pipeline" => {
                let a: PreviewArgs =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                let steps = a.steps.ok_or("preview_pipeline: missing steps")?;
                let conns = a.connections.unwrap_or_default();
                let steps_v = serde_json::to_value(&steps).unwrap_or(Value::Null);
                let conns_v = serde_json::to_value(&conns).unwrap_or(Value::Null);
                let key = fingerprint_json(&[&Value::String("pipeline".into()), &steps_v, &conns_v]);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    if let Some(hit) = cache.get(key) {
                        return Ok(hit);
                    }
                }
                let db = self.db.lock().map_err(|e| e.to_string())?;
                let out: PreviewResult = run_preview_steps(&db, &steps, &conns)?;
                let val = serde_json::to_value(out).map_err(|e| e.to_string())?;
                drop(db);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    cache.insert(key, val.clone());
                }
                Ok(val)
            }
            "preview_workspace" => {
                let a: PreviewArgs =
                    serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                let ws = a.workspace.ok_or("preview_workspace: missing workspace")?;
                let conns = a.connections.unwrap_or_default();
                let ws_v = serde_json::to_value(&ws).unwrap_or(Value::Null);
                let conns_v = serde_json::to_value(&conns).unwrap_or(Value::Null);
                let key = fingerprint_json(&[&Value::String("workspace".into()), &ws_v, &conns_v]);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    if let Some(hit) = cache.get(key) {
                        return Ok(hit);
                    }
                }
                let db = self.db.lock().map_err(|e| e.to_string())?;
                let out = run_preview_workspace(&db, &ws, &conns)?;
                let val = serde_json::to_value(out).map_err(|e| e.to_string())?;
                drop(db);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    cache.insert(key, val.clone());
                }
                Ok(val)
            }
            _ => self.dispatch_locked(cmd, args),
        }
    }

    fn dispatch_locked(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        match cmd {
            "join_diagnostics" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let conns = a.connections.unwrap_or_default();
                let out: JoinDiagnostics = run_join_diagnostics(
                    &db,
                    &a.workspace,
                    &conns,
                    &a.host_query_id,
                    a.join_step_index,
                )?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "explain_join_rows" => {
                let a: ExplainArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let conns = a.connections.unwrap_or_default();
                let keys = a.keys.unwrap_or_default();
                let out: ExplainJoinRowsResult = run_explain_join_rows(
                    &db,
                    &a.workspace,
                    &conns,
                    &a.host_query_id,
                    a.join_step_index,
                    &keys,
                    a.preview_offsets.as_deref(),
                )?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "preview_dbt_model" => {
                let a: PreviewDbtArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let dialect = a.target_dialect.unwrap_or_default();
                let conns = a.connections.unwrap_or_default();
                let seeds = collect_load_seeds(&db, &a.workspace, &conns).unwrap_or_default();
                let out: PreviewDbtModel = if seeds.is_empty() {
                    preview_dbt_model_sql(&a.workspace, &a.query_id, dialect)?
                } else {
                    preview_dbt_model_sql_with_seeds(&a.workspace, &a.query_id, dialect, &seeds)?
                };
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "export_dbt" => {
                let a: ExportArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let target = a.dbt_target.unwrap_or(DbtTarget::V1);
                let dialect = a.target_dialect.unwrap_or_default();
                let conns = a.connections.unwrap_or_default();
                let seeds = collect_load_seeds(&db, &a.workspace, &conns).unwrap_or_default();
                let path = DbtProducer.produce_with_seeds(
                    &a.pipeline_name,
                    &a.workspace,
                    &a.output_dir,
                    target,
                    dialect,
                    &seeds,
                )?;
                let files = walk_export_tree(&path)?;
                let mut result = ExportResult::with_files(path.clone(), files);
                let candidates = dbt_bin_candidates();
                let bin = resolve_dbt_bin(&candidates);
                let outcome = dbt_parse(&path, bin.as_deref());
                result.dbt_parse_ok = outcome.ok;
                result.dbt_parse_log = outcome.log;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "list_export_tree" => {
                let a: PathArg = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = walk_export_tree(&a.path)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "list_postgres_objects" => {
                let a: ConnStrArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out: Vec<PostgresObject> =
                    run_list_postgres_objects(&db, &a.connection_string)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "describe_postgres_object" => {
                let a: DescribeArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out: Vec<PostgresColumn> = run_describe_postgres_object(
                    &db,
                    &a.connection_string,
                    &a.schema,
                    &a.table_name,
                )?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "test_postgres_connection" => {
                let a: ConnStrArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                run_test_postgres_connection(&db, &a.connection_string)?;
                Ok(Value::Null)
            }
            "save_project" => {
                drop(db);
                let a: SaveProjectArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                secrets_io::save_project_with_secrets(&a.path, &a.project)?;
                remember_project_path(&a.path)?;
                Ok(Value::Null)
            }
            "load_project" => {
                drop(db);
                let a: PathArg = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let mut project = secrets_io::load_project_with_secrets(&a.path)?;
                project.root_path = Some(a.path.clone());
                let _ = remember_project_path(&a.path);
                serde_json::to_value(project).map_err(|e| e.to_string())
            }
            "get_last_project_path" => {
                drop(db);
                let file = session_file()?;
                if !file.is_file() {
                    return Ok(Value::Null);
                }
                let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
                let session: AppSession = serde_json::from_str(&raw).unwrap_or_default();
                let path = session
                    .last_project_path
                    .filter(|p| PathBuf::from(p).is_file());
                serde_json::to_value(path).map_err(|e| e.to_string())
            }
            "get_app_settings" => {
                drop(db);
                let s = settings_io::load_settings()?;
                serde_json::to_value(s).map_err(|e| e.to_string())
            }
            "set_app_settings" => {
                drop(db);
                let a: SettingsArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                settings_io::save_settings(&a.settings)?;
                Ok(Value::Null)
            }
            "get_global_connections" => {
                drop(db);
                let conns = connections_io::load_global_connections()?;
                serde_json::to_value(conns).map_err(|e| e.to_string())
            }
            "set_global_connections" => {
                drop(db);
                let a: GlobalConnectionsArgs =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                connections_io::save_global_connections(&a.connections)?;
                Ok(Value::Null)
            }
            "load_demo_workspace" => {
                drop(db);
                let a: DemoArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = load_demo_workspace(&a.name)?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "load_sample_workspace" => {
                drop(db);
                let out = load_demo_workspace("sales")?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            other => Err(format!("unknown command '{other}'")),
        }
    }
}
