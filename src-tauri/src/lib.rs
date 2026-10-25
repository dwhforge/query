use dwh_engine::{
    list_postgres_objects as run_list_postgres_objects, set_extensions_dir,
    preview_pipeline as run_preview_steps, preview_workspace as run_preview_workspace,
    test_postgres_connection as run_test_postgres_connection, DbSession, PostgresObject,
    PreviewResult,
};
use dwh_pipeline::{
    ConnectionDef, DbtProducer, DbtTarget, OutputProducer, Project, QueryDef,
    TransformationStep, Workspace,
};
use std::fs;
use std::path::PathBuf;
use tauri::{Manager, State};

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

#[tauri::command]
fn export_dbt(
    pipeline_name: String,
    workspace: Workspace,
    output_dir: String,
    dbt_target: Option<DbtTarget>,
) -> Result<String, String> {
    let target = dbt_target.unwrap_or(DbtTarget::V1);
    DbtProducer.produce(&pipeline_name, &workspace, &output_dir, target)
}

#[tauri::command]
fn list_postgres_objects(
    connection_string: String,
    db: State<'_, DbSession>,
) -> Result<Vec<PostgresObject>, String> {
    run_list_postgres_objects(&db, &connection_string)
}

#[tauri::command]
fn test_postgres_connection(
    connection_string: String,
    db: State<'_, DbSession>,
) -> Result<(), String> {
    run_test_postgres_connection(&db, &connection_string)
}

#[tauri::command]
fn save_project(path: String, project: Project) -> Result<(), String> {
    let mut project = project;
    project.root_path = Some(path.clone());
    let json = project.to_json_pretty()?;
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_project(path: String) -> Result<Project, String> {
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut project = Project::from_json(&raw)?;
    project.root_path = Some(path);
    Ok(project)
}

/// Resolve repo fixtures and return a ready sample workspace (fact ⋈ dim).
#[tauri::command]
fn load_sample_workspace() -> Result<Workspace, String> {
    let fixtures = find_fixtures_dir()?;
    let fact = fixtures
        .join("sample.csv")
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let dim = fixtures
        .join("dim_region.csv")
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();

    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "dim_region".into(),
                name: "dim_region".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim }],
            },
            QueryDef {
                id: "fact_sales".into(),
                name: "fact_sales".into(),
                steps: vec![
                    TransformationStep::LoadCsv { path: fact },
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
            },
        ],
        focus_query_id: "fact_sales".into(),
    })
}

fn find_fixtures_dir() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    for candidate in [
        cwd.join("fixtures"),
        cwd.join("../fixtures"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures"),
    ] {
        if candidate.join("sample.csv").is_file() && candidate.join("dim_region.csv").is_file() {
            return Ok(candidate);
        }
    }
    Err("Could not find fixtures/sample.csv — run from the repo root".into())
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
            export_dbt,
            load_sample_workspace,
            list_postgres_objects,
            test_postgres_connection,
            save_project,
            load_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
