//! Join investigation diagnostics (DESIGN §9 / ADR-0018).
//!
//! Counts cover full Join inputs after preceding transforms. Samples are bounded
//! (default 50) and labeled separately — a clean sample is not full-input proof.

use crate::preview::{ColumnMetadata, PreviewResult};
use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, quote_ident, ConnectionDef, GraphCompiler, TransformationStep, Workspace,
};
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
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinDiagnostics, String> {
    join_diagnostics_with_limit(
        db,
        workspace,
        connections,
        host_query_id,
        join_step_index,
        JOIN_DIAG_SAMPLE_LIMIT,
    )
}

pub fn join_diagnostics_with_limit(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
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

    let left_cte = cte_name(host_query_id, join_step_index - 1);
    let join_cte = cte_name(host_query_id, join_step_index);
    let right_cte = cte_name(right_query_id, {
        let rq = resolved
            .query(right_query_id)
            .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
        if rq.steps.is_empty() {
            return Err(format!("right query '{right_query_id}' has no steps"));
        }
        rq.steps.len() - 1
    });

    let compiled = GraphCompiler::new(&resolved).compile_ctes_from(host_query_id)?;
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
    let on_sql_r2 = left_on
        .iter()
        .zip(right_on.iter())
        .map(|(l, r)| format!("l.{} = r2.{}", quote_ident(l), quote_ident(r)))
        .collect::<Vec<_>>()
        .join(" AND ");

    // Scalar counts in one round-trip.
    let sql_counts = compiled.wrap_select(&format!(
        "SELECT\n\
         (SELECT COUNT(*) FROM {left_cte}) AS left_count,\n\
         (SELECT COUNT(*) FROM {right_cte}) AS right_count,\n\
         (SELECT COUNT(*) FROM {join_cte}) AS output_count,\n\
         (SELECT COUNT(*) FROM {left_cte} l WHERE NOT EXISTS (\n\
            SELECT 1 FROM {right_cte} r WHERE {on_sql}\n\
         )) AS unmatched_left_count,\n\
         (SELECT COUNT(*) FROM {right_cte} r WHERE NOT EXISTS (\n\
            SELECT 1 FROM {left_cte} l WHERE {on_sql}\n\
         )) AS unmatched_right_count,\n\
         (SELECT COUNT(*) FROM {left_cte} l WHERE (\n\
            SELECT COUNT(*) FROM {right_cte} r WHERE {on_sql}\n\
         ) > 1) AS fanout_left_count,\n\
         (SELECT COUNT(*) FROM (\n\
            SELECT 1 FROM {right_cte} GROUP BY {right_keys_list} HAVING COUNT(*) > 1\n\
         ) d) AS right_dup_key_group_count"
    ));

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

    let unmatched_left_sql = compiled.wrap_select(&format!(
        "SELECT l.* FROM {left_cte} l\n\
         WHERE NOT EXISTS (SELECT 1 FROM {right_cte} r WHERE {on_sql})\n\
         LIMIT {sample_limit}"
    ));
    let unmatched_right_sql = compiled.wrap_select(&format!(
        "SELECT r.* FROM {right_cte} r\n\
         WHERE NOT EXISTS (SELECT 1 FROM {left_cte} l WHERE {on_sql})\n\
         LIMIT {sample_limit}"
    ));
    let fanout_pairs_sql = compiled.wrap_select(&format!(
        "SELECT l.*, r.*\n\
         FROM {left_cte} l\n\
         INNER JOIN {right_cte} r ON {on_sql}\n\
         WHERE (SELECT COUNT(*) FROM {right_cte} r2 WHERE {on_sql_r2}) > 1\n\
         ORDER BY {left_keys_sql}\n\
         LIMIT {sample_limit}"
    ));
    let right_dup_sql = compiled.wrap_select(&format!(
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
                col_type: map_arrow_type_local(f.data_type()),
            })
            .collect();
        Ok(PR {
            columns,
            rows: batches_to_rows_local(&batches),
            sql,
        })
    })
}

fn map_arrow_type_local(dt: &duckdb::arrow::datatypes::DataType) -> String {
    use duckdb::arrow::datatypes::DataType;
    match dt {
        DataType::Boolean => "BOOLEAN".into(),
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => "INTEGER".into(),
        DataType::Float16 | DataType::Float32 | DataType::Float64 => "FLOAT".into(),
        DataType::Utf8 | DataType::LargeUtf8 => "VARCHAR".into(),
        DataType::Date32 | DataType::Date64 => "DATE".into(),
        other => format!("{other:?}"),
    }
}

