//! Schema-aware GraphCompiler prep shared by preview, Join diagnostics, prepare, explain, fuzzy,
//! and dbt export/preview (same SqlModel + Load* column knowledge).
//!
//! Always attach [`WorkspaceSchemas`] so ApplyKeyMap `output_column` overwrite vs append matches
//! across consumers. Strict emit still refuses unknown prior schema when output is not a fact col.
//!
//! Prefer [`prepare_workspace`] once per request — Load seeds and SqlModel probes are not
//! re-collected independently. Graph/topo/infer failures return [`Err`]; per-SqlModel probe
//! failures land in [`PreparedWorkspace::warnings`].

use crate::load_seeds::collect_load_seeds;
use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, infer_workspace_schemas_ex, topo_queries, CompiledCtes, ConnectionDef, GraphCompiler,
    SourceDef, TransformationStep, Workspace, WorkspaceSchemas,
};
use duckdb::arrow::record_batch::RecordBatch;
use std::collections::HashMap;

/// One-shot compile prep for preview, Lens, and export.
#[derive(Debug, Clone, Default)]
pub struct PreparedWorkspace {
    pub schemas: WorkspaceSchemas,
    pub seeds: HashMap<String, Vec<String>>,
    pub sql_models: HashMap<String, Vec<String>>,
    /// Soft probe failures (missing columns, describe errors) with reason.
    pub warnings: Vec<String>,
}

/// Resolve seeds + SqlModel columns + inferred schemas once.
///
/// - `Err` — graph structure / topo / workspace-wide inference failed.
/// - `Ok` with `warnings` — individual Load/SqlModel probes failed but the graph is usable.
pub fn prepare_workspace(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> Result<PreparedWorkspace, String> {
    // Structural: bad dependency graph must not become an empty schema silently.
    let _order = topo_queries(workspace)?;

    let mut warnings = Vec::new();
    let seeds = match collect_load_seeds(db, workspace, connections, sources) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("load seeds: {e}"));
            HashMap::new()
        }
    };
    let (sql_models, mut probe_warn) =
        collect_sql_model_schemas_inner(db, workspace, connections, sources, &seeds);
    warnings.append(&mut probe_warn);

    let schemas = infer_workspace_schemas_ex(workspace, &seeds, &sql_models).map_err(|e| {
        format!("infer workspace schemas: {e}")
    })?;

    Ok(PreparedWorkspace {
        schemas,
        seeds,
        sql_models,
        warnings,
    })
}

/// Infer schemas (discards warnings — prefer [`prepare_workspace`] at call sites).
pub fn workspace_schemas(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> Result<WorkspaceSchemas, String> {
    Ok(prepare_workspace(db, workspace, connections, sources)?.schemas)
}

/// Live-described SqlModel column lists (query_id → columns).
pub fn collect_sql_model_schemas(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> HashMap<String, Vec<String>> {
    prepare_workspace(db, workspace, connections, sources)
        .map(|p| p.sql_models)
        .unwrap_or_default()
}

fn collect_sql_model_schemas_inner(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    seeds: &HashMap<String, Vec<String>>,
) -> (HashMap<String, Vec<String>>, Vec<String>) {
    let mut sql_models = HashMap::new();
    let mut warnings = Vec::new();
    // Caller already validated topo; fall back only if re-entry without prepare.
    let order = match topo_queries(workspace) {
        Ok(o) => o,
        Err(e) => {
            warnings.push(format!("topo_queries: {e}"));
            workspace.queries.iter().map(|q| q.id.clone()).collect()
        }
    };

    for qid in order {
        let Some(query) = workspace.query(&qid) else {
            continue;
        };
        if !matches!(query.steps.first(), Some(TransformationStep::SqlModel { .. })) {
            continue;
        }
        let prefix_ws = match workspace_sql_model_prefix(workspace, &qid) {
            Ok(ws) => ws,
            Err(e) => {
                warnings.push(format!("SqlModel {qid}: {e}"));
                continue;
            }
        };
        let schemas = match infer_workspace_schemas_ex(&prefix_ws, seeds, &sql_models) {
            Ok(s) => s,
            Err(e) => {
                warnings.push(format!("SqlModel {qid} infer: {e}"));
                continue;
            }
        };
        let compiled =
            match graph_compiler(&prefix_ws, connections, sources, &schemas).compile_ctes_from(&qid)
            {
                Ok(c) => c,
                Err(e) => {
                    warnings.push(format!("SqlModel {qid} compile: {e}"));
                    continue;
                }
            };
        let cte = cte_name(&qid, 0);
        match describe_compiled_cte(db, &compiled, &cte) {
            Ok(cols) if !cols.is_empty() => {
                sql_models.insert(qid, cols);
            }
            Ok(_) => warnings.push(format!("SqlModel {qid}: describe returned no columns")),
            Err(e) => warnings.push(format!("SqlModel {qid} describe: {e}")),
        }
    }
    (sql_models, warnings)
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
    let prepared = prepare_workspace(db, workspace, connections, sources)?;
    graph_compiler(workspace, connections, sources, &prepared.schemas).compile_ctes_from(root_id)
}

/// Preview/export SQL for the focus query (schema-aware).
pub fn compile_focus_sql(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    is_preview: bool,
) -> Result<String, String> {
    let prepared = prepare_workspace(db, workspace, connections, sources)?;
    graph_compiler(workspace, connections, sources, &prepared.schemas).to_sql(is_preview)
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
    fn prepare_workspace_returns_seeds_and_schemas() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "q".into(),
                steps: vec![TransformationStep::SqlModel {
                    raw_sql: "select 1 as n".into(),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let prepared = prepare_workspace(&db, &ws, &[], &[]).unwrap();
        assert!(prepared.sql_models.contains_key("q"), "{prepared:?}");
        assert!(
            prepared.schemas.query_out.contains_key("q"),
            "{:?}",
            prepared.schemas.query_out
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
        let prepared = prepare_workspace(&db, &ws, &[], &[]).unwrap();
        assert!(prepared.sql_models.get("q").is_some(), "{prepared:?}");

        let preview = crate::preview::preview_workspace(&db, &ws, &[], &[]).unwrap();
        assert!(
            !preview.columns.iter().any(|c| c.name == "canonical_1"),
            "{:?}",
            preview.columns
        );

        let plan = build_export_plan_routed(
            "pipe",
            &ws,
            DbtTarget::V1,
            ExecutionEngine::Duckdb,
            DestinationKind::Duckdb,
            "public",
            &[],
            &prepared.seeds,
            &[],
            &prepared.sql_models,
        )
        .expect("export must succeed when PreparedWorkspace schemas are passed");
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
