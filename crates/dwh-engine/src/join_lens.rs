//! Join Lens — row-level where-provenance for Join investigation (perf-conscious).
//!
//! Client should request only keys for visible / focused result rows, debounce,
//! and cache by fingerprint. Server caps batch size and matches per side.

use crate::preview::ColumnMetadata;
use crate::session::DbSession;
use dwh_pipeline::{
    ascii_fold_name, cte_name, escape_sql_string, quote_ident, ConnectionDef, GraphCompiler,
    TransformationStep, Workspace,
};
use duckdb::arrow::array::*;
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};

/// Max distinct key tuples per `explain_join_rows` call.
pub const JOIN_LENS_MAX_KEYS: usize = 24;
/// Max matching input rows returned per side per key.
pub const JOIN_LENS_MAX_MATCHES: usize = 6;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinKeyTuple {
    /// Values aligned with Join `left_on` (result-side key spellings).
    pub values: Vec<JsonValue>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinRowExplanation {
    pub fingerprint: String,
    pub key_values: Vec<JsonValue>,
    pub left_match_count: u64,
    pub right_match_count: u64,
    pub left_rows: Vec<Vec<JsonValue>>,
    pub right_rows: Vec<Vec<JsonValue>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExplainJoinRowsResult {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub right_query_id: String,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub left_columns: Vec<ColumnMetadata>,
    pub right_columns: Vec<ColumnMetadata>,
    pub max_matches: usize,
    pub explanations: Vec<JoinRowExplanation>,
}

/// Batch explain for Join Lens.
///
/// Provide either `keys` (when join keys are in the preview columns) **or**
/// `preview_offsets` (0-based indices into the preview / focus output, same
/// LIMIT 50 order). Offsets recover keys even when a later SelectColumns dropped them.
pub fn explain_join_rows(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
    keys: &[JoinKeyTuple],
    preview_offsets: Option<&[u64]>,
) -> Result<ExplainJoinRowsResult, String> {
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
        return Err("Join cannot be the first step".into());
    }

    let owned_keys: Vec<JoinKeyTuple> = if !keys.is_empty() {
        for k in keys {
            if k.values.len() != left_on.len() {
                return Err(format!(
                    "key arity {} != left_on {}",
                    k.values.len(),
                    left_on.len()
                ));
            }
        }
        keys.to_vec()
    } else if let Some(offs) = preview_offsets {
        if offs.is_empty() {
            return Err("explain_join_rows: empty keys and offsets".into());
        }
        if offs.len() > JOIN_LENS_MAX_KEYS {
            return Err(format!(
                "explain_join_rows: at most {JOIN_LENS_MAX_KEYS} offsets (got {})",
                offs.len()
            ));
        }
        let compiled = GraphCompiler::new(&resolved).compile_ctes()?;
        resolve_keys_from_preview_offsets(
            db,
            &compiled.definitions,
            host_query_id,
            join_step_index,
            &host.steps,
            left_on,
            offs,
        )?
    } else {
        return Err("explain_join_rows: provide keys or preview_offsets".into());
    };

    if owned_keys.len() > JOIN_LENS_MAX_KEYS {
        return Err(format!(
            "explain_join_rows: at most {JOIN_LENS_MAX_KEYS} keys per call (got {})",
            owned_keys.len()
        ));
    }

    // Dedupe by fingerprint while preserving request order.
    let mut seen = HashSet::new();
    let mut unique: Vec<JoinKeyTuple> = Vec::new();
    let mut fingerprints: Vec<String> = Vec::new();
    for k in &owned_keys {
        let fp = fingerprint_key(&k.values);
        if seen.insert(fp.clone()) {
            unique.push(k.clone());
            fingerprints.push(fp);
        }
    }
    let unique_refs: Vec<&JoinKeyTuple> = unique.iter().collect();

    let left_cte = cte_name(host_query_id, join_step_index - 1);
    let right_cte = {
        let rq = resolved
            .query(right_query_id)
            .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
        if rq.steps.is_empty() {
            return Err(format!("right query '{right_query_id}' has no steps"));
        }
        cte_name(right_query_id, rq.steps.len() - 1)
    };

    let compiled = GraphCompiler::new(&resolved).compile_ctes()?;
    let batch_sql = values_batch_sql(&unique_refs, left_on.len())?;
    let left_on_join = left_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("l.{} = b.k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let right_on_join = right_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("r.{} = b.k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let max_m = JOIN_LENS_MAX_MATCHES;

    let with_prefix = format!("WITH \n{},\n{batch_sql}", compiled.definitions);

    let count_left_sql = format!(
        "{with_prefix}\n\
         SELECT b.ord,\n\
           (SELECT COUNT(*) FROM {left_cte} l WHERE {left_on_join})::BIGINT AS n\n\
         FROM batch b\n\
         ORDER BY b.ord"
    );
    let count_right_sql = format!(
        "{with_prefix}\n\
         SELECT b.ord,\n\
           (SELECT COUNT(*) FROM {right_cte} r WHERE {right_on_join})::BIGINT AS n\n\
         FROM batch b\n\
         ORDER BY b.ord"
    );
    let left_samp_sql = format!(
        "{with_prefix}\n\
         SELECT _ord, * EXCLUDE (_ord, _rn) FROM (\n\
           SELECT b.ord AS _ord, l.*,\n\
             ROW_NUMBER() OVER (PARTITION BY b.ord ORDER BY 1) AS _rn\n\
           FROM batch b\n\
           INNER JOIN {left_cte} l ON {left_on_join}\n\
         ) x WHERE _rn <= {max_m}\n\
         ORDER BY _ord, _rn"
    );
    let right_samp_sql = format!(
        "{with_prefix}\n\
         SELECT _ord, * EXCLUDE (_ord, _rn) FROM (\n\
           SELECT b.ord AS _ord, r.*,\n\
             ROW_NUMBER() OVER (PARTITION BY b.ord ORDER BY 1) AS _rn\n\
           FROM batch b\n\
           INNER JOIN {right_cte} r ON {right_on_join}\n\
         ) x WHERE _rn <= {max_m}\n\
         ORDER BY _ord, _rn"
    );

    let left_counts: HashMap<i64, u64> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&count_left_sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let ord: i64 = row.get(0).map_err(|e| e.to_string())?;
            let n: i64 = row.get(1).map_err(|e| e.to_string())?;
            map.insert(ord, n as u64);
        }
        Ok(map)
    })?;
    let right_counts: HashMap<i64, u64> = db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&count_right_sql)
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let ord: i64 = row.get(0).map_err(|e| e.to_string())?;
            let n: i64 = row.get(1).map_err(|e| e.to_string())?;
            map.insert(ord, n as u64);
        }
        Ok(map)
    })?;

    let (left_columns, left_by_ord) = fetch_side_samples(db, &left_samp_sql)?;
    let (right_columns, right_by_ord) = fetch_side_samples(db, &right_samp_sql)?;

    let mut explanations = Vec::with_capacity(unique.len());
    for (i, k) in unique.iter().enumerate() {
        let ord = i as i64;
        explanations.push(JoinRowExplanation {
            fingerprint: fingerprints[i].clone(),
            key_values: k.values.clone(),
            left_match_count: *left_counts.get(&ord).unwrap_or(&0),
            right_match_count: *right_counts.get(&ord).unwrap_or(&0),
            left_rows: left_by_ord.get(&ord).cloned().unwrap_or_default(),
            right_rows: right_by_ord.get(&ord).cloned().unwrap_or_default(),
        });
    }

    Ok(ExplainJoinRowsResult {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        right_query_id: right_query_id.clone(),
        left_on: left_on.clone(),
        right_on: right_on.clone(),
        left_columns,
        right_columns,
        max_matches: JOIN_LENS_MAX_MATCHES,
        explanations,
    })
}

