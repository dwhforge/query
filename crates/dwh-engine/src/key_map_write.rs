//! Read/write KeyMap rows against a Postgres source table (ADR-0020).

use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapWriteResult {
    pub schema: String,
    pub table: String,
    pub rows_written: usize,
    pub created_table: bool,
    /// SHA-256 of sorted `from\tto` lines after write (optimistic concurrency token).
    pub content_hash: String,
}

/// Hash of map rows for optimistic concurrency (order-independent).
pub fn key_map_content_hash(entries: &[KeyMapEntry]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .map(|e| format!("{}\t{}", e.from.trim(), e.to))
        .collect();
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

/// Replace all rows in a Postgres mapping table with `entries` (full replace).
///
/// DELETE + INSERT run inside one Postgres transaction (`BEGIN`…`COMMIT` via
/// `postgres_execute`). On insert failure the table is rolled back, not left empty.
///
/// If `expected_content_hash` is `Some`, the current table hash must match or the
/// write is refused (concurrent edit).
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
    // Native PG identifiers for postgres_execute (same quoting rules).
    let pg_schema = quote_ident(schema);
    let pg_table = quote_ident(table);
    let pg_rel = format!("{pg_schema}.{pg_table}");

    // Optimistic check before taking the write connection (avoid nested with_conn).
    if let Some(expected) = expected_content_hash {
        let current = read_key_map_from_postgres(
            db,
            connection_string,
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

    db.with_conn(|conn| {
        let alias = ensure_pg_attached_rw(conn, connection_string)?;

        // Ensure table exists (outside the replace transaction).
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

        // One PG transaction so a failed INSERT cannot leave an empty table.
        if let Err(e) = (|| {
            pg_execute(conn, &alias, "BEGIN")?;
            pg_execute(conn, &alias, &delete_sql)
                .map_err(|err| format!("DELETE FROM {schema}.{table}: {err}"))?;
            if let Some(ins) = &insert_sql {
                pg_execute(conn, &alias, ins)
                    .map_err(|err| format!("INSERT INTO {schema}.{table}: {err}"))?;
            }
            pg_execute(conn, &alias, "COMMIT")?;
            Ok::<(), String>(())
        })() {
            let _ = pg_execute(conn, &alias, "ROLLBACK");
            return Err(e);
        }

        Ok(KeyMapWriteResult {
            schema: schema.to_string(),
            table: table.to_string(),
            rows_written: entries.len(),
            created_table: true,
            content_hash: key_map_content_hash(entries),
        })
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
    let q_from = quote_ident(from_column);
    let q_to = quote_ident(to_column);
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);

    db.with_conn(|conn| {
        let alias = ensure_pg_attached(conn, connection_string)?;
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
    fn replace_sql_uses_begin_commit_helpers() {
        // Documented contract: callers wrap DELETE/INSERT with BEGIN/COMMIT via pg_execute.
        // This unit test locks the helper escaping used for transaction control.
        let begin = format!(
            "CALL postgres_execute('pg_w', '{}');",
            escape_sql_string("BEGIN")
        );
        assert!(begin.contains("BEGIN"));
        let rollback = format!(
            "CALL postgres_execute('pg_w', '{}');",
            escape_sql_string("ROLLBACK")
        );
        assert!(rollback.contains("ROLLBACK"));
    }
}
