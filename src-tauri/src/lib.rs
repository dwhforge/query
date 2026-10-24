use dwh_engine::{preview_pipeline as run_preview, DbSession, PreviewResult};
use dwh_pipeline::TransformationStep;
use tauri::State;

#[tauri::command]
fn preview_pipeline(
    steps: Vec<TransformationStep>,
    db: State<'_, DbSession>,
) -> Result<PreviewResult, String> {
    run_preview(&db, &steps)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session = DbSession::new().expect("failed to open DuckDB session");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session)
        .invoke_handler(tauri::generate_handler![preview_pipeline])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
