//! Fuzzy join-key suggestions for Join Lens Auto.
//!
//! Shared Rust matching scores unmatched left keys against right keys.
//! Suggestions are explicit From→To
//! candidates for a KeyMap — Join ON is never rewritten.
//!
//! Keys that fail the cutoff stay in `leftover_*` so the user can discuss them
//! with an LLM. Case/trim-only differences are excluded (that is NormalizeKey).

use crate::arrow_json::{array_value_to_json, map_arrow_type};
use crate::compile::compile_ctes_from;
use crate::key_match::{
    match_keys, CandidateSearch, FuzzyPair, KeyMatchOptions, MatchPolicy, MatchRecord,
};
use crate::preview::ColumnMetadata;
use crate::session::DbSession;
use duckdb::params;
use dwh_pipeline::{
    cte_name, escape_sql_string, quote_ident, CompiledCtes, ConnectionDef, TransformationStep,
    Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashSet;

const SCORE_CUTOFF: f64 = 0.88;
const KEY_SCAN_CAP: usize = 200;
const MAX_SUGGESTIONS: usize = 40;
const MAX_KEY_CHARS: usize = 200;
const CONTEXT_SAMPLE_KEYS: usize = 25;
const CONTEXT_SIDE_COLS: usize = 6;
const CONTEXT_MAP_ENTRIES: usize = 40;
const CONTEXT_VALUE_CHARS: usize = 80;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FuzzyFieldSample {
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FuzzyKeySample {
    pub key: String,
    pub fields: Vec<FuzzyFieldSample>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FuzzyAliasExample {
    pub map_id: String,
    pub map_name: String,
    pub from: String,
    pub to: String,
}

/// Domain context packed for the leftover LLM chat (not used by fuzzy scoring).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FuzzyChatContext {
    pub left_query_id: String,
    pub left_query_name: String,
    pub right_query_id: String,
    pub right_query_name: String,
    /// Short step summary of the left join input (loads / filters / …).
    pub left_lineage: String,
    pub right_lineage: String,
    pub left_columns: Vec<ColumnMetadata>,
    pub right_columns: Vec<ColumnMetadata>,
    /// One sample row (key + neighbor cols) per leftover key, capped.
    pub leftover_left_samples: Vec<FuzzyKeySample>,
    pub leftover_right_samples: Vec<FuzzyKeySample>,
    /// Existing KeyMap From→To rows the model may treat as domain examples.
    pub existing_aliases: Vec<FuzzyAliasExample>,
    /// Distinct right-side key values Auto/LLM may use as To (incl. already-matched).
    #[serde(default)]
    pub right_to_universe: Vec<String>,
    /// True when prompt-side lists were truncated for size.
    #[serde(default)]
    pub context_truncated: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinKeyFuzzySuggest {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    /// Similarity metric; implemented by the shared Rust matcher.
    pub metric: String,
    pub score_cutoff: f64,
    pub suggestions: Vec<FuzzyPair>,
    /// Unmatched left keys with no accepted suggestion (chat input).
    pub leftover_left: Vec<String>,
    pub leftover_right: Vec<String>,
    pub scanned_left: u64,
    pub scanned_right: u64,
    pub unmatched_left_total: u64,
    pub unmatched_right_total: u64,
    /// Distinct unmatched keys exceeded the scan cap.
    pub truncated: bool,
    /// When set, Auto did not score (e.g. composite join keys).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    pub chat_context: FuzzyChatContext,
}

/// Suggest left→right alias pairs for keys that do not already match exactly.
///
/// `key_index`: which Join ON column to score when `left_on.len() > 1`
/// ([ADR-0024](../../../docs/adr/0024-keymap-composite.md) per-column mode).
/// `None` / `Some(0)` for single-key Joins. Out of range → error.
pub fn join_key_fuzzy_suggest(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[dwh_pipeline::SourceDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinKeyFuzzySuggest, String> {
    join_key_fuzzy_suggest_on(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        None,
        None,
        None,
    )
}

/// Like [`join_key_fuzzy_suggest`] with explicit Join key index (per-column) or composite-map mode.
pub fn join_key_fuzzy_suggest_on(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[dwh_pipeline::SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    key_index: Option<usize>,
    composite_indices: Option<Vec<usize>>,
    composite_fuzzy_slot: Option<usize>,
) -> Result<JoinKeyFuzzySuggest, String> {
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
    let rq = resolved
        .query(right_query_id)
        .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
    if rq.steps.is_empty() {
        return Err(format!("right query '{right_query_id}' has no steps"));
    }
    let left_cte = cte_name(host_query_id, join_step_index - 1);
    let right_cte = cte_name(right_query_id, rq.steps.len() - 1);
    let compiled = compile_ctes_from(db, &resolved, connections, sources, host_query_id)?;
    let left_query_name = host.name.clone();
    let right_query_name = rq.name.clone();
    let right_query_id = right_query_id.clone();
    let left_on = left_on.clone();
    let right_on = right_on.clone();
    let left_lineage = summarize_lineage(&host.steps[..join_step_index]);
    let right_lineage = summarize_lineage(&rq.steps);
    let left_columns = describe_cte(db, &compiled, &left_cte).unwrap_or_default();
    let right_columns = describe_cte(db, &compiled, &right_cte).unwrap_or_default();
    let existing_aliases = collect_alias_examples(workspace);

    // Composite-map mode ([ADR-0024]): exact on non-fuzzy cols + fuzzy on primary slot.
    if let Some(indices) = composite_indices.as_ref() {
        if indices.len() >= 2 {
            return join_key_fuzzy_suggest_composite(
                db,
                workspace,
                host_query_id,
                join_step_index,
                &compiled,
                &left_cte,
                &right_cte,
                &left_on,
                &right_on,
                left_query_name,
                right_query_name,
                right_query_id,
                left_lineage,
                right_lineage,
                left_columns,
                right_columns,
                existing_aliases,
                indices,
                composite_fuzzy_slot.unwrap_or(0),
            );
        }
    }

    // Per-column mode on composite Join ([ADR-0024]). No glued " · " From values.
    let key_i = if left_on.len() == 1 {
        0usize
    } else {
        match key_index {
            Some(i) if i < left_on.len() => i,
            Some(i) => {
                return Err(format!(
                    "key_index {i} out of range for Join with {} keys",
                    left_on.len()
                ));
            }
            None => {
                return Ok(JoinKeyFuzzySuggest {
                    host_query_id: host_query_id.to_string(),
                    join_step_index,
                    left_on: left_on.clone(),
                    right_on: right_on.clone(),
                    metric: "jaro_winkler_similarity".into(),
                    score_cutoff: SCORE_CUTOFF,
                    suggestions: vec![],
                    leftover_left: vec![],
                    leftover_right: vec![],
                    scanned_left: 0,
                    scanned_right: 0,
                    unmatched_left_total: 0,
                    unmatched_right_total: 0,
                    truncated: false,
                    disabled_reason: Some(format!(
                        "This Join has {} keys ({}). Choose per-column Suggest (which key to remap) or composite-map mode — do not glue columns into one From.",
                        left_on.len(),
                        left_on.join(", ")
                    )),
                    chat_context: FuzzyChatContext {
                        left_query_id: host_query_id.to_string(),
                        left_query_name,
                        right_query_id,
                        right_query_name,
                        left_lineage,
                        right_lineage,
                        left_columns,
                        right_columns,
                        leftover_left_samples: vec![],
                        leftover_right_samples: vec![],
                        existing_aliases,
                        right_to_universe: vec![],
                        context_truncated: false,
                    },
                });
            }
        }
    };
    let left_key_cols = vec![left_on[key_i].clone()];
    let right_key_cols = vec![right_on[key_i].clone()];

    let lkey = key_expr("l", &left_key_cols);
    let rkey = key_expr("r", &right_key_cols);

    let left_keys_sql = format!(
        "SELECT DISTINCT {lkey} AS k FROM {left_cte} l\n\
         WHERE {lkey} IS NOT NULL AND length(trim({lkey})) > 0"
    );
    let right_keys_sql = format!(
        "SELECT DISTINCT {rkey} AS k FROM {right_cte} r\n\
         WHERE {rkey} IS NOT NULL AND length(trim({rkey})) > 0"
    );
    let counts_sql = compiled.wrap_select(&format!(
        "SELECT\n\
           (SELECT count(*) FROM ({left_keys_sql}) lk ANTI JOIN ({right_keys_sql}) rk USING (k))::BIGINT,\n\
           (SELECT count(*) FROM ({right_keys_sql}) rk ANTI JOIN ({left_keys_sql}) lk USING (k))::BIGINT"
    ));
    let (unmatched_left_total, unmatched_right_total) = query_pair_counts(db, &counts_sql)?;

    // From = unmatched left. To candidates = ALL distinct right keys (incl. ones that
    // already match other left rows) — alias maps are many-to-one.
    let keys_sql = compiled.wrap_select(&format!(
        "SELECT side, k FROM (\n\
           SELECT 'left' AS side, k FROM ({left_keys_sql}) lk\n\
           ANTI JOIN ({right_keys_sql}) rk USING (k)\n\
           ORDER BY k LIMIT {cap}\n\
         ) only_left\n\
         UNION ALL\n\
         SELECT side, k FROM (\n\
           SELECT 'right' AS side, k FROM ({right_keys_sql}) rk\n\
           ORDER BY k LIMIT {cap}\n\
         ) all_right\n\
         UNION ALL\n\
         SELECT side, k FROM (\n\
           SELECT 'unmatched_right' AS side, k FROM ({right_keys_sql}) rk\n\
           ANTI JOIN ({left_keys_sql}) lk USING (k)\n\
           ORDER BY k LIMIT {cap}\n\
         ) only_right",
        cap = KEY_SCAN_CAP
    ));
    let (mut left_keys, mut right_to_candidates, mut unmatched_right_keys) =
        query_three_side_keys(db, &keys_sql)?;
    let truncated = unmatched_left_total > left_keys.len() as u64
        || unmatched_right_total > unmatched_right_keys.len() as u64;

    let mut leftover_left = Vec::new();
    left_keys.retain(|k| {
        let n = k.trim().chars().count();
        if (3..MAX_KEY_CHARS).contains(&n) {
            true
        } else {
            leftover_left.push(k.clone());
            false
        }
    });
    right_to_candidates.retain(|k| {
        let n = k.trim().chars().count();
        (3..MAX_KEY_CHARS).contains(&n)
    });
    unmatched_right_keys.retain(|k| {
        let n = k.trim().chars().count();
        (3..MAX_KEY_CHARS).contains(&n)
    });

    let scanned_left = left_keys.len() as u64;
    let scanned_right = right_to_candidates.len() as u64;
    let records = |keys: &[String]| {
        keys.iter()
            .map(|key| MatchRecord {
                key: key.clone(),
                label: key.clone(),
            })
            .collect::<Vec<_>>()
    };
    let mut suggestions = match_keys(
        &records(&left_keys),
        &records(&right_to_candidates),
        KeyMatchOptions::default(),
        MatchPolicy::JoinKeyTypos,
        CandidateSearch::Exhaustive,
    );
    // Preserve Join Lens's existing cap and score-first display order.
    suggestions.truncate(MAX_SUGGESTIONS);
    suggestions.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.from_key.cmp(&b.from_key))
    });
    let used_from: HashSet<&str> = suggestions.iter().map(|p| p.from_key.as_str()).collect();
    for k in left_keys {
        if !used_from.contains(k.as_str()) {
            leftover_left.push(k);
        }
    }
    // Unmatched right stays available for LLM even if some To values are reused.
    let mut leftover_right = unmatched_right_keys;
    leftover_left.sort();
    leftover_right.sort();
    leftover_left.dedup();
    leftover_right.dedup();

    const UNIVERSE_CAP: usize = 60;
    let context_truncated = right_to_candidates.len() > UNIVERSE_CAP
        || leftover_left.len() > CONTEXT_SAMPLE_KEYS
        || leftover_right.len() > CONTEXT_SAMPLE_KEYS;
    let right_to_universe: Vec<String> = right_to_candidates
        .iter()
        .take(UNIVERSE_CAP)
        .cloned()
        .collect();

    let leftover_left_samples = sample_key_rows(
        db,
        &compiled,
        &left_cte,
        &left_on,
        &leftover_left,
        &left_columns,
    )
    .unwrap_or_default();
    let leftover_right_samples = sample_key_rows(
        db,
        &compiled,
        &right_cte,
        &right_on,
        &leftover_right,
        &right_columns,
    )
    .unwrap_or_default();

    Ok(JoinKeyFuzzySuggest {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        left_on,
        right_on,
        metric: "jaro_winkler_similarity".into(),
        score_cutoff: SCORE_CUTOFF,
        suggestions,
        leftover_left,
        leftover_right,
        scanned_left,
        scanned_right,
        unmatched_left_total,
        unmatched_right_total,
        truncated,
        disabled_reason: None,
        chat_context: FuzzyChatContext {
            left_query_id: host_query_id.to_string(),
            left_query_name,
            right_query_id,
            right_query_name,
            left_lineage,
            right_lineage,
            left_columns,
            right_columns,
            leftover_left_samples,
            leftover_right_samples,
            existing_aliases,
            right_to_universe,
            context_truncated,
        },
    })
}

fn key_expr(alias: &str, cols: &[String]) -> String {
    let parts: Vec<String> = cols
        .iter()
        .map(|c| format!("CAST({alias}.{} AS VARCHAR)", quote_ident(c)))
        .collect();
    if parts.len() == 1 {
        return parts[0].clone();
    }
    let null_guard = cols
        .iter()
        .map(|c| format!("{alias}.{} IS NULL", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!(
        "CASE WHEN {null_guard} THEN NULL ELSE {} END",
        parts.join(" || ' · ' || ")
    )
}

fn summarize_lineage(steps: &[TransformationStep]) -> String {
    if steps.is_empty() {
        return "(empty)".into();
    }
    let parts: Vec<String> = steps
        .iter()
        .map(|s| match s {
            TransformationStep::LoadCsv { path } => {
                format!("LoadCsv({})", short_path(path))
            }
            TransformationStep::LoadParquet { path, .. } => {
                format!("LoadParquet({})", short_path(path))
            }
            TransformationStep::LoadPostgres {
                schema, table_name, ..
            } => format!("LoadPostgres({schema}.{table_name})"),
            TransformationStep::LoadDuckdb {
                schema, table_name, ..
            } => format!("LoadDuckdb({schema}.{table_name})"),
            TransformationStep::FromQuery { query_id } => format!("FromQuery({query_id})"),
            TransformationStep::SqlModel { .. } => "SqlModel".into(),
            TransformationStep::Filter { condition } => {
                format!("Filter({})", truncate_chars(condition, 48))
            }
            TransformationStep::SelectColumns { columns } => {
                format!("SelectColumns({})", columns.join(","))
            }
            TransformationStep::RenameColumn { from, to } => format!("Rename({from}→{to})"),
            TransformationStep::DeriveColumn { name, .. } => format!("Derive({name})"),
            TransformationStep::GroupBy { dimensions, .. } => {
                format!("GroupBy({})", dimensions.join(","))
            }
            TransformationStep::SortBy { column, .. } => format!("SortBy({column})"),
            TransformationStep::Limit { n } => format!("Limit({n})"),
            TransformationStep::Join {
                right_query_id,
                left_on,
                right_on,
                ..
            } => format!(
                "Join({right_query_id} on {}={})",
                left_on.join("+"),
                right_on.join("+")
            ),
            TransformationStep::Append { other_query_ids } => {
                format!("Append({})", other_query_ids.join(","))
            }
            TransformationStep::CustomSql { .. } => "CustomSql".into(),
            TransformationStep::NormalizeKey { columns, ops } => {
                format!("NormalizeKey({} {:?})", columns.join(","), ops)
            }
            TransformationStep::ApplyKeyMap { column, map_id, .. } => {
                format!("ApplyKeyMap({column}←{map_id})")
            }
        })
        .collect();
    parts.join(" → ")
}

fn short_path(path: &str) -> String {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    truncate_chars(name, 64)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn describe_cte(
    db: &DbSession,
    compiled: &CompiledCtes,
    cte: &str,
) -> Result<Vec<ColumnMetadata>, String> {
    let sql = compiled.wrap_select(&format!("SELECT * FROM {cte} LIMIT 0"));
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let _batches: Vec<_> = arrow.collect();
        Ok(schema
            .fields()
            .iter()
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_arrow_type(f.data_type()),
            })
            .collect())
    })
}

fn pick_context_columns(all: &[ColumnMetadata], key_cols: &[String]) -> Vec<String> {
    let key_fold: HashSet<String> = key_cols.iter().map(|c| c.to_ascii_lowercase()).collect();
    let mut out: Vec<String> = key_cols.to_vec();
    for col in all {
        if out.len() >= CONTEXT_SIDE_COLS {
            break;
        }
        if key_fold.contains(&col.name.to_ascii_lowercase()) {
            continue;
        }
        out.push(col.name.clone());
    }
    if out.is_empty() {
        out.extend(all.iter().take(CONTEXT_SIDE_COLS).map(|c| c.name.clone()));
    }
    out
}

fn sample_key_rows(
    db: &DbSession,
    compiled: &CompiledCtes,
    cte: &str,
    key_cols: &[String],
    leftovers: &[String],
    columns: &[ColumnMetadata],
) -> Result<Vec<FuzzyKeySample>, String> {
    let keys: Vec<&String> = leftovers.iter().take(CONTEXT_SAMPLE_KEYS).collect();
    if keys.is_empty() || key_cols.is_empty() {
        return Ok(Vec::new());
    }
    let proj = pick_context_columns(columns, key_cols);
    if proj.is_empty() {
        return Ok(Vec::new());
    }
    let key = key_expr("t", key_cols);
    let vals = values_list(&keys.iter().map(|s| (*s).clone()).collect::<Vec<_>>());
    let inner_proj = proj
        .iter()
        .map(|c| format!("t.{} AS {}", quote_ident(c), quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let outer_proj = proj
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = compiled.wrap_select(&format!(
        "SELECT __join_key, {outer_proj}\n\
         FROM (\n\
           SELECT {key} AS __join_key, {inner_proj},\n\
             row_number() OVER (PARTITION BY {key} ORDER BY 1) AS __rn\n\
           FROM {cte} t\n\
           WHERE {key} IN (SELECT * FROM (VALUES {vals}) v(k))\n\
         ) s\n\
         WHERE s.__rn = 1\n\
         LIMIT {CONTEXT_SAMPLE_KEYS}"
    ));
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<_> = arrow.collect();
        let names: Vec<String> = schema.fields().iter().map(|f| f.name().clone()).collect();
        let mut out = Vec::new();
        for batch in &batches {
            for row_i in 0..batch.num_rows() {
                let mut key_s = String::new();
                let mut fields = Vec::new();
                for (col_i, name) in names.iter().enumerate() {
                    let cell = array_value_to_json(batch.column(col_i).as_ref(), row_i);
                    let text = json_cell_str(&cell);
                    if name == "__join_key" {
                        key_s = text;
                    } else {
                        fields.push(FuzzyFieldSample {
                            name: name.clone(),
                            value: truncate_chars(&text, CONTEXT_VALUE_CHARS),
                        });
                    }
                }
                if !key_s.is_empty() {
                    out.push(FuzzyKeySample { key: key_s, fields });
                }
            }
        }
        Ok(out)
    })
}

fn json_cell_str(v: &JsonValue) -> String {
    match v {
        JsonValue::Null => "∅".into(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn collect_alias_examples(workspace: &Workspace) -> Vec<FuzzyAliasExample> {
    let mut out = Vec::new();
    for map in &workspace.key_maps {
        for entry in &map.entries {
            let from = entry.from.trim();
            let to = entry.to.trim();
            if from.is_empty() || to.is_empty() {
                continue;
            }
            out.push(FuzzyAliasExample {
                map_id: map.id.clone(),
                map_name: map.name.clone(),
                from: truncate_chars(from, CONTEXT_VALUE_CHARS),
                to: truncate_chars(to, CONTEXT_VALUE_CHARS),
            });
            if out.len() >= CONTEXT_MAP_ENTRIES {
                return out;
            }
        }
    }
    out
}

fn values_list(keys: &[String]) -> String {
    keys.iter()
        .map(|k| format!("('{}')", escape_sql_string(k)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn query_pair_counts(db: &DbSession, sql: &str) -> Result<(u64, u64), String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let row = rows
            .next()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "fuzzy key counts: empty".to_string())?;
        let l: i64 = row.get(0).map_err(|e| e.to_string())?;
        let r: i64 = row.get(1).map_err(|e| e.to_string())?;
        Ok((l.max(0) as u64, r.max(0) as u64))
    })
}

fn query_three_side_keys(
    db: &DbSession,
    sql: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>), String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut left = Vec::new();
        let mut right_all = Vec::new();
        let mut unmatched_right = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let side: String = row.get(0).map_err(|e| e.to_string())?;
            let k: String = row.get(1).map_err(|e| e.to_string())?;
            match side.as_str() {
                "left" => left.push(k),
                "right" => right_all.push(k),
                "unmatched_right" => unmatched_right.push(k),
                _ => {}
            }
        }
        Ok((left, right_all, unmatched_right))
    })
}

