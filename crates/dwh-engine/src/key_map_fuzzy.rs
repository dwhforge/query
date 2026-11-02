//! Query adapter for full KeyMap suggestions. DuckDB reads query results; Rust
//! owns normalization, candidate retrieval, scoring and ambiguity decisions.

use crate::compile::compile_ctes_from;
use crate::key_match::{
    match_keys, normalize_label, CandidateSearch, FuzzyPair, KeyMatchOptions, MatchPolicy,
    MatchRecord,
};
use crate::DbSession;
use dwh_pipeline::{cte_name, quote_ident, ConnectionDef, Workspace};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Instant;

const MAX_SOURCE_ROWS: usize = 250_000;
const MAX_FIELD_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyMapMatchSource {
    pub query_id: String,
    pub key_column: String,
    /// Defaults to key_column. Labels are evidence; returned pairs contain keys.
    #[serde(default)]
    pub label_column: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct KeyMapFuzzySuggest {
    pub left_rows: usize,
    pub right_rows: usize,
    pub unmatched: usize,
    pub ambiguous: usize,
    pub seconds: f64,
    pub options: KeyMatchOptions,
    pub candidate_limited: bool,
    pub suggestions: Vec<FuzzyPair>,
}

/// Read-only: accepting, saving and exporting use existing KeyMap paths.
pub fn key_map_fuzzy_suggest(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    left: &KeyMapMatchSource,
    right: &KeyMapMatchSource,
    options: KeyMatchOptions,
) -> Result<KeyMapFuzzySuggest, String> {
    options.validate()?;
    let started = Instant::now();
    let resolved = db.prepare_workspace(workspace, connections)?;
    let left_sql = input_sql(db, &resolved, connections, left)?;
    let right_sql = input_sql(db, &resolved, connections, right)?;
    // One lock for both reads. Release it before the CPU-bound matching phase.
    let (left, right) = db.with_conn(|conn| {
        Ok((
            read_input(conn, &left_sql, "From")?,
            read_input(conn, &right_sql, "To")?,
        ))
    })?;
    let suggestions = match_keys(
        &left,
        &right,
        options,
        MatchPolicy::Labels,
        CandidateSearch::Indexed,
    );
    Ok(KeyMapFuzzySuggest {
        left_rows: left.len(),
        right_rows: right.len(),
        unmatched: left.len() - suggestions.len(),
        ambiguous: suggestions.iter().filter(|p| p.ambiguous).count(),
        suggestions,
        options,
        candidate_limited: true,
        seconds: started.elapsed().as_secs_f64(),
    })
}

fn input_sql(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    source: &KeyMapMatchSource,
) -> Result<String, String> {
    let label_column = source.label_column.as_deref().unwrap_or(&source.key_column);
    if source.key_column.trim().is_empty() || label_column.trim().is_empty() {
        return Err("Key and label column names must be nonblank".into());
    }
    let query = workspace
        .query(&source.query_id)
        .ok_or_else(|| format!("Mapping query '{}' not found", source.query_id))?;
    let last_step = query
        .steps
        .len()
        .checked_sub(1)
        .ok_or_else(|| format!("Mapping query '{}' has no steps", source.query_id))?;
    let compiled = compile_ctes_from(db, workspace, connections, &[], &source.query_id)?;
    Ok(compiled.wrap_select(&format!(
        "SELECT CAST({} AS VARCHAR), CAST({} AS VARCHAR) FROM {} LIMIT {}",
        quote_ident(&source.key_column),
        quote_ident(label_column),
        cte_name(&source.query_id, last_step),
        MAX_SOURCE_ROWS + 1,
    )))
}

fn read_input(
    conn: &duckdb::Connection,
    sql: &str,
    side: &str,
) -> Result<Vec<MatchRecord>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("{side} mapping input: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("{side} mapping input: {e}"))?;
    let mut records = Vec::new();
    let mut keys = HashSet::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if records.len() == MAX_SOURCE_ROWS {
            return Err(format!(
                "{side} mapping input exceeds {MAX_SOURCE_ROWS} rows; no partial result returned"
            ));
        }
        let key: Option<String> = row.get(0).map_err(|e| e.to_string())?;
        let label: Option<String> = row.get(1).map_err(|e| e.to_string())?;
        let (Some(key), Some(label)) = (key, label) else {
            return Err(format!("{side} mapping input contains a NULL key or label"));
        };
        validate_record(&key, &label, side)?;
        if !keys.insert(key.clone()) {
            return Err(format!(
                "{side} mapping input contains duplicate keys; use a distinct dictionary query"
            ));
        }
        records.push(MatchRecord { key, label });
    }
    Ok(records)
}

fn validate_record(key: &str, label: &str, side: &str) -> Result<(), String> {
    if key.is_empty() || key != key.trim() {
        return Err(format!(
            "{side} mapping keys must be nonblank and trimmed; normalize the source first"
        ));
    }
    if key.chars().count() > MAX_FIELD_CHARS || label.chars().count() > MAX_FIELD_CHARS {
        return Err(format!(
            "{side} mapping keys and labels must be at most {MAX_FIELD_CHARS} characters"
        ));
    }
    if normalize_label(label).is_empty() {
        return Err(format!(
            "{side} mapping labels must contain letters or digits"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_validation_rejects_duplicates_nulls_and_overflow_without_partial_results() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        for sql in [
            "SELECT 'k', 'label' UNION ALL SELECT 'k', 'other'",
            "SELECT NULL::VARCHAR, 'label'",
            "SELECT ' k', 'label'",
            "SELECT 'k', '!!!'",
            "SELECT 'k', repeat('x', 513)",
        ] {
            assert!(read_input(&conn, sql, "From").is_err(), "{sql}");
        }
        let overflow = format!(
            "SELECT i::VARCHAR, 'label' FROM range({}) t(i)",
            MAX_SOURCE_ROWS + 1
        );
        assert!(read_input(&conn, &overflow, "From")
            .unwrap_err()
            .contains("exceeds"));
        assert!(read_input(&conn, "SELECT 'k', 'label' WHERE false", "From")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn columns_are_identifiers_and_no_workspace_mutation_occurs() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "queries": [{"id":"dictionary", "name":"dictionary", "steps":[
                {"type":"SqlModel", "payload":{"raw_sql":"SELECT 'SKU' AS \"odd\"\"key\", 'label' AS name"}}
            ]}], "focus_query_id":"dictionary"
        })).unwrap();
        let before = serde_json::to_value(&workspace).unwrap();
        let db = DbSession::new().unwrap();
        let sql = input_sql(
            &db,
            &workspace,
            &[],
            &KeyMapMatchSource {
                query_id: "dictionary".into(),
                key_column: "odd\"key".into(),
                label_column: Some("name".into()),
            },
        )
        .unwrap();
        let rows = db
            .with_conn(|conn| read_input(conn, &sql, "From"))
            .unwrap();
        assert_eq!(rows[0].key, "SKU");
        assert_eq!(serde_json::to_value(&workspace).unwrap(), before);
    }
}