fn batches_to_rows_local(batches: &[RecordBatch]) -> Vec<Vec<JsonValue>> {
    use duckdb::arrow::array::*;
    use duckdb::arrow::datatypes::DataType;
    let mut rows = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let cols = batch.num_columns();
        for r in 0..n {
            let mut row = Vec::with_capacity(cols);
            for c in 0..cols {
                let array = batch.column(c);
                if array.is_null(r) {
                    row.push(JsonValue::Null);
                    continue;
                }
                let v = match array.data_type() {
                    DataType::Boolean => {
                        let a = array.as_any().downcast_ref::<BooleanArray>().unwrap();
                        JsonValue::Bool(a.value(r))
                    }
                    DataType::Int8 => {
                        let a = array.as_any().downcast_ref::<Int8Array>().unwrap();
                        JsonValue::from(a.value(r) as i64)
                    }
                    DataType::Int16 => {
                        let a = array.as_any().downcast_ref::<Int16Array>().unwrap();
                        JsonValue::from(a.value(r) as i64)
                    }
                    DataType::Int32 => {
                        let a = array.as_any().downcast_ref::<Int32Array>().unwrap();
                        JsonValue::from(a.value(r) as i64)
                    }
                    DataType::Int64 => {
                        let a = array.as_any().downcast_ref::<Int64Array>().unwrap();
                        JsonValue::from(a.value(r))
                    }
                    DataType::UInt8 => {
                        let a = array.as_any().downcast_ref::<UInt8Array>().unwrap();
                        JsonValue::from(a.value(r) as u64)
                    }
                    DataType::UInt16 => {
                        let a = array.as_any().downcast_ref::<UInt16Array>().unwrap();
                        JsonValue::from(a.value(r) as u64)
                    }
                    DataType::UInt32 => {
                        let a = array.as_any().downcast_ref::<UInt32Array>().unwrap();
                        JsonValue::from(a.value(r) as u64)
                    }
                    DataType::UInt64 => {
                        let a = array.as_any().downcast_ref::<UInt64Array>().unwrap();
                        JsonValue::from(a.value(r))
                    }
                    DataType::Float32 => {
                        let a = array.as_any().downcast_ref::<Float32Array>().unwrap();
                        serde_json::Number::from_f64(a.value(r) as f64)
                            .map(JsonValue::Number)
                            .unwrap_or(JsonValue::Null)
                    }
                    DataType::Float64 => {
                        let a = array.as_any().downcast_ref::<Float64Array>().unwrap();
                        serde_json::Number::from_f64(a.value(r))
                            .map(JsonValue::Number)
                            .unwrap_or(JsonValue::Null)
                    }
                    DataType::Utf8 => {
                        let a = array.as_any().downcast_ref::<StringArray>().unwrap();
                        JsonValue::String(a.value(r).to_string())
                    }
                    DataType::LargeUtf8 => {
                        let a = array.as_any().downcast_ref::<LargeStringArray>().unwrap();
                        JsonValue::String(a.value(r).to_string())
                    }
                    DataType::Date32 => {
                        let a = array.as_any().downcast_ref::<Date32Array>().unwrap();
                        JsonValue::from(a.value(r))
                    }
                    _ => JsonValue::String(format!("{:?}", array.data_type())),
                };
                row.push(v);
            }
            rows.push(row);
        }
    }
    rows
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
        };

        let db = DbSession::new().expect("duckdb");
        let diag = join_diagnostics(&db, &ws, &[], "fact", 1).expect("diag");
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
        };

        let db = DbSession::new().expect("duckdb");
        let diag = join_diagnostics(&db, &ws, &[], "left", 1).expect("diag");
        assert_eq!(diag.left_count, 2);
        assert_eq!(diag.right_count, 3);
        assert_eq!(diag.unmatched_left_count, 1); // id=3
        assert_eq!(diag.unmatched_right_count, 1); // id=2
        assert_eq!(diag.fanout_left_count, 1); // id=1 matches two right rows
        assert_eq!(diag.right_dup_key_group_count, 1); // id=1 duplicated
        assert_eq!(diag.unmatched_left.sample_rows, 1);
        assert!(!diag.fanout_pairs.rows.is_empty());
    }
}
