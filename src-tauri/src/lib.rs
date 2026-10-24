use dwh_engine::{
    preview_pipeline as run_preview_steps, preview_workspace as run_preview_workspace, DbSession,
    PreviewResult,
};
use dwh_pipeline::{DbtProducer, OutputProducer, TransformationStep, Workspace};
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
) -> Result<String, String> {
    DbtProducer.produce(&pipeline_name, &workspace, &output_dir)
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
            export_dbt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