/// Rebuild post-Join steps while always retaining `left_on` keys (even if SelectColumns dropped them).
fn resolve_keys_from_preview_offsets(
    db: &DbSession,
    workspace_cte_defs: &str,
    host_query_id: &str,
    join_step_index: usize,
    steps: &[TransformationStep],
    left_on: &[String],
    offsets: &[u64],
) -> Result<Vec<JoinKeyTuple>, String> {
    let join_cte = cte_name(host_query_id, join_step_index);
    let mut key_names: Vec<String> = left_on.to_vec();
    let mut extras: Vec<String> = Vec::new();
    let mut prev = format!("lens_c0");
    extras.push(format!("  lens_c0 AS (SELECT * FROM {join_cte})"));

    for (i, step) in steps.iter().enumerate().skip(join_step_index + 1) {
        let name = format!("lens_c{}", i - join_step_index);
        let body = match step {
            TransformationStep::Filter { condition } => {
                format!("SELECT * FROM {prev} WHERE {condition}")
            }
            TransformationStep::SortBy {
                column,
                descending,
            } => {
                let order = if *descending { "DESC" } else { "ASC" };
                format!(
                    "SELECT * FROM {prev} ORDER BY {} {order}",
                    quote_ident(column)
                )
            }
            TransformationStep::Limit { n } => {
                format!("SELECT * FROM {prev} LIMIT {n}")
            }
            TransformationStep::DeriveColumn { name: col, expression } => {
                format!(
                    "SELECT *, ({expression}) AS {} FROM {prev}",
                    quote_ident(col)
                )
            }
            TransformationStep::RenameColumn { from, to } => {
                for k in key_names.iter_mut() {
                    if ascii_fold_name(k) == ascii_fold_name(from) {
                        *k = to.clone();
                    }
                }
                format!(
                    "SELECT * RENAME ({} AS {}) FROM {prev}",
                    quote_ident(from),
                    quote_ident(to)
                )
            }
            TransformationStep::SelectColumns { columns } => {
                let mut sel = columns.clone();
                for k in &key_names {
                    if !sel
                        .iter()
                        .any(|c| ascii_fold_name(c) == ascii_fold_name(k))
                    {
                        sel.push(k.clone());
                    }
                }
                let list = sel
                    .iter()
                    .map(|c| format!("{} AS {}", quote_ident(c), quote_ident(c)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("SELECT {list} FROM {prev}")
            }
            other => {
                return Err(format!(
                    "Join Lens: cannot recover keys after {:?} (offsets mode). Keep join keys in the result or avoid this step after Join.",
                    std::mem::discriminant(other)
                ));
            }
        };
        extras.push(format!("  {name} AS ({body})"));
        prev = name;
    }

    let key_select = key_names
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{} AS k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let off_list = offsets
        .iter()
        .map(|o| o.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "WITH \n{workspace_cte_defs},\n{}\n,\n  lens_numbered AS (\n\
           SELECT ROW_NUMBER() OVER () - 1 AS __off, {key_select}\n\
           FROM {prev}\n\
           LIMIT 50\n\
         )\n\
         SELECT __off, {} FROM lens_numbered WHERE __off IN ({off_list})\n\
         ORDER BY __off",
        extras.join(",\n"),
        (0..key_names.len())
            .map(|i| format!("k{i}"))
            .collect::<Vec<_>>()
            .join(", "),
    );

    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("lens keys: {e}"))?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut by_off: HashMap<u64, JoinKeyTuple> = HashMap::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let off: i64 = row.get(0).map_err(|e| e.to_string())?;
            let mut values = Vec::with_capacity(key_names.len());
            for i in 0..key_names.len() {
                values.push(duck_value_to_json(&row, i + 1)?);
            }
            by_off.insert(off as u64, JoinKeyTuple { values });
        }
        let mut out = Vec::with_capacity(offsets.len());
        for o in offsets {
            let k = by_off.get(o).ok_or_else(|| {
                format!("preview offset {o} out of range for Join Lens key recovery")
            })?;
            out.push(k.clone());
        }
        Ok(out)
    })
}

