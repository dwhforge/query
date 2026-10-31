//! Read/write KeyMap rows against a Postgres source table (ADR-0020 / ADR-0022).

use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapWriteResult {
    pub schema: String,
    pub table: String,
    pub rows_written: usize,
    pub created_table: bool,
    /// SHA-256 of sorted typed field lines after write (optimistic concurrency token).
    pub content_hash: String,
}

/// Warehouse row snapshot at first local edit of a From key (row-level concurrency).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapDirtyBaseline {
    pub from_parts: Vec<String>,
    /// false → row must be absent (insert).
    #[serde(default)]
    pub existed: bool,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub attrs: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapDirtyDelta {
    pub upserts: Vec<KeyMapEntry>,
    /// Arity-1 deletes (soft-migrated into `deleted_from_parts` when empty parts).
    #[serde(default)]
    pub deleted_froms: Vec<String>,
    /// From-tuple deletes ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    #[serde(default)]
    pub deleted_from_parts: Vec<Vec<String>>,
    /// Per-From baselines frozen for the dirty session (preferred over table content_hash).
    #[serde(default)]
    pub baselines: Vec<KeyMapDirtyBaseline>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapReadQuery {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    /// Case-insensitive prefix filter on From column.
    pub from_prefix: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapReadResult {
    pub entries: Vec<KeyMapEntry>,
    pub content_hash: String,
    /// Total matching rows (for paging UI). Absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u64>,
}

/// Canonical, type-preserving serialization of one From→To (+ attrs) for hashing.
fn entry_hash_line(e: &KeyMapEntry) -> String {
    let parts = e.from_parts_eff();
    let from = serde_json::to_string(&parts).unwrap_or_else(|_| "[]".into());
    let to = serde_json::to_string(e.to.as_str()).unwrap_or_else(|_| "\"\"".into());
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

fn validate_entries(entries: &[KeyMapEntry]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for e in entries {
        let parts: Vec<String> = e
            .from_parts_eff()
            .into_iter()
            .map(|p| p.trim().to_string())
            .collect();
        if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
            return Err("empty from part in KeyMap entries".into());
        }
        if e.to.is_empty() {
            return Err(format!("empty to for from {parts:?}"));
        }
        let key = parts.join("\0");
        if !seen.insert(key) {
            return Err(format!("duplicate from {parts:?}"));
        }
    }
    Ok(())
}

fn deleted_tuples(delta: &KeyMapDirtyDelta) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = delta
        .deleted_from_parts
        .iter()
        .map(|p| p.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .filter(|p: &Vec<String>| !p.is_empty())
        .collect();
    if out.is_empty() {
        out = delta
            .deleted_froms
            .iter()
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .map(|f| vec![f])
            .collect();
    }
    out
}

fn entry_to_matches(baseline: &KeyMapDirtyBaseline, row: &KeyMapEntry) -> bool {
    if baseline.to != row.to {
        return false;
    }
    for (k, v) in &baseline.attrs {
        if row.attrs.get(k).map(String::as_str) != Some(v.as_str()) {
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
    to_column: &str,
    editable: &[String],
    tuples: &[Vec<String>],
) -> Result<HashMap<String, KeyMapEntry>, String> {
    let mut out = HashMap::with_capacity(tuples.len());
    if tuples.is_empty() {
        return Ok(out);
    }
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_to = quote_ident(to_column);
    let rel = format!(
        "{alias}.{}.{}",
        quote_ident(schema),
        quote_ident(table)
    );
    let mut select_cols: Vec<String> = q_froms
        .iter()
        .map(|q| format!("CAST({q} AS VARCHAR)"))
        .collect();
    select_cols.push(format!("CAST({q_to} AS VARCHAR)"));
    for c in editable {
        select_cols.push(format!("CAST({} AS VARCHAR)", quote_ident(c)));
    }
    let n_from = from_columns.len();
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
            let to: String = row.get(n_from).map_err(|e| e.to_string())?;
            let mut attrs = BTreeMap::new();
            for (i, c) in editable.iter().enumerate() {
                if let Ok(val) = row.get::<_, String>(n_from + 1 + i) {
                    attrs.insert(c.clone(), val);
                }
            }
            let key = baseline_tuple_key(&parts);
            out.insert(
                key,
                KeyMapEntry {
                    from: parts.first().cloned().unwrap_or_default(),
                    from_parts: parts,
                    to,
                    attrs,
                },
            );
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
    to_column: &str,
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
        to_column,
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
                if !entry_to_matches(b, row) {
                    return Err(format!(
                        "refused: KeyMap row {parts:?} changed concurrently \
                         (expected to={:?}, got to={:?})",
                        b.to, row.to
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
    to_column: &str,
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<(Vec<KeyMapEntry>, Option<u64>), String> {
    let from_columns: Vec<String> = from_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if from_columns.is_empty() {
        return Err("from_columns required".into());
    }
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_to = quote_ident(to_column);
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);
    let rel = format!("{alias}.{q_schema}.{q_table}");
    let n_from = from_columns.len();

    let mut select_cols: Vec<String> = q_froms
        .iter()
        .map(|q| format!("CAST({q} AS VARCHAR)"))
        .collect();
    select_cols.push(format!("CAST({q_to} AS VARCHAR)"));
    for c in editable {
        select_cols.push(format!("CAST({} AS VARCHAR)", quote_ident(c)));
    }
    let mut where_sql = String::new();
    if let Some(prefix) = query
        .from_prefix
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Prefix filter on the first From column (composite: primary key part).
        where_sql = format!(
            " WHERE CAST({} AS VARCHAR) ILIKE '{}%'",
            q_froms[0],
            escape_sql_string(prefix)
        );
    }

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
    if let Some(lim) = query.limit {
        sql.push_str(&format!(" LIMIT {lim}"));
    }
    if let Some(off) = query.offset {
        sql.push_str(&format!(" OFFSET {off}"));
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
        let to: String = row.get(n_from).map_err(|e| e.to_string())?;
        let mut attrs = BTreeMap::new();
        for (i, c) in editable.iter().enumerate() {
            let v: Option<String> = row.get(n_from + 1 + i).ok();
            if let Some(val) = v {
                attrs.insert(c.clone(), val);
            }
        }
        out.push(KeyMapEntry {
            from: parts.first().cloned().unwrap_or_default(),
            from_parts: parts,
            to,
            attrs,
        });
    }
    Ok((out, total_count))
}

/// Literal for a VALUES cell. Missing attr → SQL NULL (not `''`) so NULL round-trips
/// and an edit to one field does not blank other nullable columns.
fn sql_value_literal(v: Option<&str>) -> String {
    match v {
        None => "NULL".into(),
        Some(s) => format!("'{}'", escape_sql_string(s)),
    }
}

fn values_row(e: &KeyMapEntry, from_arity: usize, editable: &[String]) -> String {
    let from_parts = e.from_parts_eff();
    let mut parts = Vec::with_capacity(from_arity + 1 + editable.len());
    for i in 0..from_arity {
        let v = from_parts.get(i).map(|s| s.trim()).unwrap_or("");
        parts.push(sql_value_literal(Some(v)));
    }
    parts.push(sql_value_literal(Some(&e.to)));
    for c in editable {
        parts.push(sql_value_literal(e.attrs.get(c).map(|s| s.as_str())));
    }
    format!("({})", parts.join(", "))
}

fn values_alias_cols(from_arity: usize, editable: &[String]) -> String {
    let mut cols: Vec<String> = (0..from_arity).map(|i| format!("f{i}")).collect();
    cols.push("to_val".to_string());
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

/// Apply a dirty delta (ADR-0022 / ADR-0024): batched DELETE removed From tuples + UPDATE/INSERT upserts.
/// Preserves unselected / autogenerated columns on UPDATE.
pub fn write_key_map_delta_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_columns: &[String],
    to_column: &str,
    editable: &[String],
    delta: &KeyMapDirtyDelta,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    let to_column = to_column.trim();
    let from_columns: Vec<String> = from_columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table are required".into());
    }
    if from_columns.is_empty() || to_column.is_empty() {
        return Err("from_columns and to_column are required".into());
    }
    if from_columns.iter().any(|c| c == to_column) {
        return Err("from_columns and to_column must differ".into());
    }
    validate_entries(&delta.upserts)?;
    for e in &delta.upserts {
        if e.from_parts_eff().len() != from_columns.len() {
            return Err(format!(
                "upsert from_parts len {} != from_columns arity {}",
                e.from_parts_eff().len(),
                from_columns.len()
            ));
        }
    }

    db.ensure_postgres()?;
    let q_froms: Vec<String> = from_columns.iter().map(|c| quote_ident(c)).collect();
    let q_to = quote_ident(to_column);
    let pg_schema = quote_ident(schema);
    let pg_table = quote_ident(table);
    let pg_rel = format!("{pg_schema}.{pg_table}");
    let lock_key = advisory_lock_key(schema, table);
    let from_set: std::collections::HashSet<&str> =
        from_columns.iter().map(|s| s.as_str()).collect();
    let editable: Vec<String> = editable
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty() && !from_set.contains(c.as_str()) && c != to_column)
        .collect();
    let arity = from_columns.len();

    let type_map = col_type_map(db, connection_string, schema, table)?;
    let from_tys: Vec<&str> = from_columns
        .iter()
        .map(|c| type_map.get(c).map(|s| s.as_str()).unwrap_or("text"))
        .collect();
    let to_ty = type_map
        .get(to_column)
        .map(|s| s.as_str())
        .unwrap_or("text");
    let editable_tys: Vec<&str> = editable
        .iter()
        .map(|c| type_map.get(c).map(|s| s.as_str()).unwrap_or("text"))
        .collect();

    let dels = deleted_tuples(delta);

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
            if !delta.baselines.is_empty() {
                verify_baselines_on_conn(
                    conn,
                    &alias,
                    schema,
                    table,
                    &from_columns,
                    to_column,
                    &editable,
                    &delta.baselines,
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
                    &from_columns,
                    to_column,
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

            if !delta.upserts.is_empty() {
                let vcols = values_alias_cols(arity, &editable);
                let values = delta
                    .upserts
                    .iter()
                    .map(|e| values_row(e, arity, &editable))
                    .collect::<Vec<_>>()
                    .join(", ");
                let values_sql = format!("(VALUES {values}) AS v({vcols})");

                let mut set_parts = vec![format!(
                    "{q_to} = {}",
                    sql_cast_expr("v.to_val", to_ty)
                )];
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
                insert_cols.push(q_to.clone());
                for c in &editable {
                    insert_cols.push(quote_ident(c));
                }
                let mut select_cols: Vec<String> = (0..arity)
                    .map(|i| sql_cast_expr(&format!("v.f{i}"), from_tys[i]))
                    .collect();
                select_cols.push(sql_cast_expr("v.to_val", to_ty));
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
                written = delta.upserts.len();
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
                    content_hash: key_map_content_hash(&delta.upserts),
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
        to_column,
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
    to_column: &str,
    editable: &[String],
    entries: &[KeyMapEntry],
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    validate_entries(entries)?;
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
        to_column,
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
        to_column,
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
        to_column,
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
    to_column: &str,
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<KeyMapReadResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    let to_column = to_column.trim();
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
            to_column,
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
            if let Some(d) = delta {
                write_key_map_delta_to_postgres(
                    db,
                    connection_string,
                    source,
                    table,
                    &from_cols,
                    map.to_column.as_str(),
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
                    map.to_column.as_str(),
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
            map.to_column.as_str(),
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
    fn deleted_tuples_prefers_from_parts() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![],
            deleted_froms: vec![],
            deleted_from_parts: vec![vec!["SKU123".into(), "2024-06-01".into()]],
            baselines: vec![],
        };
        let dels = deleted_tuples(&delta);
        assert_eq!(
            dels,
            vec![vec!["SKU123".to_string(), "2024-06-01".to_string()]]
        );
    }

    #[test]
    fn baseline_to_match_ignores_extra_row_attrs() {
        let b = KeyMapDirtyBaseline {
            from_parts: vec!["A".into()],
            existed: true,
            to: "X".into(),
            attrs: BTreeMap::new(),
        };
        let mut row = KeyMapEntry::pair("A", "X");
        row.attrs.insert("note".into(), "extra".into());
        assert!(entry_to_matches(&b, &row));
        row.to = "Z".into();
        assert!(!entry_to_matches(&b, &row));
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
        let row = values_row(&e, 1, &["note".into()]);
        assert!(row.contains("'x'"));
        assert!(!row.contains("'y'"), "unselected attr must not be in upsert VALUES");
    }

    #[test]
    fn values_row_missing_attr_is_sql_null_not_empty_string() {
        let e = KeyMapEntry::pair("a", "b");
        let row = values_row(&e, 1, &["note".into()]);
        assert_eq!(row, "('a', 'b', NULL)");
    }

    #[test]
    fn values_row_empty_string_attr_stays_quoted_empty() {
        let mut e = KeyMapEntry::pair("a", "b");
        e.attrs.insert("note".into(), "".into());
        let row = values_row(&e, 1, &["note".into()]);
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
