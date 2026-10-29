//! Join Lens — row-level where-provenance for Join investigation (perf-conscious).
//!
//! Client should request only keys for visible / focused result rows, debounce,
//! and cache by fingerprint. Server caps batch size and matches per side.

use crate::arrow_json::{array_value_to_json, map_arrow_type};
use crate::preview::ColumnMetadata;
use crate::session::DbSession;
use dwh_pipeline::{
    ascii_fold_name, cte_name, emit_transform_step, escape_sql_string, quote_ident, ConnectionDef,
    GraphCompiler, TransformationStep, WarehouseDialect, Workspace,
};
use duckdb::arrow::array::*;
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};

/// Max distinct key tuples / preview offsets per `explain_join_rows` call.
pub const JOIN_LENS_MAX_KEYS: usize = 24;
/// Max matching input rows returned per side after pinning to the result row.
pub const JOIN_LENS_MAX_MATCHES: usize = 6;
/// Candidate key-matches fetched before pin (ORDER BY 1 is arbitrary — need headroom).
pub const JOIN_LENS_CANDIDATE_MATCHES: usize = 48;

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

    // Offsets mode: one explanation per preview row (no key-dedupe) so Left/Right
    // can pin to *this* result row instead of the first key match.
    let offset_ctx: Option<OffsetResolve> = if keys.is_empty() {
        let offs = preview_offsets
            .filter(|o| !o.is_empty())
            .ok_or_else(|| "explain_join_rows: provide keys or preview_offsets".to_string())?;
        if offs.len() > JOIN_LENS_MAX_KEYS {
            return Err(format!(
                "explain_join_rows: at most {JOIN_LENS_MAX_KEYS} offsets (got {})",
                offs.len()
            ));
        }
        let compiled = GraphCompiler::new(&resolved).compile_ctes_from(host_query_id)?;
        Some(resolve_preview_offsets(
            db,
            &compiled.definitions,
            &compiled.last_by_query,
            host_query_id,
            join_step_index,
            &host.steps,
            left_on,
            offs,
        )?)
    } else {
        None
    };

    let owned_keys: Vec<JoinKeyTuple> = if let Some(ctx) = &offset_ctx {
        ctx.keys.clone()
    } else {
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
    };

    if owned_keys.len() > JOIN_LENS_MAX_KEYS {
        return Err(format!(
            "explain_join_rows: at most {JOIN_LENS_MAX_KEYS} keys per call (got {})",
            owned_keys.len()
        ));
    }

    // Key mode: dedupe. Offset mode: keep 1:1 with preview rows.
    let (batch_keys, fingerprints, pin_results): (
        Vec<JoinKeyTuple>,
        Vec<String>,
        Option<(Vec<ColumnMetadata>, Vec<Vec<JsonValue>>)>,
    ) = if let Some(ctx) = &offset_ctx {
        let fps: Vec<String> = (0..ctx.keys.len())
            .map(|i| format!("off:{}", i))
            .collect();
        (
            ctx.keys.clone(),
            fps,
            Some((ctx.columns.clone(), ctx.rows.clone())),
        )
    } else {
        let mut seen = HashSet::new();
        let mut unique: Vec<JoinKeyTuple> = Vec::new();
        let mut fps: Vec<String> = Vec::new();
        for k in &owned_keys {
            let fp = fingerprint_key(&k.values);
            if seen.insert(fp.clone()) {
                unique.push(k.clone());
                fps.push(fp);
            }
        }
        (unique, fps, None)
    };
    let batch_refs: Vec<&JoinKeyTuple> = batch_keys.iter().collect();

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

    let compiled = GraphCompiler::new(&resolved).compile_ctes_from(host_query_id)?;
    let batch_sql = values_batch_sql(&batch_refs, left_on.len())?;
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
    // Fetch a wider candidate pool so pin can find the real parent, then trim.
    let cand_m = if pin_results.is_some() {
        JOIN_LENS_CANDIDATE_MATCHES
    } else {
        JOIN_LENS_MAX_MATCHES
    };

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
         ) x WHERE _rn <= {cand_m}\n\
         ORDER BY _ord, _rn"
    );
    let right_samp_sql = format!(
        "{with_prefix}\n\
         SELECT _ord, * EXCLUDE (_ord, _rn) FROM (\n\
           SELECT b.ord AS _ord, r.*,\n\
             ROW_NUMBER() OVER (PARTITION BY b.ord ORDER BY 1) AS _rn\n\
           FROM batch b\n\
           INNER JOIN {right_cte} r ON {right_on_join}\n\
         ) x WHERE _rn <= {cand_m}\n\
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

    let (left_columns, mut left_by_ord) = fetch_side_samples(db, &left_samp_sql)?;
    let (right_columns, mut right_by_ord) = fetch_side_samples(db, &right_samp_sql)?;

    if let Some((result_cols, result_rows)) = &pin_results {
        let left_names: Vec<String> = left_columns.iter().map(|c| c.name.clone()).collect();
        let right_names: Vec<String> = right_columns.iter().map(|c| c.name.clone()).collect();
        let result_names: Vec<String> = result_cols.iter().map(|c| c.name.clone()).collect();
        for (i, result_row) in result_rows.iter().enumerate() {
            let ord = i as i64;
            if let Some(rows) = left_by_ord.get_mut(&ord) {
                *rows = pin_side_rows(
                    rows,
                    &left_names,
                    result_row,
                    &result_names,
                    left_on,
                    right_on,
                    true,
                );
            }
            if let Some(rows) = right_by_ord.get_mut(&ord) {
                *rows = pin_side_rows(
                    rows,
                    &right_names,
                    result_row,
                    &result_names,
                    left_on,
                    right_on,
                    false,
                );
            }
        }
    }

    let mut explanations = Vec::with_capacity(batch_keys.len());
    for (i, k) in batch_keys.iter().enumerate() {
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

struct OffsetResolve {
    keys: Vec<JoinKeyTuple>,
    columns: Vec<ColumnMetadata>,
    /// Full preview rows aligned with `keys` / request offset order.
    rows: Vec<Vec<JsonValue>>,
}

fn step_kind_label(step: &TransformationStep) -> &'static str {
    match step {
        TransformationStep::LoadCsv { .. } => "LoadCsv",
        TransformationStep::LoadParquet { .. } => "LoadParquet",
        TransformationStep::LoadPostgres { .. } => "LoadPostgres",
        TransformationStep::FromQuery { .. } => "FromQuery",
        TransformationStep::SqlModel { .. } => "SqlModel",
        TransformationStep::Filter { .. } => "Filter",
        TransformationStep::SelectColumns { .. } => "SelectColumns",
        TransformationStep::RenameColumn { .. } => "RenameColumn",
        TransformationStep::DeriveColumn { .. } => "DeriveColumn",
        TransformationStep::GroupBy { .. } => "GroupBy",
        TransformationStep::SortBy { .. } => "SortBy",
        TransformationStep::Limit { .. } => "Limit",
        TransformationStep::Join { .. } => "Join",
        TransformationStep::Append { .. } => "Append",
        TransformationStep::CustomSql { .. } => "CustomSql",
        TransformationStep::NormalizeKey { .. } => "NormalizeKey",
        TransformationStep::ApplyKeyMap { .. } => "ApplyKeyMap",
    }
}

/// Rebuild post-Join steps while always retaining `left_on` keys (even if SelectColumns dropped them).
/// Returns join keys **and** full preview rows so Left/Right can pin to this result row.
fn resolve_preview_offsets(
    db: &DbSession,
    workspace_cte_defs: &str,
    last_by_query: &HashMap<String, String>,
    host_query_id: &str,
    join_step_index: usize,
    steps: &[TransformationStep],
    left_on: &[String],
    offsets: &[u64],
) -> Result<OffsetResolve, String> {
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
            TransformationStep::Join {
                right_query_id,
                join_type,
                left_on: j_left,
                right_on: j_right,
            } => {
                // Chained Join after the explained Join (e.g. two RIGHT OUTER).
                // Keep *original* key_names — we still pin to the earlier Join's ON.
                let right_cte = last_by_query.get(right_query_id).ok_or_else(|| {
                    format!(
                        "Join Lens: right query '{right_query_id}' missing from compiled CTEs"
                    )
                })?;
                let join_kw = join_type.sql_keyword();
                if j_left == j_right {
                    let using = j_left
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "SELECT * FROM {prev} AS l {join_kw} {right_cte} AS r USING ({using})"
                    )
                } else {
                    emit_transform_step(
                        step,
                        &prev,
                        last_by_query,
                        WarehouseDialect::Duckdb,
                    )?
                }
            }
            other => {
                return Err(format!(
                    "Join Lens: cannot recover keys after {} (offsets mode). Keep join keys in the result or select the Join step (Data previews through that Join).",
                    step_kind_label(other)
                ));
            }
        };
        extras.push(format!("  {name} AS ({body})"));
        prev = name;
    }

    let off_list = offsets
        .iter()
        .map(|o| o.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    // Full preview rows (LIMIT 50 = preview window) for pin + key extraction.
    let sql = format!(
        "WITH \n{workspace_cte_defs},\n{}\n,\n  lens_numbered AS (\n\
           SELECT ROW_NUMBER() OVER () - 1 AS __off, *\n\
           FROM {prev}\n\
           LIMIT 50\n\
         )\n\
         SELECT * FROM lens_numbered WHERE __off IN ({off_list})\n\
         ORDER BY __off",
        extras.join(",\n"),
    );

    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("lens offsets: {e}"))?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        if schema.fields().is_empty() {
            return Err("lens offsets: empty schema".into());
        }
        // col 0 = __off; rest = preview columns
        let columns: Vec<ColumnMetadata> = schema
            .fields()
            .iter()
            .skip(1)
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_type(f.data_type()),
            })
            .collect();
        let key_idx: Vec<usize> = key_names
            .iter()
            .map(|k| {
                columns
                    .iter()
                    .position(|c| ascii_fold_name(&c.name) == ascii_fold_name(k))
                    .ok_or_else(|| format!("join key '{k}' missing from preview recovery"))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut by_off: HashMap<u64, (JoinKeyTuple, Vec<JsonValue>)> = HashMap::new();
        for batch in &batches {
            let n = batch.num_rows();
            let cols = batch.num_columns();
            for r in 0..n {
                let off = cell_i64(batch.column(0).as_ref(), r)? as u64;
                let mut row = Vec::with_capacity(cols - 1);
                for c in 1..cols {
                    row.push(cell_json(batch.column(c).as_ref(), r));
                }
                let values: Vec<JsonValue> = key_idx.iter().map(|&i| row[i].clone()).collect();
                by_off.insert(off, (JoinKeyTuple { values }, row));
            }
        }

        let mut keys = Vec::with_capacity(offsets.len());
        let mut rows = Vec::with_capacity(offsets.len());
        for o in offsets {
            let (k, row) = by_off.get(o).ok_or_else(|| {
                format!("preview offset {o} out of range for Join Lens key recovery")
            })?;
            keys.push(k.clone());
            rows.push(row.clone());
        }
        Ok(OffsetResolve {
            keys,
            columns,
            rows,
        })
    })
}

