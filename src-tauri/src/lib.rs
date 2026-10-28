use dwh_engine::{
    collect_load_seeds, describe_postgres_object as run_describe_postgres_object,
    explain_join_rows as run_explain_join_rows, join_diagnostics as run_join_diagnostics,
    list_postgres_objects as run_list_postgres_objects, preview_pipeline as run_preview_steps,
    preview_workspace as run_preview_workspace, set_extensions_dir,
    test_postgres_connection as run_test_postgres_connection, DbSession, ExplainJoinRowsResult,
    JoinDiagnostics, JoinKeyTuple, PostgresColumn, PostgresObject, PreviewResult,
};
mod secrets_io;
mod settings_io;

use dwh_pipeline::{
    dbt_parse, list_export_tree as walk_export_tree, preview_dbt_model_sql,
    preview_dbt_model_sql_with_seeds, resolve_dbt_bin, ConnectionDef, DbtProducer, DbtTarget,
    ExportResult, PreviewDbtModel, Project, QueryDef, TransformationStep, WarehouseDialect,
    Workspace,
};
use settings_io::AppSettings;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, State};

static FIXTURES_DIR: OnceLock<PathBuf> = OnceLock::new();

fn set_fixtures_dir(dir: PathBuf) {
    let _ = FIXTURES_DIR.set(dir);
}

fn fixtures_dir_complete(dir: &Path) -> bool {
    dir.join("sample.csv").is_file()
        && dir.join("dim_region.csv").is_file()
        && dir.join("sales_eu.csv").is_file()
        && dir.join("sales_us.csv").is_file()
}

/// App-level session (survives relaunch) — last opened/saved project path.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct AppSession {
    #[serde(default)]
    last_project_path: Option<String>,
}

fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