fn duck_value_to_json(row: &duckdb::Row<'_>, idx: usize) -> Result<JsonValue, String> {
    // Prefer string round-trip then number/bool — robust across types.
    if let Ok(v) = row.get::<_, Option<i64>>(idx) {
        return Ok(match v {
            None => JsonValue::Null,
            Some(n) => JsonValue::from(n),
        });
    }
    if let Ok(v) = row.get::<_, Option<f64>>(idx) {
        return Ok(match v {
            None => JsonValue::Null,
            Some(f) => serde_json::Number::from_f64(f)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
        });
    }
    if let Ok(v) = row.get::<_, Option<bool>>(idx) {
        return Ok(match v {
            None => JsonValue::Null,
            Some(b) => JsonValue::Bool(b),
        });
    }
    let v: Option<String> = row.get(idx).map_err(|e| e.to_string())?;
    Ok(match v {
        None => JsonValue::Null,
        Some(s) => JsonValue::String(s),
    })
}

fn values_batch_sql(keys: &[&JoinKeyTuple], arity: usize) -> Result<String, String> {
    let key_cols: String = (0..arity).map(|i| format!("k{i}")).collect::<Vec<_>>().join(", ");
    let mut rows = Vec::with_capacity(keys.len());
    for (ord, k) in keys.iter().enumerate() {
        let mut cells = vec![ord.to_string()];
        for v in &k.values {
            cells.push(json_to_sql_literal(v)?);
        }
        rows.push(format!("({})", cells.join(", ")));
    }
    Ok(format!(
        "batch(ord, {key_cols}) AS (VALUES {})",
        rows.join(", ")
    ))
}