fn json_values_equal(a: &JsonValue, b: &JsonValue) -> bool {
    if a == b {
        return true;
    }
    match (a, b) {
        (JsonValue::Null, JsonValue::Null) => true,
        (JsonValue::Number(n), JsonValue::String(s)) | (JsonValue::String(s), JsonValue::Number(n)) => {
            s.parse::<f64>()
                .ok()
                .and_then(|f| n.as_f64().map(|g| (f - g).abs() < f64::EPSILON))
                .unwrap_or(false)
        }
        (JsonValue::Number(n), other) | (other, JsonValue::Number(n)) => {
            other.as_f64() == n.as_f64()
                || other.as_i64() == n.as_i64()
                || other.as_u64() == n.as_u64()
        }
        _ => a.to_string() == b.to_string(),
    }
}

/// Rank/filter key-matches so the dock shows the parent of *this* result row.
fn pin_side_rows(
    side_rows: &[Vec<JsonValue>],
    side_names: &[String],
    result_row: &[JsonValue],
    result_names: &[String],
    left_on: &[String],
    right_on: &[String],
    is_left: bool,
) -> Vec<Vec<JsonValue>> {
    if side_rows.len() <= 1 {
        return side_rows
            .iter()
            .take(JOIN_LENS_MAX_MATCHES)
            .cloned()
            .collect();
    }
    let side_by_fold: HashMap<String, usize> = side_names
        .iter()
        .enumerate()
        .map(|(i, n)| (ascii_fold_name(n), i))
        .collect();
    let result_by_fold: HashMap<String, usize> = result_names
        .iter()
        .enumerate()
        .map(|(i, n)| (ascii_fold_name(n), i))
        .collect();

    let mut checks: Vec<(usize, usize, bool)> = Vec::new(); // side_idx, result_idx, is_key
    let mut used = HashSet::new();

    for (k, left_name) in left_on.iter().enumerate() {
        let Some(&result_idx) = result_by_fold.get(&ascii_fold_name(left_name)) else {
            continue;
        };
        let side_name = if is_left {
            left_name.as_str()
        } else {
            right_on.get(k).map(|s| s.as_str()).unwrap_or(left_name.as_str())
        };
        let Some(&side_idx) = side_by_fold.get(&ascii_fold_name(side_name)) else {
            continue;
        };
        if used.insert(side_idx) {
            checks.push((side_idx, result_idx, true));
        }
    }

    let key_folds: HashSet<String> = left_on.iter().map(|c| ascii_fold_name(c)).collect();
    for (result_idx, name) in result_names.iter().enumerate() {
        let f = ascii_fold_name(name);
        if key_folds.contains(&f) {
            continue;
        }
        let bare = f
            .rsplit_once("__")
            .map(|(_, b)| b.to_string())
            .unwrap_or_else(|| f.clone());
        let side_idx = side_by_fold
            .get(&f)
            .or_else(|| side_by_fold.get(&bare))
            .copied();
        let Some(side_idx) = side_idx else { continue };
        // Only pin on columns that belong to this side (name present on side).
        if used.insert(side_idx) {
            checks.push((side_idx, result_idx, false));
        }
    }

    let non_key = checks.iter().filter(|(_, _, is_key)| !*is_key).count();
    if non_key == 0 {
        return side_rows
            .iter()
            .take(JOIN_LENS_MAX_MATCHES)
            .cloned()
            .collect();
    }

    let mut scored: Vec<(usize, &Vec<JsonValue>)> = side_rows
        .iter()
        .map(|row| {
            let score = checks
                .iter()
                .filter(|(si, ri, _)| {
                    row.get(*si)
                        .zip(result_row.get(*ri))
                        .map(|(a, b)| json_values_equal(a, b))
                        .unwrap_or(false)
                })
                .count();
            (score, row)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let perfect = checks.len();
    let best = scored[0].0;
    let key_only = checks.len() - non_key;
    let out: Vec<Vec<JsonValue>> = if best == perfect {
        scored
            .iter()
            .filter(|(s, _)| *s == perfect)
            .map(|(_, r)| (*r).clone())
            .take(JOIN_LENS_MAX_MATCHES)
            .collect()
    } else if best > key_only {
        scored
            .iter()
            .filter(|(s, _)| *s == best)
            .map(|(_, r)| (*r).clone())
            .take(JOIN_LENS_MAX_MATCHES)
            .collect()
    } else {
        scored
            .iter()
            .map(|(_, r)| (*r).clone())
            .take(JOIN_LENS_MAX_MATCHES)
            .collect()
    };
    out
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
    array_value_to_json(array, row)
}

fn map_type(dt: &DataType) -> String {
    map_arrow_type(dt)
}

/// Sample / count cap for `explain_join_key` result + side grids.
pub const JOIN_LENS_KEY_SAMPLE_LIMIT: usize = 50;

/// Which Join input the key tuple was taken from.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinKeySide {
    Left,
    Right,
}

impl JoinKeySide {
    fn as_str(self) -> &'static str {
        match self {
            JoinKeySide::Left => "left",
            JoinKeySide::Right => "right",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExplainJoinKeyResult {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub right_query_id: String,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub side: String,
    pub key_values: Vec<JsonValue>,
    pub left_match_count: u64,
    pub right_match_count: u64,
    /// Full Join output rows for this key (not preview LIMIT).
    pub result_match_count: u64,
    /// `result_match_count / side_input_count` (0 if side has no rows).
    pub expansion: f64,
    pub left_columns: Vec<ColumnMetadata>,
    pub right_columns: Vec<ColumnMetadata>,
    pub result_columns: Vec<ColumnMetadata>,
    pub left_rows: Vec<Vec<JsonValue>>,
    pub right_rows: Vec<Vec<JsonValue>>,
    pub result_rows: Vec<Vec<JsonValue>>,
    pub sample_limit: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BlameUnmatchedKeyResult {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub side: String,
    pub key_values: Vec<JsonValue>,
    pub at_source: bool,
    pub at_source_count: u64,
    pub at_join_input: bool,
    pub at_join_input_count: u64,
    pub partner_at_join: bool,
    pub partner_count: u64,
    /// First step on this side's query where the key count dropped to 0.
    pub dropped_at_step: Option<usize>,
    pub dropped_at_step_kind: Option<String>,
    /// `absent_at_source` | `filtered_upstream` | `no_partner` | `present_on_both`
    pub verdict: String,
}

/// Explain one join key: how many result / left / right rows, with samples.
pub fn explain_join_key(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
    side: JoinKeySide,
    key_values: &[JsonValue],
) -> Result<ExplainJoinKeyResult, String> {
    let ctx = join_key_context(db, workspace, connections, host_query_id, join_step_index)?;
    if key_values.len() != ctx.left_on.len() {
        return Err(format!(
            "key arity {} != left_on {}",
            key_values.len(),
            ctx.left_on.len()
        ));
    }
    let tuple = JoinKeyTuple {
        values: key_values.to_vec(),
    };
    let batch_sql = values_batch_sql(&[&tuple], ctx.left_on.len())?;
    let with_prefix = format!("WITH \n{},\n{batch_sql}", ctx.compiled.definitions);

    let left_on_join = ctx
        .left_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("l.{} = b.k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let right_on_join = ctx
        .right_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("r.{} = b.k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let result_on_join = ctx
        .left_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("j.{} = b.k{i}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" AND ");

    let lim = JOIN_LENS_KEY_SAMPLE_LIMIT;
    let left_count = scalar_count(
        db,
        &format!(
            "{with_prefix}\nSELECT COUNT(*)::BIGINT FROM {left} l, batch b WHERE {left_on_join}",
            left = ctx.left_cte
        ),
    )?;
    let right_count = scalar_count(
        db,
        &format!(
            "{with_prefix}\nSELECT COUNT(*)::BIGINT FROM {right} r, batch b WHERE {right_on_join}",
            right = ctx.right_cte
        ),
    )?;
    let result_count = scalar_count(
        db,
        &format!(
            "{with_prefix}\nSELECT COUNT(*)::BIGINT FROM {join} j, batch b WHERE {result_on_join}",
            join = ctx.join_cte
        ),
    )?;

    let (left_columns, left_rows) = fetch_plain_sample(
        db,
        &format!(
            "{with_prefix}\n\
             SELECT l.* FROM {left} l, batch b WHERE {left_on_join} LIMIT {lim}",
            left = ctx.left_cte
        ),
    )?;
    let (right_columns, right_rows) = fetch_plain_sample(
        db,
        &format!(
            "{with_prefix}\n\
             SELECT r.* FROM {right} r, batch b WHERE {right_on_join} LIMIT {lim}",
            right = ctx.right_cte
        ),
    )?;
    let (result_columns, result_rows) = fetch_plain_sample(
        db,
        &format!(
            "{with_prefix}\n\
             SELECT j.* FROM {join} j, batch b WHERE {result_on_join} LIMIT {lim}",
            join = ctx.join_cte
        ),
    )?;

    let side_count = match side {
        JoinKeySide::Left => left_count,
        JoinKeySide::Right => right_count,
    };
    let expansion = if side_count == 0 {
        0.0
    } else {
        result_count as f64 / side_count as f64
    };

    Ok(ExplainJoinKeyResult {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        right_query_id: ctx.right_query_id,
        left_on: ctx.left_on,
        right_on: ctx.right_on,
        side: side.as_str().to_string(),
        key_values: key_values.to_vec(),
        left_match_count: left_count,
        right_match_count: right_count,
        result_match_count: result_count,
        expansion,
        left_columns,
        right_columns,
        result_columns,
        left_rows,
        right_rows,
        result_rows,
        sample_limit: lim,
    })
}

/// Why a key has no join partner / disappeared: source vs join-input vs no partner.
pub fn blame_unmatched_key(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
    side: JoinKeySide,
    key_values: &[JsonValue],
) -> Result<BlameUnmatchedKeyResult, String> {
    let ctx = join_key_context(db, workspace, connections, host_query_id, join_step_index)?;
    if key_values.len() != ctx.left_on.len() {
        return Err(format!(
            "key arity {} != left_on {}",
            key_values.len(),
            ctx.left_on.len()
        ));
    }

    let (query_id, join_input_step, key_names_at_join) = match side {
        JoinKeySide::Left => (
            host_query_id.to_string(),
            join_step_index - 1,
            ctx.left_on.clone(),
        ),
        JoinKeySide::Right => {
            let rq = ctx
                .resolved_right_steps_len
                .checked_sub(1)
                .ok_or_else(|| "right query has no steps".to_string())?;
            (ctx.right_query_id.clone(), rq, ctx.right_on.clone())
        }
    };

    let side_steps: Vec<TransformationStep> = match side {
        JoinKeySide::Left => {
            let host = ctx
                .resolved
                .query(host_query_id)
                .ok_or_else(|| format!("missing host '{host_query_id}'"))?;
            host.steps[..=join_input_step].to_vec()
        }
        JoinKeySide::Right => {
            let rq = ctx
                .resolved
                .query(&ctx.right_query_id)
                .ok_or_else(|| format!("missing right '{}'", ctx.right_query_id))?;
            rq.steps.clone()
        }
    };

    let source_keys =
        key_names_at_step(&side_steps, 0, join_input_step, &key_names_at_join);
    let source_cte = cte_name(&query_id, 0);
    let join_input_cte = cte_name(&query_id, join_input_step);

    let with_prefix = format!("WITH \n{}", ctx.compiled.definitions);
    let at_source_count =
        count_in_cte(db, &with_prefix, &source_cte, &source_keys, key_values).unwrap_or(0);
    let at_join_input_count = count_in_cte(
        db,
        &with_prefix,
        &join_input_cte,
        &key_names_at_join,
        key_values,
    )?;

    let (partner_cte, partner_keys) = match side {
        JoinKeySide::Left => (ctx.right_cte.clone(), ctx.right_on.clone()),
        JoinKeySide::Right => (ctx.left_cte.clone(), ctx.left_on.clone()),
    };
    let partner_count =
        count_in_cte(db, &with_prefix, &partner_cte, &partner_keys, key_values)?;

    let mut dropped_at_step: Option<usize> = None;
    let mut dropped_at_step_kind: Option<String> = None;
    if at_source_count > 0 && at_join_input_count == 0 {
        let mut prev = at_source_count;
        for step_i in 1..=join_input_step {
            let names =
                key_names_at_step(&side_steps, step_i, join_input_step, &key_names_at_join);
            let cte = cte_name(&query_id, step_i);
            let n = count_in_cte(db, &with_prefix, &cte, &names, key_values).unwrap_or(0);
            if prev > 0 && n == 0 {
                dropped_at_step = Some(step_i);
                dropped_at_step_kind = side_steps
                    .get(step_i)
                    .map(|s| step_kind_label(s).to_string());
                break;
            }
            prev = n;
        }
    }

    let at_source = at_source_count > 0;
    let at_join_input = at_join_input_count > 0;
    let partner_at_join = partner_count > 0;
    let verdict = if !at_source {
        "absent_at_source"
    } else if at_source && !at_join_input {
        "filtered_upstream"
    } else if at_join_input && !partner_at_join {
        "no_partner"
    } else {
        "present_on_both"
    };

    Ok(BlameUnmatchedKeyResult {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        side: side.as_str().to_string(),
        key_values: key_values.to_vec(),
        at_source,
        at_source_count,
        at_join_input,
        at_join_input_count,
        partner_at_join,
        partner_count,
        dropped_at_step,
        dropped_at_step_kind,
        verdict: verdict.into(),
    })
}

struct JoinKeyCtx {
    resolved: Workspace,
    compiled: dwh_pipeline::CompiledCtes,
    left_on: Vec<String>,
    right_on: Vec<String>,
    right_query_id: String,
    left_cte: String,
    right_cte: String,
    join_cte: String,
    resolved_right_steps_len: usize,
}

fn join_key_context(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinKeyCtx, String> {
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
    let rq = resolved
        .query(right_query_id)
        .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
    if rq.steps.is_empty() {
        return Err(format!("right query '{right_query_id}' has no steps"));
    }
    let compiled = GraphCompiler::new(&resolved).compile_ctes_from(host_query_id)?;
    Ok(JoinKeyCtx {
        left_cte: cte_name(host_query_id, join_step_index - 1),
        right_cte: cte_name(right_query_id, rq.steps.len() - 1),
        join_cte: cte_name(host_query_id, join_step_index),
        resolved_right_steps_len: rq.steps.len(),
        left_on: left_on.clone(),
        right_on: right_on.clone(),
        right_query_id: right_query_id.clone(),
        resolved,
        compiled,
    })
}

/// Walk renames backward so source-step counts use the names that existed then.
fn key_names_at_step(
    steps: &[TransformationStep],
    target_step: usize,
    names_known_at_step: usize,
    names_at_known: &[String],
) -> Vec<String> {
    let mut names = names_at_known.to_vec();
    if target_step >= names_known_at_step {
        return names;
    }
    for step in steps
        .iter()
        .enumerate()
        .take(names_known_at_step + 1)
        .skip(target_step + 1)
        .rev()
        .map(|(_, s)| s)
    {
        if let TransformationStep::RenameColumn { from, to } = step {
            for n in names.iter_mut() {
                if ascii_fold_name(n) == ascii_fold_name(to) {
                    *n = from.clone();
                }
            }
        }
    }
    names
}

fn scalar_count(db: &DbSession, sql: &str) -> Result<u64, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let n: i64 = stmt.query_row([], |row| row.get(0)).map_err(|e| e.to_string())?;
        Ok(n as u64)
    })
}

fn count_in_cte(
    db: &DbSession,
    with_prefix: &str,
    cte: &str,
    key_cols: &[String],
    key_values: &[JsonValue],
) -> Result<u64, String> {
    if key_cols.len() != key_values.len() {
        return Err("key_cols / key_values length mismatch".into());
    }
    let mut preds = Vec::with_capacity(key_cols.len());
    for (c, v) in key_cols.iter().zip(key_values.iter()) {
        let lit = json_to_sql_literal(v)?;
        if matches!(v, JsonValue::Null) {
            preds.push(format!("{} IS NULL", quote_ident(c)));
        } else {
            preds.push(format!("{} = {lit}", quote_ident(c)));
        }
    }
    let where_sql = preds.join(" AND ");
    scalar_count(
        db,
        &format!("{with_prefix}\nSELECT COUNT(*)::BIGINT FROM {cte} WHERE {where_sql}"),
    )
}

fn fetch_plain_sample(
    db: &DbSession,
    sql: &str,
) -> Result<(Vec<ColumnMetadata>, Vec<Vec<JsonValue>>), String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        let columns: Vec<ColumnMetadata> = schema
            .fields()
            .iter()
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_type(f.data_type()),
            })
            .collect();
        let mut rows = Vec::new();
        for batch in &batches {
            let n = batch.num_rows();
            let cols = batch.num_columns();
            for r in 0..n {
                let mut row = Vec::with_capacity(cols);
                for c in 0..cols {
                    row.push(cell_json(batch.column(c).as_ref(), r));
                }
                rows.push(row);
            }
        }
        Ok((columns, rows))
    })
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
            key_maps: vec![],
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
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let out =
            explain_join_rows(&db, &ws, &[], "fact", 1, &[], Some(&[0, 1])).unwrap();
        assert_eq!(out.explanations.len(), 2);
        assert!(!out.explanations[0].key_values.is_empty());
        assert!(out.explanations[0].right_match_count >= 1);
        // Side docks use join-input schemas, not the post-Select result.
        assert!(
            out.left_columns.iter().any(|c| c.name == "date"),
            "left parent must keep columns dropped from the result"
        );
        assert!(
            out.left_columns.iter().any(|c| c.name == "region"),
            "left parent must include join key"
        );
        assert!(
            out.right_columns.iter().any(|c| c.name == "region_name"),
            "right parent must be full dim row"
        );
        let left_row = &out.explanations[0].left_rows[0];
        assert_eq!(
            left_row.len(),
            out.left_columns.len(),
            "left sample is a full parent record"
        );
    }

    #[test]
    fn offset_pins_left_parent_not_first_key_match() {
        // sample.csv: row0 EU qty=3, row2 EU qty=2 — same join key, different left parent.
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
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let out = explain_join_rows(&db, &ws, &[], "fact", 1, &[], Some(&[0, 2])).unwrap();
        assert_eq!(out.explanations.len(), 2);
        let left0 = &out.explanations[0].left_rows;
        let left2 = &out.explanations[1].left_rows;
        assert_eq!(left0.len(), 1, "row0 should pin to one left parent");
        assert_eq!(left2.len(), 1, "row2 should pin to one left parent");
        // qty is column index 3 on left (date, region, amount, qty)
        let qty_idx = out
            .left_columns
            .iter()
            .position(|c| c.name == "qty")
            .expect("qty");
        assert_ne!(
            left0[0][qty_idx], left2[0][qty_idx],
            "different result rows must not share the first EU left match"
        );
    }

    #[test]
    fn explain_first_join_when_second_right_join_follows() {
        // coverage demo: Join(region) then Join(channel). Explaining join index 1
        // must replay the second Join in offsets mode (not Discriminant error).
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sparse = fixtures.join("sparse_sales.csv");
        let dim_r = fixtures.join("dim_region.csv");
        let dim_c = fixtures.join("dim_channel.csv");
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim_region".into(),
                    name: "dim_region".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim_r.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "dim_channel".into(),
                    name: "dim_channel".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim_c.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sparse_sales".into(),
                    name: "sparse_sales".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: sparse.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "coverage".into(),
                    name: "coverage".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sparse_sales".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim_region".into(),
                            join_type: JoinType::Right,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                        TransformationStep::Join {
                            right_query_id: "dim_channel".into(),
                            join_type: JoinType::Right,
                            left_on: vec!["channel".into()],
                            right_on: vec!["channel".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "coverage".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        // First Join (index 1) while second Join still follows in the query.
        let out = explain_join_rows(&db, &ws, &[], "coverage", 1, &[], Some(&[0])).unwrap();
        assert_eq!(out.explanations.len(), 1);
        assert!(
            !out.explanations[0].right_rows.is_empty()
                || out.explanations[0].right_match_count >= 1
                || !out.explanations[0].left_rows.is_empty(),
            "first Join should resolve at least one parent side: {:?}",
            out.explanations[0]
        );
        // Second Join alone (no steps after).
        let out2 = explain_join_rows(&db, &ws, &[], "coverage", 2, &[], Some(&[0])).unwrap();
        assert_eq!(out2.explanations.len(), 1);
        assert!(
            out2.right_columns.iter().any(|c| c.name == "channel_name"),
            "right parent is full dim_channel"
        );
    }

    #[test]
    fn explain_join_key_counts_result_rows() {
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
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let out = explain_join_key(
            &db,
            &ws,
            &[],
            "fact",
            1,
            JoinKeySide::Right,
            &[JsonValue::String("EU".into())],
        )
        .unwrap();
        assert_eq!(out.right_match_count, 1);
        assert!(out.result_match_count >= 1);
        assert!(!out.result_rows.is_empty());
        assert!(out.expansion >= 1.0);
    }

    #[test]
    fn blame_unmatched_key_no_partner() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sales = fixtures.join("sparse_sales.csv");
        let dim = fixtures.join("dim_channel.csv");
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
                            path: sales.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Right,
                            left_on: vec!["channel".into()],
                            right_on: vec!["channel".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        // `partner` exists only on dim_channel — no left partner.
        let blame = blame_unmatched_key(
            &db,
            &ws,
            &[],
            "fact",
            1,
            JoinKeySide::Right,
            &[JsonValue::String("partner".into())],
        )
        .unwrap();
        assert!(blame.at_join_input);
        assert_eq!(blame.verdict, "no_partner");
        assert!(!blame.partner_at_join);
    }

    #[test]
    fn blame_filtered_upstream_on_left() {
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
                        TransformationStep::Filter {
                            condition: "region <> 'EU'".into(),
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
        let db = DbSession::new().unwrap();
        let blame = blame_unmatched_key(
            &db,
            &ws,
            &[],
            "fact",
            2,
            JoinKeySide::Left,
            &[JsonValue::String("EU".into())],
        )
        .unwrap();
        assert_eq!(blame.verdict, "filtered_upstream");
        assert!(blame.at_source);
        assert!(!blame.at_join_input);
        assert_eq!(blame.dropped_at_step, Some(1));
        assert_eq!(blame.dropped_at_step_kind.as_deref(), Some("Filter"));
    }
}