fn remember_project_path(app: &AppHandle, path: &str) -> Result<(), String> {
    let file = session_file(app)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let session = AppSession {
        last_project_path: Some(path.to_string()),
    };
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn preview_pipeline(
    steps: Vec<TransformationStep>,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<PreviewResult, String> {
    let conns = connections.unwrap_or_default();
    run_preview_steps(&db, &steps, &conns)
}

#[tauri::command]
fn preview_workspace(
    workspace: Workspace,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<PreviewResult, String> {
    let conns = connections.unwrap_or_default();
    run_preview_workspace(&db, &workspace, &conns)
}

/// Join investigation diagnostics (DESIGN §9). Full-input counts + bounded samples.
#[tauri::command]
fn join_diagnostics(
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<JoinDiagnostics, String> {
    let conns = connections.unwrap_or_default();
    run_join_diagnostics(&db, &workspace, &conns, &host_query_id, join_step_index)
}

/// Join Lens: batch where-provenance (keys and/or preview row offsets).
#[tauri::command]
fn explain_join_rows(
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    keys: Option<Vec<JoinKeyTuple>>,
    preview_offsets: Option<Vec<u64>>,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<ExplainJoinRowsResult, String> {
    let conns = connections.unwrap_or_default();
    let key_slice = keys.unwrap_or_default();
    run_explain_join_rows(
        &db,
        &workspace,
        &conns,
        &host_query_id,
        join_step_index,
        &key_slice,
        preview_offsets.as_deref(),
    )
}

/// dbt model SQL for one query (Model tab). Seeds from DuckDB/PG when available.
#[tauri::command]
fn preview_dbt_model(
    workspace: Workspace,
    query_id: String,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<PreviewDbtModel, String> {
    let dialect = target_dialect.unwrap_or_default();
    let conns = connections.unwrap_or_default();
    let seeds = collect_load_seeds(&db, &workspace, &conns).unwrap_or_default();
    if seeds.is_empty() {
        preview_dbt_model_sql(&workspace, &query_id, dialect)
    } else {
        preview_dbt_model_sql_with_seeds(&workspace, &query_id, dialect, &seeds)
    }
}

fn tauri_dbt_bin_candidates(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut extra = Vec::new();
    if let Some(app) = app {
        if let Ok(rd) = app.path().resource_dir() {
            extra.push(rd.join("dbt-venv/bin/dbt"));
        }
        if let Ok(ad) = app.path().app_data_dir() {
            extra.push(ad.join("dbt-venv/bin/dbt"));
        }
    }
    // Dev checkout: next to src-tauri crate.
    extra.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dbt-venv/bin/dbt"));
    extra
}

#[tauri::command]
fn export_dbt(
    app: AppHandle,
    pipeline_name: String,
    workspace: Workspace,
    output_dir: String,
    dbt_target: Option<DbtTarget>,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
    db: State<'_, DbSession>,
) -> Result<ExportResult, String> {
    let target = dbt_target.unwrap_or(DbtTarget::V1);
    let dialect = target_dialect.unwrap_or_default();
    let conns = connections.unwrap_or_default();
    let seeds = collect_load_seeds(&db, &workspace, &conns).unwrap_or_default();
    let path = DbtProducer.produce_with_seeds(
        &pipeline_name,
        &workspace,
        &output_dir,
        target,
        dialect,
        &seeds,
    )?;
    let files = walk_export_tree(&path)?;
    let mut result = ExportResult::with_files(path.clone(), files);

    // Author-first: always offline-validate with `dbt parse` (no warehouse).
    // Files stay on disk even when parse fails or dbt is missing.
    let candidates = tauri_dbt_bin_candidates(Some(&app));
    let bin = resolve_dbt_bin(&candidates);
    let outcome = dbt_parse(&path, bin.as_deref());
    result.dbt_parse_ok = outcome.ok;
    result.dbt_parse_log = outcome.log;
    Ok(result)
}

#[tauri::command]
fn list_export_tree(path: String) -> Result<Vec<String>, String> {
    walk_export_tree(&path)
}

#[tauri::command]
fn list_postgres_objects(
    connection_string: String,
    db: State<'_, DbSession>,
) -> Result<Vec<PostgresObject>, String> {
    run_list_postgres_objects(&db, &connection_string)
}

#[tauri::command]
fn describe_postgres_object(
    connection_string: String,
    schema: String,
    table_name: String,
    db: State<'_, DbSession>,
) -> Result<Vec<PostgresColumn>, String> {
    run_describe_postgres_object(&db, &connection_string, &schema, &table_name)
}

#[tauri::command]
fn test_postgres_connection(
    connection_string: String,
    db: State<'_, DbSession>,
) -> Result<(), String> {
    run_test_postgres_connection(&db, &connection_string)
}

#[tauri::command]
fn save_project(app: AppHandle, path: String, project: Project) -> Result<(), String> {
    secrets_io::save_project_with_secrets(&path, &project)?;
    remember_project_path(&app, &path)?;
    Ok(())
}

#[tauri::command]
fn load_project(app: AppHandle, path: String) -> Result<Project, String> {
    let mut project = secrets_io::load_project_with_secrets(&path)?;
    project.root_path = Some(path.clone());
    let _ = remember_project_path(&app, &path);
    Ok(project)
}

/// Path of the last Save/Open project, if the file still exists.
#[tauri::command]
fn get_last_project_path(app: AppHandle) -> Result<Option<String>, String> {
    let file = session_file(&app)?;
    if !file.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let session: AppSession = serde_json::from_str(&raw).unwrap_or_default();
    Ok(session
        .last_project_path
        .filter(|p| PathBuf::from(p).is_file()))
}

/// App defaults / last-used (`~/.dwhforge-query/settings.json`).
#[tauri::command]
fn get_app_settings() -> Result<AppSettings, String> {
    settings_io::load_settings()
}

#[tauri::command]
fn set_app_settings(settings: AppSettings) -> Result<(), String> {
    settings_io::save_settings(&settings)
}

fn fixture_csv(fixtures: &std::path::Path, name: &str) -> Result<String, String> {
    fixtures
        .join(name)
        .canonicalize()
        .map_err(|e| format!("fixture {name}: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Medallion + fan-out (A1–A8, A12). Query names have no layer prefix —
/// `stg_`/`int_`/`mart_` are added only at dbt export. See docs/DEMOS.md.
fn demo_sales(fixtures: &std::path::Path) -> Result<Workspace, String> {
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
        // Focus → mart_* at export; other non-Load queries → int_*.
        focus_query_id: "top_by_region".into(),
    })
}

/// Multi-feed Append (A1, A5, A9, A12).
fn demo_union(fixtures: &std::path::Path) -> Result<Workspace, String> {
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

/// SqlModel + CustomSql window + ref (A2, A10, A11, A12; B2 via CustomSql).
fn demo_sql(fixtures: &std::path::Path) -> Result<Workspace, String> {
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

/// `sales` | `union` | `sql` — see docs/DEMOS.md.
#[tauri::command]
fn load_demo_workspace(name: String) -> Result<Workspace, String> {
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

/// Compat: same as `load_demo_workspace("sales")`.
#[tauri::command]
fn load_sample_workspace() -> Result<Workspace, String> {
    load_demo_workspace("sales".into())
}

fn find_fixtures_dir() -> Result<PathBuf, String> {
    if let Some(dir) = FIXTURES_DIR.get() {
        if fixtures_dir_complete(dir) {
            return Ok(dir.clone());
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Portable zip / next to binary
            candidates.push(parent.join("fixtures"));
            // Some installers nest resources under resources/
            candidates.push(parent.join("resources").join("fixtures"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fixtures"));
        candidates.push(cwd.join("../fixtures"));
    }
    // Dev checkout
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures"));

    for candidate in candidates {
        if fixtures_dir_complete(&candidate) {
            return Ok(candidate);
        }
    }
    Err(
        "Could not find fixtures/ (sample, dim_region, sales_eu, sales_us) — \
         expected next to the app binary or in the install resources"
            .into(),
    )
}

/// Prefer packaged resources, then folder next to the binary, then repo `fixtures/`.
fn configure_fixtures_dir(app: &tauri::App) {
    if let Ok(rd) = app.path().resource_dir() {
        let fixtures = rd.join("fixtures");
        if fixtures_dir_complete(&fixtures) {
            eprintln!(
                "[dwh-rs-query] fixtures (bundle resources): {}",
                fixtures.display()
            );
            set_fixtures_dir(fixtures);
            return;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let fixtures = parent.join("fixtures");
            if fixtures_dir_complete(&fixtures) {
                eprintln!(
                    "[dwh-rs-query] fixtures (beside binary): {}",
                    fixtures.display()
                );
                set_fixtures_dir(fixtures);
                return;
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    if fixtures_dir_complete(&dev) {
        eprintln!(
            "[dwh-rs-query] fixtures (dev repo): {}",
            dev.display()
        );
        set_fixtures_dir(dev);
    } else {
        eprintln!(
            "[dwh-rs-query] WARNING: no fixtures/ — demos will fail until CSV samples are shipped beside the app"
        );
    }
}

/// Prefer packaged resources, then folder next to the binary, then dev `src-tauri/extensions`.
fn configure_extensions_dir(app: &tauri::App) {
    if let Ok(rd) = app.path().resource_dir() {
        let ext = rd.join("extensions");
        if ext.is_dir() {
            eprintln!(
                "[dwh-rs-query] DuckDB extensions (bundle resources): {}",
                ext.display()
            );
            set_extensions_dir(ext);
            return;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let ext = parent.join("extensions");
            if ext.is_dir() {
                eprintln!(
                    "[dwh-rs-query] DuckDB extensions (beside binary): {}",
                    ext.display()
                );
                set_extensions_dir(ext);
                return;
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("extensions");
    if dev.is_dir() {
        eprintln!(
            "[dwh-rs-query] DuckDB extensions (dev src-tauri/extensions): {}",
            dev.display()
        );
        set_extensions_dir(dev);
    } else {
        eprintln!(
            "[dwh-rs-query] WARNING: no extensions/ folder — run scripts/fetch-duckdb-extensions.sh"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            configure_extensions_dir(app);
            configure_fixtures_dir(app);
            let session = DbSession::new().map_err(|e| {
                eprintln!("[dwh-rs-query] DuckDB session failed: {e}");
                Box::<dyn std::error::Error>::from(e)
            })?;
            app.manage(session);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            preview_pipeline,
            preview_workspace,
            join_diagnostics,
            explain_join_rows,
            preview_dbt_model,
            export_dbt,
            list_export_tree,
            load_demo_workspace,
            load_sample_workspace,
            list_postgres_objects,
            describe_postgres_object,
            test_postgres_connection,
            save_project,
            load_project,
            get_last_project_path,
            get_app_settings,
            set_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod demo_tests {
    use super::*;
    use dwh_pipeline::GraphCompiler;

    #[test]
    fn all_demos_compile() {
        for name in ["sales", "union", "sql"] {
            let ws = load_demo_workspace(name.into()).expect(name);
            GraphCompiler::new(&ws)
                .to_sql(false)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }
}
