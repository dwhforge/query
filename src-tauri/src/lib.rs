use dwh_engine::{
    list_postgres_objects as run_list_postgres_objects,
    preview_pipeline as run_preview_steps, preview_workspace as run_preview_workspace,
    test_postgres_connection as run_test_postgres_connection, DbSession, PostgresObject,
    PreviewResult,
};
use dwh_pipeline::{
    DbtProducer, DbtTarget, OutputProducer, QueryDef, TransformationStep, Workspace,
};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
fn preview_pipeline(
    steps: Vec<TransformationStep>,
    db: State<'_, DbSession>,
) -> Result<PreviewResult, String> {
    run_preview_steps(&db, &steps)
}

#[tauri::command]
fn preview_workspace(
    workspace: Workspace,
    db: State<'_, DbSession>,
) -> Result<PreviewResult, String> {
    run_preview_workspace(&db, &workspace)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session = DbSession::new().expect("failed to open DuckDB session");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session)
        .invoke_handler(tauri::generate_handler![
            preview_pipeline,
            preview_workspace,
            export_dbt,
            load_sample_workspace,
            list_postgres_objects,
            test_postgres_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
