//! Schema-aware GraphCompiler prep shared by preview, Join diagnostics, prepare, explain, fuzzy,
//! and dbt export/preview (same SqlModel + Load* column knowledge).
//!
//! Always attach [`WorkspaceSchemas`] so ApplyKeyMap `output_column` overwrite vs append matches
//! across consumers. Strict emit still refuses unknown prior schema when output is not a fact col.

use crate::load_seeds::collect_load_seeds;
use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, infer_workspace_schemas_ex, topo_queries, CompiledCtes, ConnectionDef, GraphCompiler,
    SourceDef, TransformationStep, Workspace, WorkspaceSchemas,
};
use duckdb::arrow::record_batch::RecordBatch;
use std::collections::HashMap;

/// Infer schemas from Load* seeds, then fill SqlModel holes via compile + `LIMIT 0` describe.
pub fn workspace_schemas(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> WorkspaceSchemas {
    let seeds = collect_load_seeds(db, workspace, connections, sources).unwrap_or_default();
    let sql_models = collect_sql_model_schemas(db, workspace, connections, sources);
    infer_workspace_schemas_ex(workspace, &seeds, &sql_models).unwrap_or_default()
}

/// Live-described SqlModel column lists (query_id → columns). Shared by preview and dbt export.
pub fn collect_sql_model_schemas(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> HashMap<String, Vec<String>> {
    let seeds = collect_load_seeds(db, workspace, connections, sources).unwrap_or_default();
    let mut sql_models = HashMap::new();
    let order = topo_queries(workspace).unwrap_or_else(|_| {
        workspace.queries.iter().map(|q| q.id.clone()).collect()
    });

    for qid in order {
        let Some(query) = workspace.query(&qid) else {
            continue;
        };
        if !matches!(query.steps.first(), Some(TransformationStep::SqlModel { .. })) {
            continue;
        }
        let Ok(prefix_ws) = workspace_sql_model_prefix(workspace, &qid) else {
            continue;
        };
        // Known SqlModel schemas so far + Load seeds; this query is truncated to SqlModel only
        // so ApplyKeyMap later in the same query cannot block the probe.
        let schemas =
            infer_workspace_schemas_ex(&prefix_ws, &seeds, &sql_models).unwrap_or_default();
        let Ok(compiled) =
            graph_compiler(&prefix_ws, connections, sources, &schemas).compile_ctes_from(&qid)
        else {
            continue;
        };
        let cte = cte_name(&qid, 0);
        if let Ok(cols) = describe_compiled_cte(db, &compiled, &cte) {
            if !cols.is_empty() {
                sql_models.insert(qid, cols);
            }
        }
    }
    sql_models
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

/// Clone workspace with `qid` truncated to its SqlModel (step 0) so we can compile/describe
/// without needing ApplyKeyMap's prior schema for that same query.
fn workspace_sql_model_prefix(workspace: &Workspace, qid: &str) -> Result<Workspace, String> {
    let mut ws = workspace.clone();
    let query = ws
        .queries
        .iter_mut()
        .find(|q| q.id == qid)
        .ok_or_else(|| format!("missing query {qid}"))?;
    if query.steps.is_empty() {
        return Err(format!("query '{qid}' has no steps"));
    }
    if !matches!(query.steps[0], TransformationStep::SqlModel { .. }) {
        return Err(format!("query '{qid}' step 0 is not SqlModel"));
    }
    query.steps.truncate(1);
    ws.focus_query_id = qid.to_string();
    Ok(ws)
}

fn describe_compiled_cte(
    db: &DbSession,
    compiled: &CompiledCtes,
    cte: &str,
) -> Result<Vec<String>, String> {
    let sql = compiled.wrap_select(&format!("SELECT * FROM {cte} LIMIT 0"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{KeyMapDef, KeyMapEntry, QueryDef, TransformationStep};

    #[test]
    fn sql_model_trailing_semicolon_still_describes() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "q".into(),
                steps: vec![TransformationStep::SqlModel {
                    raw_sql: "select 1 as n, 'OLD' as canonical;".into(),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let cols = collect_sql_model_schemas(&db, &ws, &[], &[]);
        assert_eq!(
            cols.get("q").map(|c| c.as_slice()),
            Some(["n".into(), "canonical".into()].as_slice()),
            "trailing ; must not kill schema probe: {cols:?}"
        );
    }

    #[test]
    fn sql_model_query_placeholder_resolves_before_describe() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "base".into(),
                    name: "base".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: "select 'x' as ext, 'OLD' as canonical".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "wrap".into(),
                    name: "wrap".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: "select * from {{query:base}};".into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "wrap".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let cols = collect_sql_model_schemas(&db, &ws, &[], &[]);
        assert!(cols.get("base").is_some(), "{cols:?}");
        assert_eq!(
            cols.get("wrap").map(|c| c.as_slice()),
            Some(["ext".into(), "canonical".into()].as_slice()),
            "{cols:?}"
        );
    }

    #[test]
    fn preview_and_export_schemas_agree_on_sqlmodel_apply() {
        use dwh_pipeline::{
            build_export_plan_routed, DestinationKind, DbtTarget, ExecutionEngine,
        };
        let mut map = KeyMapDef::new("m", "m");
        map.entries = vec![KeyMapEntry::pair("x", "NEW")];
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "q".into(),
                steps: vec![
                    TransformationStep::SqlModel {
                        raw_sql: "select 'x' as ext, 'OLD' as canonical;".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "ext".into(),
                        columns: vec!["ext".into()],
                        output_column: Some("canonical".into()),
                        map_id: "m".into(),
                        entries: map.entries.clone(),
                    },
                ],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        };
        let db = DbSession::new().unwrap();
        let sql_models = collect_sql_model_schemas(&db, &ws, &[], &[]);
        assert!(sql_models.get("q").is_some(), "{sql_models:?}");

        // Preview path
        let preview = crate::preview::preview_workspace(&db, &ws, &[], &[]).unwrap();
        assert!(
            !preview.columns.iter().any(|c| c.name == "canonical_1"),
            "{:?}",
            preview.columns
        );

        // Export path with the same SqlModel schemas
        let plan = build_export_plan_routed(
            "pipe",
            &ws,
            DbtTarget::V1,
            ExecutionEngine::Duckdb,
            DestinationKind::Duckdb,
            "public",
            &[],
            &HashMap::new(),
            &[],
            &sql_models,
        )
        .expect("export must succeed when SqlModel schemas are passed");
        let model = plan
            .keys()
            .find(|k| k.ends_with(".sql") && k.contains("mart_"))
            .or_else(|| plan.keys().find(|k| k.ends_with(".sql")))
            .expect("model sql");
        let body = &plan[model];
        assert!(
            body.contains("EXCLUDE") || body.contains("canonical"),
            "{body}"
        );
        assert!(!body.contains("cannot tell"), "{body}");
    }
}
