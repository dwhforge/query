//! Schema-aware GraphCompiler prep shared by preview, Join diagnostics, prepare, explain, fuzzy.
//!
//! Always attach [`WorkspaceSchemas`] (Load* seeds + live SqlModel describe) so ApplyKeyMap
//! `output_column` overwrite vs append matches across consumers.

use crate::load_seeds::collect_load_seeds;
use crate::session::DbSession;
use dwh_pipeline::{
    infer_workspace_schemas_ex, CompiledCtes, ConnectionDef, GraphCompiler, SourceDef,
    TransformationStep, Workspace, WorkspaceSchemas,
};
use duckdb::arrow::record_batch::RecordBatch;
use std::collections::HashMap;

/// Infer schemas from Load* seeds, then fill SqlModel holes via `LIMIT 0` describe.
pub fn workspace_schemas(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> WorkspaceSchemas {
    let seeds = collect_load_seeds(db, workspace, connections, sources).unwrap_or_default();
    let sql_models = describe_sql_models(db, workspace);
    infer_workspace_schemas_ex(workspace, &seeds, &sql_models).unwrap_or_default()
}

/// GraphCompiler with sources, connections, and inferred schemas attached.
pub fn graph_compiler<'a>(
    workspace: &'a Workspace,
    connections: &'a [ConnectionDef],
    sources: &'a [SourceDef],
    schemas: &'a WorkspaceSchemas,
) -> GraphCompiler<'a> {
    GraphCompiler::new(workspace)
        .with_sources(sources)
        .with_connections(connections)
        .with_schemas(schemas)
}

/// Compile `root_id` + deps with schema-aware ApplyKeyMap emit.
pub fn compile_ctes_from(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    root_id: &str,
) -> Result<CompiledCtes, String> {
    let schemas = workspace_schemas(db, workspace, connections, sources);
    graph_compiler(workspace, connections, sources, &schemas).compile_ctes_from(root_id)
}

/// Preview/export SQL for the focus query (schema-aware).
pub fn compile_focus_sql(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    is_preview: bool,
) -> Result<String, String> {
    let schemas = workspace_schemas(db, workspace, connections, sources);
    graph_compiler(workspace, connections, sources, &schemas).to_sql(is_preview)
}

fn describe_sql_models(
    db: &DbSession,
    workspace: &Workspace,
) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    for query in &workspace.queries {
        let Some(TransformationStep::SqlModel { raw_sql }) = query.steps.first() else {
            continue;
        };
        if let Ok(cols) = describe_sql_model(db, raw_sql) {
            if !cols.is_empty() {
                out.insert(query.id.clone(), cols);
            }
        }
    }
    out
}

fn describe_sql_model(db: &DbSession, raw_sql: &str) -> Result<Vec<String>, String> {
    let sql = format!("SELECT * FROM ({raw_sql}) AS _dwh_schema_probe LIMIT 0");
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let _batches: Vec<RecordBatch> = arrow.collect();
        Ok(schema
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect())
    })
}