fn json_to_sql_literal(v: &JsonValue) -> Result<String, String> {
    Ok(match v {
        JsonValue::Null => "NULL".into(),
        JsonValue::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => format!("'{}'", escape_sql_string(s)),
        other => format!("'{}'", escape_sql_string(&other.to_string())),
    })
}

pub fn fingerprint_key(values: &[JsonValue]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| format!("{values:?}"))
}

fn fetch_side_samples(
    db: &DbSession,
    sql: &str,
) -> Result<(Vec<ColumnMetadata>, HashMap<i64, Vec<Vec<JsonValue>>>), String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        if schema.fields().is_empty() {
            return Ok((Vec::new(), HashMap::new()));
        }
        // First column is _ord
        let columns: Vec<ColumnMetadata> = schema
            .fields()
            .iter()
            .skip(1)
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_type(f.data_type()),
            })
            .collect();

        let mut by_ord: HashMap<i64, Vec<Vec<JsonValue>>> = HashMap::new();
        for batch in &batches {
            let n = batch.num_rows();
            let cols = batch.num_columns();
            for r in 0..n {
                let ord = cell_i64(batch.column(0).as_ref(), r)?;
                let mut row = Vec::with_capacity(cols - 1);
                for c in 1..cols {
                    row.push(cell_json(batch.column(c).as_ref(), r));
                }
                by_ord.entry(ord).or_default().push(row);
            }
        }
        Ok((columns, by_ord))
    })
}

