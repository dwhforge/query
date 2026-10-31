//! Join investigation diagnostics (DESIGN §9 / ADR-0018).
//!
//! Counts cover full Join inputs after preceding transforms. Samples are bounded
//! (default 50) and labeled separately — a clean sample is not full-input proof.

use crate::arrow_json::{batches_to_rows, map_arrow_type};
use crate::compile::compile_ctes_from;
use crate::preview::{ColumnMetadata, PreviewResult};
use crate::session::DbSession;
use dwh_pipeline::{cte_name, quote_ident, ConnectionDef, TransformationStep, Workspace};
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

pub const JOIN_DIAG_SAMPLE_LIMIT: u64 = 50;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinDiagSample {
    pub columns: Vec<ColumnMetadata>,
    pub rows: Vec<Vec<JsonValue>>,
    /// Rows in this sample (≤ sample_limit).
    pub sample_rows: u64,
    /// Full count for this diagnostic (may exceed sample).
    pub total_count: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinDiagnostics {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub right_query_id: String,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub sample_limit: u64,
    /// Counts are over the full inputs (not preview LIMIT).
    pub left_count: u64,
    pub right_count: u64,
    pub output_count: u64,
    pub unmatched_left_count: u64,
    pub unmatched_right_count: u64,
    pub fanout_left_count: u64,
    pub right_dup_key_group_count: u64,
    pub unmatched_left: JoinDiagSample,
    pub unmatched_right: JoinDiagSample,
    pub fanout_pairs: JoinDiagSample,
    pub right_dup_keys: JoinDiagSample,
    /// Summary SQL used for scalar counts (debug).
    pub sql_counts: String,
}

/// Run Join diagnostics for `host_query_id` at `join_step_index`.
pub fn join_diagnostics(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[dwh_pipeline::SourceDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinDiagnostics, String> {
    join_diagnostics_with_limit(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        JOIN_DIAG_SAMPLE_LIMIT,
    )
}

pub fn join_diagnostics_with_limit(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[dwh_pipeline::SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    sample_limit: u64,
) -> Result<JoinDiagnostics, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let host = resolved
        .query(host_query_id)
        .ok_or_else(|| format!("missing host query '{host_query_id}'"))?;
    if join_step_index >= host.steps.len() {
        return Err(format!(
            "join_step_index {join_step_index} out of range for query '{host_query_id}'"
        ));
    }
    let TransformationStep::Join {
        right_query_id,
        left_on,
        right_on,
        ..
    } = &host.steps[join_step_index]
    else {
        return Err(format!(
            "step {join_step_index} of '{host_query_id}' is not a Join"
        ));
    };
    if left_on.is_empty() || left_on.len() != right_on.len() {
        return Err("Join: left_on/right_on must be non-empty and same length".into());
    }
    if join_step_index == 0 {
        return Err("Join cannot be the first step (no left input)".into());
    }

    let left_cte_full = cte_name(host_query_id, join_step_index - 1);
    let join_cte_full = cte_name(host_query_id, join_step_index);
    let right_cte_full = cte_name(right_query_id, {
        let rq = resolved
            .query(right_query_id)
            .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
        if rq.steps.is_empty() {
            return Err(format!("right query '{right_query_id}' has no steps"));
        }
        rq.steps.len() - 1
    });

    // Diagnostics needs both sides as TEMP — live 200M anti-joins take minutes.
    crate::join_prepare::ensure_join_sides_materialized(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        None,
    )?;

    // Prefer prepared temp tables when fingerprint matches (avoid re-scanning inputs).
    let prep = crate::join_prepare::prepared_join_with(
        db,
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    let (left_cte, right_cte, join_cte, wrap_select): (
        String,
        String,
        String,
        Box<dyn Fn(&str) -> String>,
    ) = if let Some((_h, defs)) = prep {
        let (l, r, j) = crate::join_prepare::prepared_cte_names();
        (
            l.into(),
            r.into(),
            j.into(),
            Box::new(move |body: &str| format!("WITH \n{defs}\n{body}")),
        )
    } else {
        let compiled =
            compile_ctes_from(db, &resolved, connections, sources, host_query_id)?;
        (
            left_cte_full,
            right_cte_full,
            join_cte_full,
            Box::new(move |body: &str| compiled.wrap_select(body)),
        )
    };
    let on_sql = join_on_sql(left_on, right_on);
    let left_keys_sql = left_on
        .iter()
        .map(|c| format!("l.{}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let right_keys_list = right_on
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let on_keys = left_on
        .iter()
        .zip(right_on.iter())
        .map(|(l, r)| format!("l.{} = d.{}", quote_ident(l), quote_ident(r)))
        .collect::<Vec<_>>()
        .join(" AND ");

    // Hash-friendly counts — no per-row correlated subqueries (those took minutes on 200M).
    // Appended as sibling CTEs (cannot nest WITH inside wrap_select).
    let count_ctes = format!(
        "_rc AS (SELECT COUNT(*) AS c FROM {right_cte}),\n\
         _lc AS (SELECT COUNT(*) AS c FROM {left_cte}),\n\
         _jc AS (SELECT COUNT(*) AS c FROM {join_cte}),\n\
         _dup AS (\n\
           SELECT {right_keys_list} FROM {right_cte}\n\
           GROUP BY {right_keys_list} HAVING COUNT(*) > 1\n\
         ),\n\
         _dup_n AS (SELECT COUNT(*) AS c FROM _dup),\n\
         _ul AS (\n\
           SELECT COUNT(*) AS c FROM {left_cte} l\n\
           WHERE NOT EXISTS (SELECT 1 FROM {right_cte} r WHERE {on_sql})\n\
         ),\n\
         _ur AS (\n\
           SELECT COUNT(*) AS c FROM {right_cte} r\n\
           WHERE NOT EXISTS (SELECT 1 FROM {left_cte} l WHERE {on_sql})\n\
         ),\n\
         _fo AS (\n\
           SELECT COUNT(*) AS c FROM {left_cte} l\n\
           INNER JOIN _dup d ON {on_keys}\n\
         )"
    );
    let sql_counts = wrap_select_with_extra(
        &wrap_select,
        &count_ctes,
        "SELECT\n\
           (SELECT c FROM _lc) AS left_count,\n\
           (SELECT c FROM _rc) AS right_count,\n\
           (SELECT c FROM _jc) AS output_count,\n\
           (SELECT c FROM _ul) AS unmatched_left_count,\n\
           (SELECT c FROM _ur) AS unmatched_right_count,\n\
           (SELECT c FROM _fo) AS fanout_left_count,\n\
           (SELECT c FROM _dup_n) AS right_dup_key_group_count",
    );

    let (
        left_count,
        right_count,
        output_count,
        unmatched_left_count,
        unmatched_right_count,
        fanout_left_count,
        right_dup_key_group_count,
    ) = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql_counts).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let row = rows
            .next()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "join diagnostics counts: empty result".to_string())?;
        Ok((
            row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(1).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(2).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(3).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(4).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(5).map_err(|e| e.to_string())? as u64,
            row.get::<_, i64>(6).map_err(|e| e.to_string())? as u64,
        ))
    })?;

    let unmatched_left_sql = wrap_select(&format!(
        "SELECT l.* FROM {left_cte} l\n\
         WHERE NOT EXISTS (SELECT 1 FROM {right_cte} r WHERE {on_sql})\n\
         LIMIT {sample_limit}"
    ));
    let unmatched_right_sql = wrap_select(&format!(
        "SELECT r.* FROM {right_cte} r\n\
         WHERE NOT EXISTS (SELECT 1 FROM {left_cte} l WHERE {on_sql})\n\
         LIMIT {sample_limit}"
    ));
    let fanout_pairs_sql = wrap_select_with_extra(
        &wrap_select,
        &format!(
            "_dup AS (\n\
               SELECT {right_keys_list} FROM {right_cte}\n\
               GROUP BY {right_keys_list} HAVING COUNT(*) > 1\n\
             )"
        ),
        &format!(
            "SELECT l.*, r.*\n\
             FROM {left_cte} l\n\
             INNER JOIN {right_cte} r ON {on_sql}\n\
             INNER JOIN _dup d ON {on_keys}\n\
             ORDER BY {left_keys_sql}\n\
             LIMIT {sample_limit}"
        ),
    );
    let right_dup_sql = wrap_select(&format!(
        "SELECT {right_keys_list}, COUNT(*) AS _dup_n\n\
         FROM {right_cte}\n\
         GROUP BY {right_keys_list}\n\
         HAVING COUNT(*) > 1\n\
         ORDER BY _dup_n DESC\n\
         LIMIT {sample_limit}"
    ));

    let unmatched_left = sample_from_sql(
        db,
        &unmatched_left_sql,
        unmatched_left_count,
        sample_limit,
    )?;
    let unmatched_right = sample_from_sql(
        db,
        &unmatched_right_sql,
        unmatched_right_count,
        sample_limit,
    )?;
    let fanout_pairs =
        sample_from_sql(db, &fanout_pairs_sql, fanout_left_count, sample_limit)?;
    let right_dup_keys = sample_from_sql(
        db,
        &right_dup_sql,
        right_dup_key_group_count,
        sample_limit,
    )?;

    Ok(JoinDiagnostics {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        right_query_id: right_query_id.clone(),
        left_on: left_on.clone(),
        right_on: right_on.clone(),
        sample_limit,
        left_count,
        right_count,
        output_count,
        unmatched_left_count,
        unmatched_right_count,
        fanout_left_count,
        right_dup_key_group_count,
        unmatched_left,
        unmatched_right,
        fanout_pairs,
        right_dup_keys,
        sql_counts,
    })
}

/// `wrap` builds `WITH <defs>\n<body>`. Inject extra CTEs before `body`.
fn wrap_select_with_extra(
    wrap: &dyn Fn(&str) -> String,
    extra_ctes: &str,
    select_body: &str,
) -> String {
    let marker = "\n__DWH_DIAG_BODY__";
    let skeleton = wrap(marker);
    let Some(idx) = skeleton.find(marker) else {
        return wrap(select_body);
    };
    let (prefix, _) = skeleton.split_at(idx);
    // prefix ends with "WITH \n{defs}" or "WITH \n{defs}\n" — append comma + extras.
    let prefix = prefix.trim_end();
    format!("{prefix},\n{extra_ctes}\n{select_body}")
}

fn join_on_sql(left_on: &[String], right_on: &[String]) -> String {
    left_on
        .iter()
        .zip(right_on.iter())
        .map(|(l, r)| format!("l.{} = r.{}", quote_ident(l), quote_ident(r)))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn sample_from_sql(
    db: &DbSession,
    sql: &str,
    total_count: u64,
    _sample_limit: u64,
) -> Result<JoinDiagSample, String> {
    let preview = run_sql_preview(db, sql.to_string())?;
    Ok(JoinDiagSample {
        sample_rows: preview.rows.len() as u64,
        total_count,
        columns: preview.columns,
        rows: preview.rows,
    })
}

fn run_sql_preview(db: &DbSession, sql: String) -> Result<PreviewResult, String> {
    use crate::preview::PreviewResult as PR;
    // Reuse preview's arrow path via a local copy of run_sql logic — call through
    // preparing and collecting. Import batches_to_rows is private; duplicate thin path.
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        let columns = schema
            .fields()
            .iter()
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_arrow_type(f.data_type()),
            })
            .collect();
        Ok(PR {
            columns,
            rows: batches_to_rows(&batches),
            sql,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{JoinType, QueryDef, TransformationStep};
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    #[test]
    fn sales_dim_join_diagnostics() {
        let fixtures = fixtures();
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        assert!(sample.is_file());

        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
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

        let db = DbSession::new().expect("duckdb");
        let diag = join_diagnostics(&db, &ws, &[], &[], "fact", 1).expect("diag");
        assert!(diag.left_count > 0);
        assert_eq!(diag.right_count, 3);
        assert_eq!(diag.output_count, diag.left_count); // all regions match
        assert_eq!(diag.unmatched_left_count, 0);
        assert_eq!(diag.unmatched_right_count, 0);
        assert_eq!(diag.fanout_left_count, 0);
        assert_eq!(diag.right_dup_key_group_count, 0);
        assert_eq!(diag.sample_limit, JOIN_DIAG_SAMPLE_LIMIT);
    }

    #[test]
    fn unmatched_and_fanout_case() {
        // Inline values via SqlModel for a controlled Join.
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "right".into(),
                    name: "right".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: "select * from (values (1), (1), (2)) t(id)".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "left".into(),
                    name: "left".into(),
                    steps: vec![
                        TransformationStep::SqlModel {
                            raw_sql: "select * from (values (1), (3)) t(id)".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "right".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["id".into()],
                            right_on: vec!["id".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "left".into(),
            key_maps: vec![],
        };

        let db = DbSession::new().expect("duckdb");
        let diag = join_diagnostics(&db, &ws, &[], &[], "left", 1).expect("diag");
        assert_eq!(diag.left_count, 2);
        assert_eq!(diag.right_count, 3);
        assert_eq!(diag.unmatched_left_count, 1); // id=3
        assert_eq!(diag.unmatched_right_count, 1); // id=2
        assert_eq!(diag.fanout_left_count, 1); // id=1 matches two right rows
        assert_eq!(diag.right_dup_key_group_count, 1); // id=1 duplicated
        assert_eq!(diag.unmatched_left.sample_rows, 1);
        assert!(!diag.fanout_pairs.rows.is_empty());
    }

    #[test]
    fn apply_keymap_overwrite_matches_preview_and_diagnostics() {
        use dwh_pipeline::{KeyMapDef, KeyMapEntry, JoinType};
        // Left has canonical=OLD; ApplyKeyMap rewrites to NEW; Join ON canonical → right.NEW.
        // Without schemas, emit would append canonical_1 and Join would still see OLD → unmatched.
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "right".into(),
                    name: "right".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: "select * from (values ('NEW')) t(canonical)".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "left".into(),
                    name: "left".into(),
                    steps: vec![
                        TransformationStep::SqlModel {
                            raw_sql: "select * from (values ('x', 'OLD')) t(ext, canonical)"
                                .into(),
                        },
                        TransformationStep::ApplyKeyMap {
                            column: "ext".into(),
                            columns: vec!["ext".into()],
                            output_column: Some("canonical".into()),
                            map_id: "m".into(),
                            entries: vec![KeyMapEntry::pair("x", "NEW")],
                        },
                        TransformationStep::Join {
                            right_query_id: "right".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["canonical".into()],
                            right_on: vec!["canonical".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "left".into(),
            key_maps: vec![{
                let mut m = KeyMapDef::new("m", "m");
                m.entries = vec![KeyMapEntry::pair("x", "NEW")];
                m
            }],
        };

        let db = DbSession::new().expect("duckdb");
        let preview = crate::preview::preview_workspace(&db, &ws, &[], &[]).expect("preview");
        assert_eq!(preview.rows.len(), 1, "preview should match after ApplyKeyMap");
        let canon_i = preview
            .columns
            .iter()
            .position(|c| c.name == "canonical")
            .expect("canonical");
        assert!(
            !preview.columns.iter().any(|c| c.name == "canonical_1"),
            "must overwrite, not duplicate: {:?}",
            preview.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        assert_eq!(preview.rows[0][canon_i], serde_json::json!("NEW"));

        let diag = join_diagnostics(&db, &ws, &[], &[], "left", 2).expect("diag");
        assert_eq!(diag.unmatched_left_count, 0, "diagnostics must see rewritten key");
        assert_eq!(diag.output_count, 1);
    }
}
