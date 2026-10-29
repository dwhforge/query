//! Read/write KeyMap rows against a Postgres source table (ADR-0020).

use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapReadResult {
    pub entries: Vec<KeyMapEntry>,
    pub content_hash: String,
}

/// Canonical, type-preserving serialization of one From→To pair for hashing.
/// JSON strings keep field boundaries (tabs/newlines) and leading zeros intact.
fn entry_hash_line(e: &KeyMapEntry) -> String {
    let from = serde_json::to_string(e.from.trim()).unwrap_or_else(|_| "\"\"".into());
    let to = serde_json::to_string(e.to.as_str()).unwrap_or_else(|_| "\"\"".into());
    format!("s:{from}\ts:{to}")
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

fn read_entries_on_conn(
    conn: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
) -> Result<Vec<KeyMapEntry>, String> {
    let q_from = quote_ident(from_column);
    let q_to = quote_ident(to_column);
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);
    let sql = format!(
        "SELECT CAST({q_from} AS VARCHAR), CAST({q_to} AS VARCHAR) FROM {alias}.{q_schema}.{q_table}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| {
        format!("read {schema}.{table}: {e} (check table exists and column names)")
    })?;
    let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let from: String = row.get(0).map_err(|e| e.to_string())?;
        let to: String = row.get(1).map_err(|e| e.to_string())?;
        out.push(KeyMapEntry { from, to });
    }
    Ok(out)
}

