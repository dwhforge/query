//! Read/write KeyMap rows against a Postgres source table (ADR-0020 / ADR-0022).

use crate::key_map_delta::{validate_mapping_delta, ValidatedMappingDelta};
use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

pub use crate::key_map_delta::{KeyMapDirtyBaseline, KeyMapDirtyDelta};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapWriteResult {
    pub schema: String,
    pub table: String,
    pub rows_written: usize,
    pub created_table: bool,
    /// SHA-256 of sorted typed field lines after write (optimistic concurrency token).
    pub content_hash: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapReadQuery {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    /// Case-insensitive prefix filter on From column (editor search).
    pub from_prefix: Option<String>,
    /// Exact From-tuple matches (equality, not ILIKE). Mutually exclusive with
    /// `from_prefix`. Bounded by the key list — do not combine with a smaller LIMIT.
    pub from_exact: Option<Vec<Vec<String>>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapReadResult {
    pub entries: Vec<KeyMapEntry>,
    pub content_hash: String,
    /// Total matching rows (for paging UI). Absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u64>,
}

/// Canonical, type-preserving serialization of one From→outputs (+ attrs) for hashing.
fn entry_hash_line(e: &KeyMapEntry) -> String {
    let parts = e.from_parts_eff();
    let from = serde_json::to_string(&parts).unwrap_or_else(|_| "[]".into());
    let outs = e.output_values_eff();
    let to = serde_json::to_string(&outs).unwrap_or_else(|_| "[]".into());
    let mut attrs: Vec<_> = e.attrs.iter().collect();
    attrs.sort_by(|a, b| a.0.cmp(b.0));
    let attr_part: String = attrs
        .iter()
        .map(|(k, v)| {
            format!(
                "\t{}={}",
                k,
                serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into())
            )
        })
        .collect();
    format!("s:{from}\ts:{to}{attr_part}")
}

/// Hash of map rows for optimistic concurrency (order-independent, type-tagged).
pub fn key_map_content_hash(entries: &[KeyMapEntry]) -> String {
    let mut lines: Vec<String> = entries.iter().map(entry_hash_line).collect();
    lines.sort();
    let mut hasher = Sha256::new();
    for line in lines {
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

fn pg_execute(conn: &duckdb::Connection, alias: &str, sql: &str) -> Result<(), String> {
    let call = format!(
        "CALL postgres_execute('{alias}', '{}');",
        escape_sql_string(sql)
    );
    conn.execute_batch(&call)
        .map_err(|e| format!("postgres_execute: {e} — SQL: {sql}"))?;
    Ok(())
}

fn advisory_lock_key(schema: &str, table: &str) -> i64 {
    let mut h = DefaultHasher::new();
    schema.hash(&mut h);
    b".".hash(&mut h);
    table.hash(&mut h);
    h.finish() as i64
}

fn validate_entries(entries: &[KeyMapEntry], output_arity: usize) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    let out_n = output_arity.max(1);
    for e in entries {
        let parts: Vec<String> = e
            .from_parts_eff()
            .into_iter()
            .map(|p| p.trim().to_string())
            .collect();
        if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
            return Err("empty from part in KeyMap entries".into());
        }
        let outs = e.output_values_eff();
        if outs.len() != out_n || outs.iter().any(|v| v.is_empty()) {
            return Err(format!(
                "empty or incomplete outputs for from {parts:?} (need {out_n})"
            ));
        }
        let key = parts.join("\0");
        if !seen.insert(key) {
            return Err(format!("duplicate from {parts:?}"));
        }
    }
    Ok(())
}

fn entry_output_by_name(
    row: &KeyMapEntry,
    output_columns: &[String],
    name: &str,
) -> Option<String> {
    if let Some(i) = output_columns
        .iter()
        .position(|c| c.eq_ignore_ascii_case(name))
    {
        return row.output_values_eff().get(i).cloned();
    }
    if name.eq_ignore_ascii_case("to") || output_columns.is_empty() {
        return Some(row.primary_to());
    }
    None
}

/// Compare outputs (or legacy `to`) + every editable attr.
/// Baseline `outputs` is name → value frozen at first local edit.
fn entry_to_matches(
    baseline: &KeyMapDirtyBaseline,
    row: &KeyMapEntry,
    output_columns: &[String],
    editable: &[String],
) -> bool {
    if !baseline.outputs.is_empty() {
        for (name, expected) in &baseline.outputs {
            let got = entry_output_by_name(row, output_columns, name);
            if got.as_deref() != Some(expected.as_str()) {
                return false;
            }
        }
    } else if baseline.to != row.primary_to() {
        return false;
    }
    for col in editable {
        let expected = match baseline.attrs.get(col) {
            None => None,
            Some(v) => v.as_deref(),
        };
        let got = row.attrs.get(col).map(String::as_str);
        if expected != got {
            return false;
        }
    }
    true
}

fn baseline_tuple_key(parts: &[String]) -> String {
    parts.join("\0")
}

/// Batch-read current warehouse rows for a set of From tuples (one IN query per chunk).
fn read_baselines_batch_on_conn(
    conn: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    tuples: &[Vec<String>],
) -> Result<HashMap<String, KeyMapEntry>, String> {
    let mut out = HashMap::with_capacity(tuples.len());
    if tuples.is_empty() {
        return Ok(out);
    }
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_outs: Vec<String> = output_columns.iter().map(|c| quote_ident(c)).collect();
    let rel = format!(
        "{alias}.{}.{}",
        quote_ident(schema),
        quote_ident(table)
    );
    let mut select_cols: Vec<String> = q_froms
        .iter()
        .map(|q| format!("CAST({q} AS VARCHAR)"))
        .collect();
    for q in &q_outs {
        select_cols.push(format!("CAST({q} AS VARCHAR)"));
    }
    for c in editable {
        select_cols.push(format!("CAST({} AS VARCHAR)", quote_ident(c)));
    }
    let n_from = from_columns.len();
    let n_out = output_columns.len();
    // Keep IN-lists bounded for query size / planner (fuzzy Save can be 100K keys).
    const CHUNK: usize = 2_000;
    for chunk in tuples.chunks(CHUNK) {
        let cast_tuple: String = q_froms
            .iter()
            .map(|q| format!("CAST({q} AS VARCHAR)"))
            .collect::<Vec<_>>()
            .join(", ");
        let pred = if n_from == 1 {
            let list = chunk
                .iter()
                .map(|p| {
                    format!(
                        "'{}'",
                        escape_sql_string(p.first().map(|s| s.as_str()).unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{cast_tuple} IN ({list})")
        } else {
            let values: String = chunk
                .iter()
                .map(|parts| {
                    let cells: String = parts
                        .iter()
                        .map(|p| format!("'{}'", escape_sql_string(p)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({cells})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("({cast_tuple}) IN ({values})")
        };
        let sql = format!(
            "SELECT {} FROM {rel} WHERE {pred}",
            select_cols.join(", ")
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("baseline batch read {schema}.{table}: {e}"))?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut parts = Vec::with_capacity(n_from);
            for i in 0..n_from {
                parts.push(row.get::<_, String>(i).map_err(|e| e.to_string())?);
            }
            let mut outs = Vec::with_capacity(n_out);
            for i in 0..n_out {
                outs.push(row.get::<_, String>(n_from + i).map_err(|e| e.to_string())?);
            }
            let mut attrs = BTreeMap::new();
            for (i, c) in editable.iter().enumerate() {
                if let Ok(val) = row.get::<_, String>(n_from + n_out + i) {
                    attrs.insert(c.clone(), val);
                }
            }
            let key = baseline_tuple_key(&parts);
            let mut entry = KeyMapEntry::parts_multi(parts, outs);
            entry.attrs = attrs;
            out.insert(key, entry);
        }
    }
    Ok(out)
}

fn verify_baselines_on_conn(
    conn: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    baselines: &[KeyMapDirtyBaseline],
) -> Result<(), String> {
    let mut tuples: Vec<Vec<String>> = Vec::with_capacity(baselines.len());
    for b in baselines {
        let parts: Vec<String> = b
            .from_parts
            .iter()
            .map(|p| p.trim().to_string())
            .collect();
        if parts.len() != from_columns.len() || parts.iter().any(|p| p.is_empty()) {
            return Err(format!(
                "refused: invalid baseline from_parts {parts:?} (arity {})",
                from_columns.len()
            ));
        }
        tuples.push(parts);
    }
    let found = read_baselines_batch_on_conn(
        conn,
        alias,
        schema,
        table,
        from_columns,
        output_columns,
        editable,
        &tuples,
    )?;
    for (b, parts) in baselines.iter().zip(tuples.iter()) {
        let current = found.get(&baseline_tuple_key(parts));
        match (b.existed, current) {
            (false, Some(_)) => {
                return Err(format!(
                    "refused: KeyMap row {parts:?} was created concurrently"
                ));
            }
            (false, None) => {}
            (true, None) => {
                return Err(format!(
                    "refused: KeyMap row {parts:?} was deleted concurrently"
                ));
            }
            (true, Some(row)) => {
                if !entry_to_matches(b, row, output_columns, editable) {
                    return Err(format!(
                        "refused: KeyMap row {parts:?} changed concurrently \
                         (expected outputs={:?}/to={:?}, got {:?})",
                        b.outputs,
                        b.to,
                        row.output_values_eff()
                    ));
                }
            }
        }
    }
    Ok(())
}

fn read_entries_on_conn(
    conn: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<(Vec<KeyMapEntry>, Option<u64>), String> {
    let from_columns: Vec<String> = from_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    let output_columns: Vec<String> = output_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if from_columns.is_empty() {
        return Err("from_columns required".into());
    }
    if output_columns.is_empty() {
        return Err("output_columns required".into());
    }
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_outs: Vec<String> = output_columns.iter().map(|c| quote_ident(c)).collect();
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);
    let rel = format!("{alias}.{q_schema}.{q_table}");
    let n_from = from_columns.len();
    let n_out = output_columns.len();

    let mut select_cols: Vec<String> = q_froms
        .iter()
        .map(|q| format!("CAST({q} AS VARCHAR)"))
        .collect();
    for q in &q_outs {
        select_cols.push(format!("CAST({q} AS VARCHAR)"));
    }
    for c in editable {
        select_cols.push(format!("CAST({} AS VARCHAR)", quote_ident(c)));
    }
    let where_sql = read_where_sql(&q_froms, query)?;
    // Some(…) means exact mode (empty Some is rejected in read_where_sql).
    let exact_lookup = query.from_exact.is_some();

    let mut total_count = None;
    if query.limit.is_some() || query.offset.is_some() || !where_sql.is_empty() {
        let count_sql = format!("SELECT COUNT(*) FROM {rel}{where_sql}");
        let mut stmt = conn
            .prepare(&count_sql)
            .map_err(|e| format!("count {schema}.{table}: {e}"))?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let n: i64 = row.get(0).map_err(|e| e.to_string())?;
            total_count = Some(n.max(0) as u64);
        }
    }

    let order = q_froms.join(", ");
    let mut sql = format!(
        "SELECT {} FROM {rel}{where_sql} ORDER BY {order}",
        select_cols.join(", ")
    );
    // Exact key batch is already bounded by IN-list — never page-truncate it
    // (missing key must mean absent, not "fell off LIMIT").
    if !exact_lookup {
        if let Some(lim) = query.limit {
            sql.push_str(&format!(" LIMIT {lim}"));
        }
        if let Some(off) = query.offset {
            sql.push_str(&format!(" OFFSET {off}"));
        }
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| {
        format!("read {schema}.{table}: {e} (check table exists and column names)")
    })?;
    let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut parts = Vec::with_capacity(n_from);
        for i in 0..n_from {
            let v: String = row.get(i).map_err(|e| e.to_string())?;
            parts.push(v);
        }
        let mut outs = Vec::with_capacity(n_out);
        for i in 0..n_out {
            outs.push(row.get::<_, String>(n_from + i).map_err(|e| e.to_string())?);
        }
        let mut attrs = BTreeMap::new();
        for (i, c) in editable.iter().enumerate() {
            let v: Option<String> = row.get(n_from + n_out + i).ok();
            if let Some(val) = v {
                attrs.insert(c.clone(), val);
            }
        }
        let mut entry = KeyMapEntry::parts_multi(parts, outs);
        entry.attrs = attrs;
        out.push(entry);
    }
    Ok((out, total_count))
}

/// Build WHERE for KeyMap reads. Prefix = editor search (ILIKE); exact = equality IN.
///
/// `from_exact` semantics:
/// - `None` — not an exact lookup (prefix / full page as usual)
/// - `Some([])` — validation error (must not become unbounded read)
/// - empty / blank parts — validation error (must not be silently dropped)
pub(crate) fn read_where_sql(
    q_froms: &[String],
    query: &KeyMapReadQuery,
) -> Result<String, String> {
    if q_froms.is_empty() {
        return Err("from_columns required".into());
    }
    let prefix = query
        .from_prefix
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    if let Some(raw_keys) = query.from_exact.as_ref() {
        if prefix.is_some() {
            return Err(
                "read_key_map: from_prefix and from_exact are mutually exclusive".into(),
            );
        }
        if raw_keys.is_empty() {
            return Err(
                "read_key_map: from_exact is empty — refusing unbounded read".into(),
            );
        }
        const MAX_EXACT: usize = 512;
        if raw_keys.len() > MAX_EXACT {
            return Err(format!(
                "read_key_map: from_exact exceeds {MAX_EXACT} keys"
            ));
        }
        let arity = q_froms.len();
        let mut keys: Vec<Vec<String>> = Vec::with_capacity(raw_keys.len());
        for parts in raw_keys {
            if parts.is_empty() {
                return Err("read_key_map: from_exact key has no parts".into());
            }
            if parts.len() != arity {
                return Err(format!(
                    "read_key_map: from_exact arity mismatch (expected {arity}, got {})",
                    parts.len()
                ));
            }
            let trimmed: Vec<String> = parts.iter().map(|p| p.trim().to_string()).collect();
            if trimmed.iter().any(|p| p.is_empty()) {
                return Err(
                    "read_key_map: from_exact parts must be non-empty".into(),
                );
            }
            keys.push(trimmed);
        }
        if arity == 1 {
            let list: Vec<String> = keys
                .iter()
                .map(|p| format!("'{}'", escape_sql_string(&p[0])))
                .collect();
            return Ok(format!(
                " WHERE CAST({} AS VARCHAR) IN ({})",
                q_froms[0],
                list.join(", ")
            ));
        }
        let list: Vec<String> = keys
            .iter()
            .map(|parts| {
                let cells: Vec<String> = parts
                    .iter()
                    .map(|p| format!("'{}'", escape_sql_string(p)))
                    .collect();
                format!("({})", cells.join(", "))
            })
            .collect();
        let casts: Vec<String> = q_froms
            .iter()
            .map(|q| format!("CAST({q} AS VARCHAR)"))
            .collect();
        return Ok(format!(
            " WHERE ({}) IN ({})",
            casts.join(", "),
            list.join(", ")
        ));
    }

    if let Some(prefix) = prefix {
        // Prefix filter on the first From column (composite: primary key part).
        return Ok(format!(
            " WHERE CAST({} AS VARCHAR) ILIKE '{}%'",
            q_froms[0],
            escape_sql_string(prefix)
        ));
    }

    Ok(String::new())
}

/// Literal for a VALUES cell. Missing attr → SQL NULL (not `''`) so NULL round-trips
/// and an edit to one field does not blank other nullable columns.
fn sql_value_literal(v: Option<&str>) -> String {
    match v {
        None => "NULL".into(),
        Some(s) => format!("'{}'", escape_sql_string(s)),
    }
}

fn values_row(
    e: &KeyMapEntry,
    from_arity: usize,
    output_arity: usize,
    editable: &[String],
) -> String {
    let from_parts = e.from_parts_eff();
    let outs = e.output_values_eff();
    let mut parts = Vec::with_capacity(from_arity + output_arity + editable.len());
    for i in 0..from_arity {
        let v = from_parts.get(i).map(|s| s.trim()).unwrap_or("");
        parts.push(sql_value_literal(Some(v)));
    }
    for i in 0..output_arity {
        let v = outs.get(i).map(|s| s.as_str()).unwrap_or("");
        parts.push(sql_value_literal(Some(v)));
    }
    for c in editable {
        parts.push(sql_value_literal(e.attrs.get(c).map(|s| s.as_str())));
    }
    format!("({})", parts.join(", "))
}

fn values_alias_cols(from_arity: usize, output_arity: usize, editable: &[String]) -> String {
    let mut cols: Vec<String> = (0..from_arity).map(|i| format!("f{i}")).collect();
    for i in 0..output_arity {
        cols.push(format!("o{i}"));
    }
    for (i, _) in editable.iter().enumerate() {
        cols.push(format!("a{i}"));
    }
    cols.join(", ")
}

fn is_textual_pg_type(data_type: &str) -> bool {
    let dt = data_type.trim().to_ascii_lowercase();
    matches!(
        dt.as_str(),
        "text"
            | "character varying"
            | "character"
            | "citext"
            | "name"
            | "xml"
            | "json"
            | "jsonb"
            | "bytea"
            | "tsvector"
            | "tsquery"
    ) || dt.starts_with("character varying")
        || dt.starts_with("character(")
        || dt.starts_with("char(")
}

/// Normalize information_schema.data_type for use in `CAST(… AS …)`.
fn pg_cast_type(data_type: &str) -> String {
    let dt = data_type.trim().to_ascii_lowercase();
    match dt.as_str() {
        "" | "user-defined" | "array" => "text".into(),
        other => other.to_string(),
    }
}

/// Cast a VALUES text/NULL cell to the Postgres column type.
/// Non-text: empty string → NULL (UI may send `""` for cleared cells).
fn sql_cast_expr(value_ref: &str, data_type: &str) -> String {
    let ty = pg_cast_type(data_type);
    if is_textual_pg_type(&ty) {
        format!("CAST({value_ref} AS {ty})")
    } else {
        format!("CAST(NULLIF({value_ref}, '') AS {ty})")
    }
}

fn col_type_map(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
) -> Result<BTreeMap<String, String>, String> {
    let cols = crate::postgres_catalog::describe_postgres_object(
        db,
        connection_string,
        schema,
        table,
    )?;
    Ok(cols
        .into_iter()
        .map(|c| (c.name, c.data_type))
        .collect())
}

/// Apply a dirty delta (ADR-0022 / ADR-0024 / ADR-0037): batched DELETE removed From tuples + UPDATE/INSERT upserts.
/// Preserves unselected / autogenerated columns on UPDATE.
pub fn write_key_map_delta_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    delta: &KeyMapDirtyDelta,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    let from_columns: Vec<String> = from_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    let output_columns: Vec<String> = output_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table are required".into());
    }
    if from_columns.is_empty() || output_columns.is_empty() {
        return Err("from_columns and output_columns are required".into());
    }
    let from_set: std::collections::HashSet<&str> =
        from_columns.iter().map(|s| s.as_str()).collect();
    if output_columns.iter().any(|c| from_set.contains(c.as_str())) {
        return Err("from_columns and output_columns must be disjoint".into());
    }
    let arity = from_columns.len();
    let validated = validate_mapping_delta(delta, arity)?;
    apply_validated_delta_to_postgres(
        db,
        connection_string,
        schema,
        table,
        &from_columns,
        &output_columns,
        editable,
        &validated,
        expected_content_hash,
    )
}

fn apply_validated_delta_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    delta: &ValidatedMappingDelta,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    db.ensure_postgres()?;
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_outs: Vec<String> = output_columns.iter().map(|c| quote_ident(c)).collect();
    let pg_schema = quote_ident(schema);
    let pg_table = quote_ident(table);
    let pg_rel = format!("{pg_schema}.{pg_table}");
    let lock_key = advisory_lock_key(schema, table);
    let from_set: std::collections::HashSet<&str> =
        from_columns.iter().map(|s| s.as_str()).collect();
    let out_set: std::collections::HashSet<&str> =
        output_columns.iter().map(|s| s.as_str()).collect();
    let editable: Vec<String> = editable
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| {
            !c.is_empty() && !from_set.contains(c.as_str()) && !out_set.contains(c.as_str())
        })
        .collect();
    let arity = from_columns.len();
    let out_n = output_columns.len();

    let type_map = col_type_map(db, connection_string, schema, table)?;
    let from_tys: Vec<&str> = from_columns
        .iter()
        .map(|c| type_map.get(c).map(|s| s.as_str()).unwrap_or("text"))
        .collect();
    let out_tys: Vec<&str> = output_columns
        .iter()
        .map(|c| type_map.get(c).map(|s| s.as_str()).unwrap_or("text"))
        .collect();
    let editable_tys: Vec<&str> = editable
        .iter()
        .map(|c| type_map.get(c).map(|s| s.as_str()).unwrap_or("text"))
        .collect();

    let dels = delta.deletes();
    let baseline_list = delta.baseline_list();

    db.with_conn(|conn| {
        let alias = ensure_pg_attached_rw(conn, connection_string)?;

        conn.execute_batch("BEGIN TRANSACTION")
            .map_err(|e| format!("BEGIN TRANSACTION: {e}"))?;

        let tx_result = (|| -> Result<usize, String> {
            pg_execute(
                conn,
                &alias,
                &format!("SELECT pg_advisory_xact_lock({lock_key})"),
            )?;
            // Prefer row-level baselines (scale-safe). Fall back to full-table hash only
            // when baselines are absent and expected_content_hash is provided.
            if !baseline_list.is_empty() {
                verify_baselines_on_conn(
                    conn,
                    &alias,
                    schema,
                    table,
                    from_columns,
                    output_columns,
                    &editable,
                    &baseline_list,
                )?;
            } else if let Some(expected) = expected_content_hash
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let (current, _) = read_entries_on_conn(
                    conn,
                    &alias,
                    schema,
                    table,
                    from_columns,
                    output_columns,
                    &editable,
                    &KeyMapReadQuery::default(),
                )?;
                let got = key_map_content_hash(&current);
                if got != expected {
                    return Err(format!(
                        "refused: KeyMap changed concurrently (content hash mismatch)"
                    ));
                }
            }

            let mut written = 0usize;

            if !dels.is_empty() {
                if arity == 1 {
                    let list = dels
                        .iter()
                        .map(|p| {
                            format!(
                                "'{}'",
                                escape_sql_string(p.first().map(|s| s.as_str()).unwrap_or(""))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let del = format!("DELETE FROM {pg_rel} WHERE {} IN ({list})", q_froms[0]);
                    pg_execute(conn, &alias, &del)
                        .map_err(|e| format!("DELETE removed froms: {e}"))?;
                } else {
                    let tuple_list = dels
                        .iter()
                        .map(|parts| {
                            let cells: Vec<String> = (0..arity)
                                .map(|i| {
                                    format!(
                                        "'{}'",
                                        escape_sql_string(
                                            parts.get(i).map(|s| s.as_str()).unwrap_or(""),
                                        )
                                    )
                                })
                                .collect();
                            format!("({})", cells.join(", "))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let cols = q_froms.join(", ");
                    let del = format!(
                        "DELETE FROM {pg_rel} WHERE ({cols}) IN ({tuple_list})"
                    );
                    pg_execute(conn, &alias, &del)
                        .map_err(|e| format!("DELETE removed from tuples: {e}"))?;
                }
            }

            if !delta.upserts().is_empty() {
                let vcols = values_alias_cols(arity, out_n, &editable);
                let values = delta
                    .upserts()
                    .iter()
                    .map(|e| values_row(e, arity, out_n, &editable))
                    .collect::<Vec<_>>()
                    .join(", ");
                let values_sql = format!("(VALUES {values}) AS v({vcols})");

                let mut set_parts: Vec<String> = (0..out_n)
                    .map(|i| {
                        format!(
                            "{} = {}",
                            q_outs[i],
                            sql_cast_expr(&format!("v.o{i}"), out_tys[i])
                        )
                    })
                    .collect();
                for (i, c) in editable.iter().enumerate() {
                    set_parts.push(format!(
                        "{} = {}",
                        quote_ident(c),
                        sql_cast_expr(&format!("v.a{i}"), editable_tys[i])
                    ));
                }
                let join_pred: String = (0..arity)
                    .map(|i| {
                        format!(
                            "CAST(m.{} AS VARCHAR) = v.f{i}",
                            q_froms[i]
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let upd = format!(
                    "UPDATE {pg_rel} AS m SET {} FROM {values_sql} WHERE {join_pred}",
                    set_parts.join(", ")
                );
                pg_execute(conn, &alias, &upd).map_err(|e| format!("UPDATE upserts: {e}"))?;

                let mut insert_cols: Vec<String> = q_froms.clone();
                insert_cols.extend(q_outs.iter().cloned());
                for c in &editable {
                    insert_cols.push(quote_ident(c));
                }
                let mut select_cols: Vec<String> = (0..arity)
                    .map(|i| sql_cast_expr(&format!("v.f{i}"), from_tys[i]))
                    .collect();
                for i in 0..out_n {
                    select_cols.push(sql_cast_expr(&format!("v.o{i}"), out_tys[i]));
                }
                for (i, _) in editable.iter().enumerate() {
                    select_cols.push(sql_cast_expr(&format!("v.a{i}"), editable_tys[i]));
                }
                let exists_pred: String = (0..arity)
                    .map(|i| {
                        format!(
                            "CAST(m.{} AS VARCHAR) = v.f{i}",
                            q_froms[i]
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let ins = format!(
                    "INSERT INTO {pg_rel} ({cols}) \
                     SELECT {sel} FROM {values_sql} \
                     WHERE NOT EXISTS (\
                       SELECT 1 FROM {pg_rel} m WHERE {exists_pred}\
                     )",
                    cols = insert_cols.join(", "),
                    sel = select_cols.join(", "),
                );
                pg_execute(conn, &alias, &ins).map_err(|e| format!("INSERT upserts: {e}"))?;
                written = delta.upserts().len();
            }

            Ok(written)
        })();

        match tx_result {
            Ok(rows_written) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("COMMIT: {e}"))?;
                // Cheap token for UI; concurrency is row-baseline based.
                Ok(KeyMapWriteResult {
                    schema: schema.to_string(),
                    table: table.to_string(),
                    rows_written,
                    created_table: false,
                    content_hash: key_map_content_hash(delta.upserts()),
                })
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

/// Full sync via upsert-by-from (no table wipe): delete Froms not in `entries`, upsert the rest.
pub fn write_key_map_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
    entries: &[KeyMapEntry],
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    write_key_map_to_postgres_ex(
        db,
        connection_string,
        schema,
        table,
        &[from_column.to_string()],
        &[to_column.to_string()],
        &[],
        entries,
        expected_content_hash,
    )
}

pub fn write_key_map_to_postgres_ex(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    entries: &[KeyMapEntry],
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    validate_entries(entries, output_columns.len())?;
    let keep: std::collections::HashSet<String> = entries
        .iter()
        .map(|e| e.from_parts_eff().join("\0"))
        .collect();

    let current = read_key_map_from_postgres_ex(
        db,
        connection_string,
        schema,
        table,
        from_columns,
        output_columns,
        editable,
        &KeyMapReadQuery::default(),
    )?;
    let deleted_from_parts: Vec<Vec<String>> = current
        .entries
        .iter()
        .map(|e| e.from_parts_eff())
        .filter(|p| !keep.contains(&p.join("\0")))
        .collect();

    let delta = KeyMapDirtyDelta {
        upserts: entries.to_vec(),
        deleted_froms: vec![],
        deleted_from_parts,
        baselines: vec![],
    };
    write_key_map_delta_to_postgres(
        db,
        connection_string,
        schema,
        table,
        from_columns,
        output_columns,
        editable,
        &delta,
        expected_content_hash,
    )
}

pub fn read_key_map_from_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
) -> Result<Vec<KeyMapEntry>, String> {
    Ok(read_key_map_from_postgres_ex(
        db,
        connection_string,
        schema,
        table,
        &[from_column.to_string()],
        &[to_column.to_string()],
        &[],
        &KeyMapReadQuery::default(),
    )?
    .entries)
}

pub fn read_key_map_from_postgres_ex(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    output_columns: &[String],
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<KeyMapReadResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table are required".into());
    }
    db.ensure_postgres()?;

    db.with_conn(|conn| {
        let alias = ensure_pg_attached(conn, connection_string)?;
        // Page-only read (ADR-0022 scale). content_hash is informational for the page;
        // Save concurrency uses per-From baselines in the dirty delta.
        let (entries, total_count) = read_entries_on_conn(
            conn,
            &alias,
            schema,
            table,
            from_columns,
            output_columns,
            editable,
            query,
        )?;
        let content_hash = key_map_content_hash(&entries);
        Ok(KeyMapReadResult {
            entries,
            content_hash,
            total_count,
        })
    })
}

pub fn write_key_map(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
) -> Result<KeyMapWriteResult, String> {
    write_key_map_with_expected(db, map, connection_string, None)
}

pub fn write_key_map_with_expected(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    write_key_map_with_delta(db, map, connection_string, None, expected_content_hash)
}

pub fn write_key_map_with_delta(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
    delta: Option<&KeyMapDirtyDelta>,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    match &map.storage {
        KeyMapStorage::Source { source, table, .. } => {
            let from_cols = map.from_columns_eff();
            let out_cols = map.output_columns_eff();
            if let Some(d) = delta {
                write_key_map_delta_to_postgres(
                    db,
                    connection_string,
                    source,
                    table,
                    &from_cols,
                    &out_cols,
                    &map.editable_columns,
                    d,
                    expected_content_hash,
                )
            } else {
                write_key_map_to_postgres_ex(
                    db,
                    connection_string,
                    source,
                    table,
                    &from_cols,
                    &out_cols,
                    &map.editable_columns,
                    &map.entries,
                    expected_content_hash,
                )
            }
        }
        KeyMapStorage::Seed => Err(
            "seed-backed KeyMap: write the CSV via export / push_key_map_to_export, not warehouse"
                .into(),
        ),
        KeyMapStorage::Ref { .. } => Err(
            "ref-backed KeyMap: warehouse write-back is not supported (dbt run owns the model). Use seed or source storage."
                .into(),
        ),
        KeyMapStorage::Query { .. } => Err(
            "query-backed KeyMap: write-back is not supported (ADR-0036). Edit the map query, not warehouse rows."
                .into(),
        ),
    }
}

pub fn read_key_map(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
) -> Result<Vec<KeyMapEntry>, String> {
    Ok(read_key_map_with_hash(db, map, connection_string)?.entries)
}

pub fn read_key_map_with_hash(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
) -> Result<KeyMapReadResult, String> {
    read_key_map_paged(db, map, connection_string, &KeyMapReadQuery::default())
}

pub fn read_key_map_paged(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
    query: &KeyMapReadQuery,
) -> Result<KeyMapReadResult, String> {
    match &map.storage {
        KeyMapStorage::Source { source, table, .. } => read_key_map_from_postgres_ex(
            db,
            connection_string,
            source,
            table,
            &map.from_columns_eff(),
            &map.output_columns_eff(),
            &map.editable_columns,
            query,
        ),
        _ => Err("read_key_map: only source storage is supported".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_where_exact_equality_not_ilike() {
        let q = KeyMapReadQuery {
            from_exact: Some(vec![vec!["Acme%".into()], vec!["foo_bar".into()]]),
            ..Default::default()
        };
        let sql = read_where_sql(&["\"from\"".into()], &q).unwrap();
        assert!(
            sql.contains(" IN ("),
            "exact must use IN, got {sql}"
        );
        assert!(
            !sql.to_uppercase().contains("ILIKE"),
            "exact must not use ILIKE, got {sql}"
        );
        assert!(
            sql.contains("'Acme%'") && sql.contains("'foo_bar'"),
            "literals preserved (%, _ not wildcards): {sql}"
        );
    }

    #[test]
    fn read_where_exact_rejects_prefix_combo() {
        let q = KeyMapReadQuery {
            from_prefix: Some("A".into()),
            from_exact: Some(vec![vec!["A".into()]]),
            ..Default::default()
        };
        assert!(read_where_sql(&["\"from\"".into()], &q).is_err());
    }

    #[test]
    fn read_where_exact_composite_row_in() {
        let q = KeyMapReadQuery {
            from_exact: Some(vec![vec!["ERP".into(), "100".into()]]),
            ..Default::default()
        };
        let sql =
            read_where_sql(&["\"sys\"".into(), "\"code\"".into()], &q).unwrap();
        assert!(
            sql.contains("('ERP', '100')"),
            "composite row IN: {sql}"
        );
    }

    #[test]
    fn read_where_exact_empty_vec_refuses_unbounded() {
        let q = KeyMapReadQuery {
            from_exact: Some(vec![]),
            ..Default::default()
        };
        let err = read_where_sql(&["\"from\"".into()], &q).unwrap_err();
        assert!(
            err.contains("empty") && err.contains("unbounded"),
            "got {err}"
        );
    }

    #[test]
    fn read_where_exact_blank_parts_refuses() {
        let q = KeyMapReadQuery {
            from_exact: Some(vec![vec!["".into()]]),
            ..Default::default()
        };
        assert!(read_where_sql(&["\"from\"".into()], &q).is_err());
        let q2 = KeyMapReadQuery {
            from_exact: Some(vec![vec!["ERP".into(), "  ".into()]]),
            ..Default::default()
        };
        assert!(read_where_sql(&["\"sys\"".into(), "\"code\"".into()], &q2).is_err());
    }

    #[test]
    fn validated_delta_prefers_from_parts() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![],
            deleted_froms: vec!["ignored".into()],
            deleted_from_parts: vec![vec!["SKU123".into(), "2024-06-01".into()]],
            baselines: vec![KeyMapDirtyBaseline {
                from_parts: vec!["SKU123".into(), "2024-06-01".into()],
                existed: true,
                to: "x".into(),
                outputs: BTreeMap::new(),
                attrs: BTreeMap::new(),
            }],
        };
        let v = validate_mapping_delta(&delta, 2).unwrap();
        assert_eq!(
            v.deletes(),
            &[vec!["SKU123".to_string(), "2024-06-01".to_string()]]
        );
    }

    #[test]
    fn baseline_to_match_ignores_non_editable_row_attrs() {
        let b = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "X".into(),
            outputs: BTreeMap::new(),
            attrs: BTreeMap::new(),
        };
        let outs = vec!["to".into()];
        let mut row = KeyMapEntry::pair("A", "X");
        row.attrs.insert("note".into(), "extra".into());
        // `note` not in editable → ignored (autogenerated / unselected cols).
        assert!(entry_to_matches(&b, &row, &outs, &[]));
        row.to = "Z".into();
        row.output_values = vec!["Z".into()];
        assert!(!entry_to_matches(&b, &row, &outs, &[]));
    }

    #[test]
    fn baseline_multi_outputs_match_by_name() {
        let mut outputs = BTreeMap::new();
        outputs.insert("product_id".into(), "P1".into());
        outputs.insert("variant".into(), "V1".into());
        let b = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "P1".into(),
            outputs,
            attrs: BTreeMap::new(),
        };
        let cols = vec!["product_id".into(), "variant".into()];
        let row = KeyMapEntry::parts_multi(vec!["A".into()], vec!["P1".into(), "V1".into()]);
        assert!(entry_to_matches(&b, &row, &cols, &[]));
        let bad = KeyMapEntry::parts_multi(vec!["A".into()], vec!["P1".into(), "V2".into()]);
        assert!(!entry_to_matches(&b, &bad, &cols, &[]));
    }

    #[test]
    fn baseline_null_attr_conflicts_when_filled() {
        let mut attrs = BTreeMap::new();
        attrs.insert("note".into(), None); // explicit SQL NULL
        let b = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "X".into(),
            outputs: BTreeMap::new(),
            attrs,
        };
        let outs = vec!["to".into()];
        let editable = vec!["note".into()];
        let mut row = KeyMapEntry::pair("A", "X");
        // Still NULL → ok.
        assert!(entry_to_matches(&b, &row, &outs, &editable));
        // Concurrent fill NULL → value must refuse.
        row.attrs.insert("note".into(), "filled".into());
        assert!(!entry_to_matches(&b, &row, &outs, &editable));
        // Empty string is also not NULL.
        row.attrs.insert("note".into(), "".into());
        assert!(!entry_to_matches(&b, &row, &outs, &editable));
        // Explicit empty-string baseline ≠ NULL row.
        let mut empty_attrs = BTreeMap::new();
        empty_attrs.insert("note".into(), Some("".into()));
        let b_empty = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "X".into(),
            outputs: BTreeMap::new(),
            attrs: empty_attrs,
        };
        row.attrs.remove("note");
        assert!(!entry_to_matches(&b_empty, &row, &outs, &editable));
        row.attrs.insert("note".into(), "".into());
        assert!(entry_to_matches(&b_empty, &row, &outs, &editable));
    }

    #[test]
    fn baseline_attr_value_must_match() {
        let mut attrs = BTreeMap::new();
        attrs.insert("note".into(), Some("old".into()));
        let b = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "X".into(),
            outputs: BTreeMap::new(),
            attrs,
        };
        let outs = vec!["to".into()];
        let editable = vec!["note".into()];
        let mut row = KeyMapEntry::pair("A", "X");
        row.attrs.insert("note".into(), "old".into());
        assert!(entry_to_matches(&b, &row, &outs, &editable));
        row.attrs.insert("note".into(), "new".into());
        assert!(!entry_to_matches(&b, &row, &outs, &editable));
        row.attrs.remove("note");
        assert!(!entry_to_matches(&b, &row, &outs, &editable));
    }

    #[test]
    fn content_hash_order_independent() {
        let a = vec![
            KeyMapEntry::pair("www", "web"),
            KeyMapEntry::pair("shop", "store"),
        ];
        let b = vec![a[1].clone(), a[0].clone()];
        assert_eq!(key_map_content_hash(&a), key_map_content_hash(&b));
    }

    #[test]
    fn content_hash_includes_attrs() {
        let mut e = KeyMapEntry::pair("a", "b");
        e.attrs.insert("note".into(), "x".into());
        let plain = KeyMapEntry::pair("a", "b");
        assert_ne!(key_map_content_hash(&[e]), key_map_content_hash(&[plain]));
    }

    #[test]
    fn content_hash_preserves_leading_zeros() {
        let a = vec![KeyMapEntry::pair("001", "online")];
        let b = vec![KeyMapEntry::pair("1", "online")];
        assert_ne!(key_map_content_hash(&a), key_map_content_hash(&b));
    }

    #[test]
    fn soft_migrate_entry_without_attrs() {
        let e: KeyMapEntry = serde_json::from_str(r#"{"from":"a","to":"b"}"#).unwrap();
        assert!(e.attrs.is_empty());
    }

    #[test]
    fn values_row_only_includes_editable_attrs() {
        let mut e = KeyMapEntry::pair("a", "b");
        e.attrs.insert("note".into(), "x".into());
        e.attrs.insert("ignored".into(), "y".into());
        let row = values_row(&e, 1, 1, &["note".into()]);
        assert!(row.contains("'x'"));
        assert!(!row.contains("'y'"), "unselected attr must not be in upsert VALUES");
    }

    #[test]
    fn values_row_missing_attr_is_sql_null_not_empty_string() {
        let e = KeyMapEntry::pair("a", "b");
        let row = values_row(&e, 1, 1, &["note".into()]);
        assert_eq!(row, "('a', 'b', NULL)");
    }

    #[test]
    fn values_row_multi_output() {
        let e = KeyMapEntry::parts_multi(vec!["a".into()], vec!["p".into(), "v".into()]);
        let row = values_row(&e, 1, 2, &[]);
        assert_eq!(row, "('a', 'p', 'v')");
    }

    #[test]
    fn values_row_empty_string_attr_stays_quoted_empty() {
        let mut e = KeyMapEntry::pair("a", "b");
        e.attrs.insert("note".into(), "".into());
        let row = values_row(&e, 1, 1, &["note".into()]);
        assert_eq!(row, "('a', 'b', '')");
    }

    #[test]
    fn sql_cast_expr_text_keeps_empty_string() {
        assert_eq!(
            sql_cast_expr("v.a0", "character varying"),
            "CAST(v.a0 AS character varying)"
        );
    }

    #[test]
    fn sql_cast_expr_numeric_nullif_empty() {
        assert_eq!(
            sql_cast_expr("v.a0", "integer"),
            "CAST(NULLIF(v.a0, '') AS integer)"
        );
        assert_eq!(
            sql_cast_expr("v.to_val", "boolean"),
            "CAST(NULLIF(v.to_val, '') AS boolean)"
        );
    }

    #[test]
    fn duckdb_level_transaction_rolls_back_failed_insert() {
        let conn = duckdb::Connection::open_in_memory().expect("duckdb");
        conn.execute_batch(
            "CREATE TABLE keymap_t(from_k VARCHAR, to_k VARCHAR);\
             INSERT INTO keymap_t VALUES ('www', 'web');",
        )
        .unwrap();

        conn.execute_batch("BEGIN TRANSACTION").unwrap();
        conn.execute_batch("DELETE FROM keymap_t").unwrap();
        let insert_err = conn.execute_batch(
            "INSERT INTO keymap_t SELECT from_k, to_k FROM __keymap_missing_relation__",
        );
        assert!(insert_err.is_err());
        conn.execute_batch("ROLLBACK").unwrap();

        let mut stmt = conn.prepare("SELECT from_k, to_k FROM keymap_t").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let row = rows.next().unwrap().expect("row must survive rollback");
        let from: String = row.get(0).unwrap();
        assert_eq!(from, "www");
    }
}
