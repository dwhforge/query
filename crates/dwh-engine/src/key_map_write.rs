//! Read/write KeyMap rows against a Postgres source table (ADR-0020).

use crate::postgres_catalog::{ensure_pg_attached, ensure_pg_attached_rw};
use crate::session::DbSession;
use dwh_pipeline::{escape_sql_string, quote_ident, KeyMapDef, KeyMapEntry, KeyMapStorage};
use duckdb::params;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeyMapWriteResult {
    pub schema: String,
    pub table: String,
    pub rows_written: usize,
    pub created_table: bool,
}

/// Replace all rows in a Postgres mapping table with `entries` (full replace).
pub fn write_key_map_to_postgres(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
    from_column: &str,
    to_column: &str,
    entries: &[KeyMapEntry],
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
    let q_schema = quote_ident(schema);
    let q_table = quote_ident(table);

    db.with_conn(|conn| {
        let alias = ensure_pg_attached_rw(conn, connection_string)?;
        let rel = format!("{alias}.{q_schema}.{q_table}");

        // Create table if missing (VARCHAR keys — mapping tables are string-keyed).
        let create_sql = format!(
            "CREATE TABLE IF NOT EXISTS {rel} ({q_from} VARCHAR, {q_to} VARCHAR);"
        );
        conn.execute_batch(&create_sql)
            .map_err(|e| format!("CREATE TABLE {schema}.{table}: {e}"))?;

        // Full replace: DELETE + INSERT (map is the whole table content).
        let delete_sql = format!("DELETE FROM {rel};");
        conn.execute_batch(&delete_sql)
            .map_err(|e| format!("DELETE FROM {schema}.{table}: {e}"))?;

        if !entries.is_empty() {
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
            let insert_sql =
                format!("INSERT INTO {rel} ({q_from}, {q_to}) VALUES {values};");
            conn.execute_batch(&insert_sql)
                .map_err(|e| format!("INSERT INTO {schema}.{table}: {e}"))?;
        }

        Ok(KeyMapWriteResult {
            schema: schema.to_string(),
            table: table.to_string(),
            rows_written: entries.len(),
            created_table: true, // IF NOT EXISTS — may or may not have created; OK for UI
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
    match &map.storage {
        KeyMapStorage::Source { source, table, .. } => write_key_map_to_postgres(
            db,
            connection_string,
            source,
            table,
            map.from_column.as_str(),
            map.to_column.as_str(),
            &map.entries,
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