/// Replace all rows in a Postgres mapping table with `entries` (full replace).
///
/// Opens a **DuckDB-level** transaction around `postgres_execute` DELETE/INSERT
/// (same pattern as the duckdb-postgres extension tests). On insert failure the
/// table is rolled back, not left empty.
///
/// If `expected_content_hash` is `Some`, the current table hash is checked under
/// an advisory xact lock **inside** the same transaction.
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

    db.ensure_postgres()?;
    let q_from = quote_ident(from_column);
    let q_to = quote_ident(to_column);
    let pg_schema = quote_ident(schema);
    let pg_table = quote_ident(table);
    let pg_rel = format!("{pg_schema}.{pg_table}");
    let lock_key = advisory_lock_key(schema, table);

    db.with_conn(|conn| {
        let alias = ensure_pg_attached_rw(conn, connection_string)?;

        // DDL outside the replace transaction (IF NOT EXISTS is idempotent).
        let create_sql = format!(
            "CREATE TABLE IF NOT EXISTS {pg_rel} ({q_from} VARCHAR, {q_to} VARCHAR)"
        );
        pg_execute(conn, &alias, &create_sql)
            .map_err(|e| format!("CREATE TABLE {schema}.{table}: {e}"))?;

        let delete_sql = format!("DELETE FROM {pg_rel}");
        let insert_sql = if entries.is_empty() {
            None
        } else {
            let values = entries
                .iter()
                .map(|e| {
                    format!(
                        "('{}', '{}')",
                        escape_sql_string(e.from.trim()),
                        escape_sql_string(&e.to)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!(
                "INSERT INTO {pg_rel} ({q_from}, {q_to}) VALUES {values}"
            ))
        };

        // DuckDB-level TX wraps postgres_execute calls (extension test pattern).
        conn.execute_batch("BEGIN TRANSACTION")
            .map_err(|e| format!("BEGIN TRANSACTION: {e}"))?;

        let tx_result = (|| -> Result<(), String> {
            if expected_content_hash.is_some() {
                pg_execute(
                    conn,
                    &alias,
                    &format!("SELECT pg_advisory_xact_lock({lock_key})"),
                )?;
            }
            if let Some(expected) = expected_content_hash {
                let current = read_entries_on_conn(
                    conn,
                    &alias,
                    schema,
                    table,
                    from_column,
                    to_column,
                )?;
                let current_hash = key_map_content_hash(&current);
                if current_hash != expected {
                    return Err(format!(
                        "KeyMap write refused: table {schema}.{table} changed concurrently \
                         (expected hash {expected}, on disk {current_hash}). Reload and retry."
                    ));
                }
            }

            pg_execute(conn, &alias, &delete_sql)
                .map_err(|err| format!("DELETE FROM {schema}.{table}: {err}"))?;
            if let Some(ins) = &insert_sql {
                pg_execute(conn, &alias, ins)
                    .map_err(|err| format!("INSERT INTO {schema}.{table}: {err}"))?;
            }
            Ok(())
        })();

        match tx_result {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("COMMIT: {e}"))?;
                Ok(KeyMapWriteResult {
                    schema: schema.to_string(),
                    table: table.to_string(),
                    rows_written: entries.len(),
                    created_table: true,
                    content_hash: key_map_content_hash(entries),
                })
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

/// Load From→To rows from a Postgres source table into the editor cache.
pub fn read_key_map_from_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
) -> Result<Vec<KeyMapEntry>, String> {
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
        read_entries_on_conn(conn, &alias, schema, table, from_column, to_column)
    })
}

/// Resolve storage + write. Seed maps are not written here (use export push).
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
    match &map.storage {
        KeyMapStorage::Source { source, table, .. } => write_key_map_to_postgres(
            db,
            connection_string,
            source,
            table,
            map.from_column.as_str(),
            map.to_column.as_str(),
            &map.entries,
            expected_content_hash,
        ),
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
    match &map.storage {
        KeyMapStorage::Source { source, table, .. } => read_key_map_from_postgres(
            db,
            connection_string,
            source,
            table,
            map.from_column.as_str(),
            map.to_column.as_str(),
        ),
        _ => Err("read_key_map: only source storage is supported".into()),
    }
}

pub fn read_key_map_with_hash(
    db: &DbSession,
    map: &KeyMapDef,
    connection_string: &str,
) -> Result<KeyMapReadResult, String> {
    let entries = read_key_map(db, map, connection_string)?;
    let content_hash = key_map_content_hash(&entries);
    Ok(KeyMapReadResult {
        entries,
        content_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_order_independent() {
        let a = vec![
            KeyMapEntry {
                from: "www".into(),
                to: "web".into(),
            },
            KeyMapEntry {
                from: "shop".into(),
                to: "store".into(),
            },
        ];
        let b = vec![a[1].clone(), a[0].clone()];
        assert_eq!(key_map_content_hash(&a), key_map_content_hash(&b));
    }

    #[test]
    fn content_hash_preserves_leading_zeros() {
        let a = vec![KeyMapEntry {
            from: "001".into(),
            to: "online".into(),
        }];
        let b = vec![KeyMapEntry {
            from: "1".into(),
            to: "online".into(),
        }];
        assert_ne!(
            key_map_content_hash(&a),
            key_map_content_hash(&b),
            "001 and 1 must hash differently"
        );
        assert!(entry_hash_line(&a[0]).contains("001"));
    }

    #[test]
    fn content_hash_preserves_field_boundaries() {
        let with_tab = KeyMapEntry {
            from: "a\tb".into(),
            to: "x".into(),
        };
        let separate = vec![
            KeyMapEntry {
                from: "a".into(),
                to: "b\tx".into(),
            },
        ];
        assert_ne!(
            key_map_content_hash(&[with_tab]),
            key_map_content_hash(&separate)
        );
    }

    /// Real DuckDB TX: DELETE then failing INSERT → ROLLBACK restores prior rows.
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
        // Force failure after DELETE so ROLLBACK must restore the prior row.
        let insert_err = conn.execute_batch(
            "INSERT INTO keymap_t SELECT from_k, to_k FROM __keymap_missing_relation__",
        );
        assert!(insert_err.is_err(), "insert must fail to exercise rollback");
        conn.execute_batch("ROLLBACK").unwrap();

        let mut stmt = conn.prepare("SELECT from_k, to_k FROM keymap_t").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let row = rows.next().unwrap().expect("row must survive rollback");
        let from: String = row.get(0).unwrap();
        let to: String = row.get(1).unwrap();
        assert_eq!(from, "www");
        assert_eq!(to, "web");
        assert!(rows.next().unwrap().is_none());
    }

    #[test]
    fn duckdb_commit_persists_replace() {
        let conn = duckdb::Connection::open_in_memory().expect("duckdb");
        conn.execute_batch(
            "CREATE TABLE keymap_t(from_k VARCHAR, to_k VARCHAR);\
             INSERT INTO keymap_t VALUES ('old', 'v');",
        )
        .unwrap();
        conn.execute_batch("BEGIN TRANSACTION").unwrap();
        conn.execute_batch("DELETE FROM keymap_t").unwrap();
        conn.execute_batch("INSERT INTO keymap_t VALUES ('001', 'online')")
            .unwrap();
        conn.execute_batch("COMMIT").unwrap();

        let mut stmt = conn.prepare("SELECT from_k FROM keymap_t").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let row = rows.next().unwrap().unwrap();
        let from: String = row.get(0).unwrap();
        assert_eq!(from, "001");
    }
}