/// Composite-map Suggest: From = tuple of Join keys; To = right value of fuzzy column.
/// Non-fuzzy parts must match exactly; fuzzy part uses the shared key matcher.
fn join_key_fuzzy_suggest_composite(
    db: &DbSession,
    _workspace: &Workspace,
    host_query_id: &str,
    join_step_index: usize,
    compiled: &CompiledCtes,
    left_cte: &str,
    right_cte: &str,
    left_on: &[String],
    right_on: &[String],
    left_query_name: String,
    right_query_name: String,
    right_query_id: String,
    left_lineage: String,
    right_lineage: String,
    left_columns: Vec<ColumnMetadata>,
    right_columns: Vec<ColumnMetadata>,
    existing_aliases: Vec<FuzzyAliasExample>,
    indices: &[usize],
    fuzzy_slot: usize,
) -> Result<JoinKeyFuzzySuggest, String> {
    for &i in indices {
        if i >= left_on.len() {
            return Err(format!(
                "composite index {i} out of range for Join with {} keys",
                left_on.len()
            ));
        }
    }
    if fuzzy_slot >= indices.len() {
        return Err(format!(
            "composite_fuzzy_slot {fuzzy_slot} out of range for {} composite keys",
            indices.len()
        ));
    }
    let sep = '\u{1f}';
    let left_exprs: Vec<String> = indices
        .iter()
        .map(|&i| format!("CAST(l.{} AS VARCHAR)", quote_ident(&left_on[i])))
        .collect();
    let right_exprs: Vec<String> = indices
        .iter()
        .map(|&i| format!("CAST(r.{} AS VARCHAR)", quote_ident(&right_on[i])))
        .collect();
    let left_concat = left_exprs
        .iter()
        .map(|e| format!("coalesce({e}, '')"))
        .collect::<Vec<_>>()
        .join(&format!(" || chr({}) || ", sep as u32));
    let right_concat = right_exprs
        .iter()
        .map(|e| format!("coalesce({e}, '')"))
        .collect::<Vec<_>>()
        .join(&format!(" || chr({}) || ", sep as u32));

    let left_keys_sql = format!(
        "SELECT DISTINCT {left_concat} AS k FROM {left_cte} l\n\
         WHERE length(trim({})) > 0",
        left_exprs[fuzzy_slot]
    );
    let right_keys_sql = format!(
        "SELECT DISTINCT {right_concat} AS k FROM {right_cte} r\n\
         WHERE length(trim({})) > 0",
        right_exprs[fuzzy_slot]
    );
    let keys_sql = compiled.wrap_select(&format!(
        "SELECT side, k FROM (\n\
           SELECT 'left' AS side, k FROM ({left_keys_sql}) lk\n\
           ANTI JOIN ({right_keys_sql}) rk USING (k)\n\
           ORDER BY k LIMIT {cap}\n\
         ) only_left\n\
         UNION ALL\n\
         SELECT side, k FROM (\n\
           SELECT 'right' AS side, k FROM ({right_keys_sql}) rk\n\
           ORDER BY k LIMIT {cap}\n\
         ) all_right",
        cap = KEY_SCAN_CAP
    ));

    let (left_tuples, right_tuples) = query_two_side_tuple_keys(db, &keys_sql, sep)?;
    let scanned_left = left_tuples.len() as u64;
    let scanned_right = right_tuples.len() as u64;

    // Index right by exact non-fuzzy parts → candidates on fuzzy part.
    let mut right_by_exact: std::collections::HashMap<String, Vec<(String, Vec<String>)>> =
        std::collections::HashMap::new();
    for parts in &right_tuples {
        let exact_key: String = parts
            .iter()
            .enumerate()
            .filter(|(slot, _)| *slot != fuzzy_slot)
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>()
            .join("\0");
        right_by_exact
            .entry(exact_key)
            .or_default()
            .push((parts[fuzzy_slot].clone(), parts.clone()));
    }

    let mut suggestions = Vec::new();
    let mut leftover_left = Vec::new();
    for left_parts in &left_tuples {
        let exact_key: String = left_parts
            .iter()
            .enumerate()
            .filter(|(slot, _)| *slot != fuzzy_slot)
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>()
            .join("\0");
        let Some(cands) = right_by_exact.get(&exact_key) else {
            leftover_left.push(left_parts.join(" · "));
            continue;
        };
        let left_rec = [MatchRecord {
            key: left_parts[fuzzy_slot].clone(),
            label: left_parts[fuzzy_slot].clone(),
        }];
        let right_recs: Vec<MatchRecord> = cands
            .iter()
            .map(|(fk, _)| MatchRecord {
                key: fk.clone(),
                label: fk.clone(),
            })
            .collect();
        let mut pairs = match_keys(
            &left_rec,
            &right_recs,
            KeyMatchOptions::default(),
            MatchPolicy::JoinKeyTypos,
            CandidateSearch::Exhaustive,
        );
        if pairs.is_empty() {
            leftover_left.push(left_parts.join(" · "));
            continue;
        }
        pairs.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut best = pairs.remove(0);
        best.from_key = left_parts.join(" · ");
        best.from_parts = left_parts.clone();
        // To = right fuzzy-column value (canonical key for Apply overwrite).
        suggestions.push(best);
    }
    suggestions.truncate(MAX_SUGGESTIONS);
    suggestions.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.from_key.cmp(&b.from_key))
    });

    let leftover_right: Vec<String> = Vec::new();
    let right_to_universe: Vec<String> = right_tuples
        .iter()
        .take(60)
        .map(|p| p[fuzzy_slot].clone())
        .collect();

    Ok(JoinKeyFuzzySuggest {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        left_on: left_on.to_vec(),
        right_on: right_on.to_vec(),
        metric: "jaro_winkler_similarity".into(),
        score_cutoff: SCORE_CUTOFF,
        suggestions,
        leftover_left,
        leftover_right,
        scanned_left,
        scanned_right,
        unmatched_left_total: scanned_left,
        unmatched_right_total: 0,
        truncated: false,
        disabled_reason: None,
        chat_context: FuzzyChatContext {
            left_query_id: host_query_id.to_string(),
            left_query_name,
            right_query_id,
            right_query_name,
            left_lineage,
            right_lineage,
            left_columns,
            right_columns,
            leftover_left_samples: vec![],
            leftover_right_samples: vec![],
            existing_aliases,
            right_to_universe,
            context_truncated: false,
        },
    })
}

