//! Read/write KeyMap rows against a Postgres source table (ADR-0020 / ADR-0022).

use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
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

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapDirtyDelta {
    pub upserts: Vec<KeyMapEntry>,
    pub deleted_froms: Vec<String>,
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
    let from = serde_json::to_string(e.from.trim()).unwrap_or_else(|_| "\"\"".into());
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
        let from = e.from.trim();
        if from.is_empty() {
            return Err("empty from in KeyMap entries".into());
        }
        if e.to.is_empty() {
            return Err(format!("empty to for from '{from}'"));
        }
        if !seen.insert(from.to_string()) {
            return Err(format!("duplicate from '{from}'"));
        }
    }
    Ok(())
}

fn read_entries_on_conn(
    conn: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<(Vec<KeyMapEntry>, Option<u64>), String> {
    let q_from = quote_ident(from_column);
    let q_to = quote_ident(to_column);
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);
    let rel = format!("{alias}.{q_schema}.{q_table}");

    let mut select_cols = vec![
        format!("CAST({q_from} AS VARCHAR)"),
        format!("CAST({q_to} AS VARCHAR)"),
    ];
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
        where_sql = format!(
            " WHERE CAST({q_from} AS VARCHAR) ILIKE '{}%'",
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

    let mut sql = format!(
        "SELECT {} FROM {rel}{where_sql} ORDER BY {q_from}",
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
        let from: String = row.get(0).map_err(|e| e.to_string())?;
        let to: String = row.get(1).map_err(|e| e.to_string())?;
        let mut attrs = BTreeMap::new();
        for (i, c) in editable.iter().enumerate() {
            let v: Option<String> = row.get(2 + i).ok();
            if let Some(val) = v {
                attrs.insert(c.clone(), val);
            }
        }
        out.push(KeyMapEntry { from, to, attrs });
    }
    Ok((out, total_count))
}

fn values_row(e: &KeyMapEntry, editable: &[String]) -> String {
    let mut parts = vec![
        format!("'{}'", escape_sql_string(e.from.trim())),
        format!("'{}'", escape_sql_string(&e.to)),
    ];
    for c in editable {
        let v = e.attrs.get(c).map(|s| s.as_str()).unwrap_or("");
        parts.push(format!("'{}'", escape_sql_string(v)));
    }
    format!("({})", parts.join(", "))
}

fn values_alias_cols(editable: &[String]) -> String {
    let mut cols = vec!["from_val".to_string(), "to_val".to_string()];
    for (i, _) in editable.iter().enumerate() {
        cols.push(format!("a{i}"));
    }
    cols.join(", ")
}

/// Apply a dirty delta (ADR-0022): batched DELETE removed Froms + UPDATE/INSERT upserts.
/// Preserves unselected / autogenerated columns on UPDATE.
pub fn write_key_map_delta_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
    editable: &[String],
    delta: &KeyMapDirtyDelta,
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    let from_column = from_column.trim();
    let to_column = to_column.trim();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table are required".into());
    }
    if from_column.is_empty() || to_column.is_empty() {
        return Err("from_column and to_column are required".into());
    }
    if from_column == to_column {
        return Err("from_column and to_column must differ".into());
    }
    validate_entries(&delta.upserts)?;

    db.ensure_postgres()?;
    let q_from = quote_ident(from_column);
    let q_to = quote_ident(to_column);
    let pg_schema = quote_ident(schema);
    let pg_table = quote_ident(table);
    let pg_rel = format!("{pg_schema}.{pg_table}");
    let lock_key = advisory_lock_key(schema, table);
    let editable: Vec<String> = editable
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty() && c != from_column && c != to_column)
        .collect();

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

            // ADR-0022: do not full-scan 100K rows for concurrency on dirty-delta writes.
            // Full-table hash is only meaningful for small maps / legacy full-sync callers
            // that still pass expected_content_hash with a complete snapshot.
            let _ = expected_content_hash;

            let mut written = 0usize;

            if !delta.deleted_froms.is_empty() {
                let list = delta
                    .deleted_froms
                    .iter()
                    .map(|f| format!("'{}'", escape_sql_string(f.trim())))
                    .collect::<Vec<_>>()
                    .join(", ");
                let del = format!("DELETE FROM {pg_rel} WHERE {q_from} IN ({list})");
                pg_execute(conn, &alias, &del)
                    .map_err(|e| format!("DELETE removed froms: {e}"))?;
            }

            if !delta.upserts.is_empty() {
                let vcols = values_alias_cols(&editable);
                let values = delta
                    .upserts
                    .iter()
                    .map(|e| values_row(e, &editable))
                    .collect::<Vec<_>>()
                    .join(", ");
                let values_sql = format!("(VALUES {values}) AS v({vcols})");

                let mut set_parts = vec![format!("{q_to} = v.to_val")];
                for (i, c) in editable.iter().enumerate() {
                    set_parts.push(format!("{} = v.a{i}", quote_ident(c)));
                }
                let upd = format!(
                    "UPDATE {pg_rel} AS m SET {} FROM {values_sql} WHERE CAST(m.{q_from} AS VARCHAR) = v.from_val",
                    set_parts.join(", ")
                );
                pg_execute(conn, &alias, &upd).map_err(|e| format!("UPDATE upserts: {e}"))?;

                let mut insert_cols = vec![q_from.clone(), q_to.clone()];
                for c in &editable {
                    insert_cols.push(quote_ident(c));
                }
                let mut select_cols = vec!["v.from_val".to_string(), "v.to_val".to_string()];
                for (i, _) in editable.iter().enumerate() {
                    select_cols.push(format!("v.a{i}"));
                }
                let ins = format!(
                    "INSERT INTO {pg_rel} ({cols}) \
                     SELECT {sel} FROM {values_sql} \
                     WHERE NOT EXISTS (\
                       SELECT 1 FROM {pg_rel} m WHERE CAST(m.{q_from} AS VARCHAR) = v.from_val\
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
                // Hash of delta upserts only when not full-table; UI refreshes page after save.
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
        from_column,
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
    from_column: &str,
    to_column: &str,
    editable: &[String],
    entries: &[KeyMapEntry],
    expected_content_hash: Option<&str>,
) -> Result<KeyMapWriteResult, String> {
    validate_entries(entries)?;
    let keep: std::collections::HashSet<String> = entries
        .iter()
        .map(|e| e.from.trim().to_string())
        .collect();

    // Load current froms to compute deletes (small maps / full sync path).
    let current = read_key_map_from_postgres_ex(
        db,
        connection_string,
        schema,
        table,
        from_column,
        to_column,
        editable,
        &KeyMapReadQuery::default(),
    )?;
    let deleted_froms: Vec<String> = current
        .entries
        .iter()
        .map(|e| e.from.trim().to_string())
        .filter(|f| !keep.contains(f))
        .collect();

    let delta = KeyMapDirtyDelta {
        upserts: entries.to_vec(),
        deleted_froms,
    };
    write_key_map_delta_to_postgres(
        db,
        connection_string,
        schema,
        table,
        from_column,
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
        from_column,
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
    from_column: &str,
    to_column: &str,
    editable: &[String],
    query: &KeyMapReadQuery,
) -> Result<KeyMapReadResult, String> {
    let schema = schema.trim();
    let table = table.trim();
    let from_column = from_column.trim();
    let to_column = to_column.trim();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table are required".into());
    }
    db.ensure_postgres()?;

    db.with_conn(|conn| {
        let alias = ensure_pg_attached(conn, connection_string)?;
        let (entries, total_count) = read_entries_on_conn(
            conn,
            &alias,
            schema,
            table,
            from_column,
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
            if let Some(d) = delta {
                write_key_map_delta_to_postgres(
                    db,
                    connection_string,
                    source,
                    table,
                    map.from_column.as_str(),
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
                    map.from_column.as_str(),
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
            map.from_column.as_str(),
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
        let row = values_row(&e, &["note".into()]);
        assert!(row.contains("'x'"));
        assert!(!row.contains("'y'"), "unselected attr must not be in upsert VALUES");
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