fn cell_i64(array: &dyn Array, row: usize) -> Result<i64, String> {
    if array.is_null(row) {
        return Err("null ord".into());
    }
    if let Some(a) = array.as_any().downcast_ref::<Int64Array>() {
        return Ok(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Int32Array>() {
        return Ok(a.value(row) as i64);
    }
    Err("ord column not integer".into())
}

fn cell_json(array: &dyn Array, row: usize) -> JsonValue {
    if array.is_null(row) {
        return JsonValue::Null;
    }
    match array.data_type() {
        DataType::Boolean => {
            let a = array.as_any().downcast_ref::<BooleanArray>().unwrap();
            JsonValue::Bool(a.value(row))
        }
        DataType::Int8 => JsonValue::from(array.as_any().downcast_ref::<Int8Array>().unwrap().value(row) as i64),
        DataType::Int16 => JsonValue::from(array.as_any().downcast_ref::<Int16Array>().unwrap().value(row) as i64),
        DataType::Int32 => JsonValue::from(array.as_any().downcast_ref::<Int32Array>().unwrap().value(row) as i64),
        DataType::Int64 => JsonValue::from(array.as_any().downcast_ref::<Int64Array>().unwrap().value(row)),
        DataType::UInt8 => JsonValue::from(array.as_any().downcast_ref::<UInt8Array>().unwrap().value(row) as u64),
        DataType::UInt16 => JsonValue::from(array.as_any().downcast_ref::<UInt16Array>().unwrap().value(row) as u64),
        DataType::UInt32 => JsonValue::from(array.as_any().downcast_ref::<UInt32Array>().unwrap().value(row) as u64),
        DataType::UInt64 => JsonValue::from(array.as_any().downcast_ref::<UInt64Array>().unwrap().value(row)),
        DataType::Float32 => serde_json::Number::from_f64(
            array.as_any().downcast_ref::<Float32Array>().unwrap().value(row) as f64,
        )
        .map(JsonValue::Number)
        .unwrap_or(JsonValue::Null),
        DataType::Float64 => serde_json::Number::from_f64(
            array.as_any().downcast_ref::<Float64Array>().unwrap().value(row),
        )
        .map(JsonValue::Number)
        .unwrap_or(JsonValue::Null),
        DataType::Utf8 => JsonValue::String(
            array
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap()
                .value(row)
                .to_string(),
        ),
        DataType::LargeUtf8 => JsonValue::String(
            array
                .as_any()
                .downcast_ref::<LargeStringArray>()
                .unwrap()
                .value(row)
                .to_string(),
        ),
        DataType::Date32 => JsonValue::from(
            array
                .as_any()
                .downcast_ref::<Date32Array>()
                .unwrap()
                .value(row),
        ),
        _ => JsonValue::String(format!("{:?}", array.data_type())),
    }
}

fn map_type(dt: &DataType) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{JoinType, QueryDef, TransformationStep};
    use std::path::PathBuf;

    #[test]
    fn explain_sales_dim_keys() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
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
        let db = DbSession::new().unwrap();
        let keys = vec![
            JoinKeyTuple {
                values: vec![JsonValue::String("EU".into())],
            },
            JoinKeyTuple {
                values: vec![JsonValue::String("US".into())],
            },
        ];
        let out = explain_join_rows(&db, &ws, &[], "fact", 1, &keys, None).unwrap();
        assert_eq!(out.explanations.len(), 2);
        let eu = &out.explanations[0];
        assert!(eu.left_match_count >= 1);
        assert_eq!(eu.right_match_count, 1);
        assert!(!eu.left_rows.is_empty());
        assert!(!eu.right_rows.is_empty());
        assert_eq!(out.right_columns.iter().any(|c| c.name == "region_name"), true);
    }

    #[test]
    fn explain_offsets_when_select_drops_join_key() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
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
                        // Drop join key from the visible select.
                        TransformationStep::SelectColumns {
                            columns: vec![
                                "amount".into(),
                                "qty".into(),
                                "region_name".into(),
                            ],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
        };
        let db = DbSession::new().unwrap();
        let out =
            explain_join_rows(&db, &ws, &[], "fact", 1, &[], Some(&[0, 1])).unwrap();
        assert_eq!(out.explanations.len(), 2);
        assert!(!out.explanations[0].key_values.is_empty());
        assert!(out.explanations[0].right_match_count >= 1);
    }
}