fn query_two_side_tuple_keys(
    db: &DbSession,
    sql: &str,
    sep: char,
) -> Result<(Vec<Vec<String>>, Vec<Vec<String>>), String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("composite keys prepare: {e}"))?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut left = Vec::new();
        let mut right = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let side: String = row.get(0).map_err(|e| e.to_string())?;
            let k: String = row.get(1).map_err(|e| e.to_string())?;
            let parts: Vec<String> = k.split(sep).map(|s| s.to_string()).collect();
            if side == "left" {
                left.push(parts);
            } else {
                right.push(parts);
            }
        }
        Ok((left, right))
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{JoinType, QueryDef, TransformationStep, Workspace};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn fuzzy_suggests_typos_and_leaves_the_rest() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dwh-fuzzy-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        let left_path = dir.join("left.csv");
        let right_path = dir.join("right.csv");
        fs::write(
            &left_path,
            "name\nAcme Corporation\nGlobex Inc\nWidget\nOnlyLeftZZZ\n",
        )
        .unwrap();
        fs::write(
            &right_path,
            "name\nAcme Corp\nGlobex Incorporated\nwidget\nOnlyRightQQQ\n",
        )
        .unwrap();
        let db = DbSession::new().unwrap();
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: left_path.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["name".into()],
                            right_on: vec!["name".into()],
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: right_path.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let out = join_key_fuzzy_suggest(&db, &ws, &[], &[], "fact", 1).unwrap();
        let froms: Vec<_> = out
            .suggestions
            .iter()
            .map(|p| p.from_key.as_str())
            .collect();
        assert!(
            froms.contains(&"Acme Corporation"),
            "suggestions: {froms:?} leftovers L {:?} R {:?}",
            out.leftover_left,
            out.leftover_right
        );
        assert!(froms.contains(&"Globex Inc"), "suggestions: {froms:?}");
        assert!(!froms.contains(&"Widget"));
        assert!(out.leftover_left.iter().any(|k| k == "OnlyLeftZZZ"));
        assert!(out.leftover_right.iter().any(|k| k == "OnlyRightQQQ"));
        assert!(out.leftover_left.iter().any(|k| k == "Widget"));
        assert!(out.leftover_right.iter().any(|k| k == "widget"));
        assert!(out.chat_context.left_lineage.contains("LoadCsv"));
        assert!(out.chat_context.right_lineage.contains("LoadCsv"));
        assert!(!out.chat_context.left_columns.is_empty());
        assert!(
            out.chat_context
                .leftover_left_samples
                .iter()
                .any(|s| s.key == "OnlyLeftZZZ" || s.key == "Widget"),
            "expected leftover samples: {:?}",
            out.chat_context.leftover_left_samples
        );
        assert!(
            out.chat_context
                .right_to_universe
                .iter()
                .any(|k| k == "Acme Corp" || k == "widget"),
            "right universe should include matched/all right keys: {:?}",
            out.chat_context.right_to_universe
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn composite_join_is_disabled_with_reason() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dwh-fuzzy-comp-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        let left_path = dir.join("left.csv");
        let right_path = dir.join("right.csv");
        fs::write(&left_path, "a,b\nx,1\n").unwrap();
        fs::write(&right_path, "a,b\nx,1\n").unwrap();
        let db = DbSession::new().unwrap();
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: left_path.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["a".into(), "b".into()],
                            right_on: vec!["a".into(), "b".into()],
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: right_path.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let out = join_key_fuzzy_suggest(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(out.suggestions.is_empty());
        assert!(out
            .disabled_reason
            .as_deref()
            .unwrap_or("")
            .contains("per-column"));
        let scored =
            join_key_fuzzy_suggest_on(&db, &ws, &[], &[], "fact", 1, Some(0), None, None)
                .unwrap();
        assert!(scored.disabled_reason.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
