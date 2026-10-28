use crate::session::DbSession;
use dwh_pipeline::postgres_attach_alias;
use dwh_pipeline::sql_escape::escape_sql_string;
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

/// A selectable relation in a Postgres database (table, view, …).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PostgresObject {
    pub schema: String,
    pub name: String,
    /// `table` | `view` | `materialized_view` | `foreign` | `partitioned_table` | `other`
    pub kind: String,
}

/// Column from `information_schema.columns` for a Postgres relation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PostgresColumn {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub ordinal_position: i64,
}

/// DuckDB 2.0+: `postgres_query(alias, sql)` / qualified tables need a prior
/// `ATTACH '…' AS alias (TYPE postgres)`. First arg is **not** the DSN.
pub fn ensure_pg_attached(conn: &Connection, conn_str: &str) -> Result<String, String> {
    let alias = postgres_attach_alias(conn_str);
    let sql = format!(
        "ATTACH IF NOT EXISTS '{}' AS {alias} (TYPE postgres, READ_ONLY);",
        escape_sql_string(conn_str),
    );
    conn.execute_batch(&sql)
        .map_err(|e| redact_conn_err(conn_str, e))?;
    Ok(alias)
}

/// Writable ATTACH for KeyMap write-back (separate alias so RO attach stays intact).
pub fn ensure_pg_attached_rw(conn: &Connection, conn_str: &str) -> Result<String, String> {
    let alias = format!("{}_w", postgres_attach_alias(conn_str));
    let sql = format!(
        "ATTACH IF NOT EXISTS '{}' AS {alias} (TYPE postgres);",
        escape_sql_string(conn_str),
    );
    conn.execute_batch(&sql)
        .map_err(|e| redact_conn_err(conn_str, e))?;
    Ok(alias)
}

fn with_postgres_query<F, T>(
    db: &DbSession,
    connection_string: &str,
    remote_sql: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&Connection, String) -> Result<T, String>,
{
    let conn_str = connection_string.trim();
    if conn_str.is_empty() {
        return Err("Connection string is empty".into());
    }
    db.ensure_postgres()?;
    db.with_conn(|conn| {
        let alias = ensure_pg_attached(conn, conn_str)?;
        let duck_sql = format!(
            "SELECT * FROM postgres_query('{alias}', '{}')",
            escape_sql_string(remote_sql)
        );
        f(conn, duck_sql)
    })
}

/// List user-visible relations via DuckDB `ATTACH` + `postgres_query` + `pg_catalog`.
pub fn list_postgres_objects(
    db: &DbSession,
    connection_string: &str,
) -> Result<Vec<PostgresObject>, String> {
    // No single quotes in the remote SQL — avoids escaping pitfalls.
    let remote_sql = "\
SELECT n.nspname AS schema_name, c.relname AS name, \
CASE c.relkind \
  WHEN 'r' THEN 'table' \
  WHEN 'p' THEN 'partitioned_table' \
  WHEN 'v' THEN 'view' \
  WHEN 'm' THEN 'materialized_view' \
  WHEN 'f' THEN 'foreign' \
  ELSE 'other' \
END AS kind \
FROM pg_catalog.pg_class c \
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
WHERE c.relkind IN ('r','p','v','m','f') \
  AND n.nspname NOT IN ('pg_catalog','information_schema') \
  AND n.nspname NOT LIKE 'pg_toast%' \
  AND n.nspname NOT LIKE 'pg_temp_%' \
ORDER BY 1, 2";

    let conn_str = connection_string.trim();
    with_postgres_query(db, conn_str, remote_sql, |conn, sql| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| redact_conn_err(conn_str, e))?;
        let mut rows = stmt
            .query(params![])
            .map_err(|e| redact_conn_err(conn_str, e))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| redact_conn_err(conn_str, e))? {
            out.push(PostgresObject {
                schema: row.get::<_, String>(0).map_err(|e| e.to_string())?,
                name: row.get::<_, String>(1).map_err(|e| e.to_string())?,
                kind: row.get::<_, String>(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    })
}

/// Describe columns of a schema-qualified relation via `information_schema`.
pub fn describe_postgres_object(
    db: &DbSession,
    connection_string: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<PostgresColumn>, String> {
    let schema = schema.trim();
    let table = table.trim();
    if schema.is_empty() || table.is_empty() {
        return Err("schema and table_name are required".into());
    }

    let remote_sql = format!(
        "SELECT column_name, data_type, is_nullable, ordinal_position \
         FROM information_schema.columns \
         WHERE table_schema = '{schema}' AND table_name = '{table}' \
         ORDER BY ordinal_position",
        schema = escape_sql_string(schema),
        table = escape_sql_string(table),
    );

    let conn_str = connection_string.trim();
    with_postgres_query(db, conn_str, &remote_sql, |conn, sql| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| redact_conn_err(conn_str, e))?;
        let mut rows = stmt
            .query(params![])
            .map_err(|e| redact_conn_err(conn_str, e))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| redact_conn_err(conn_str, e))? {
            let nullable_raw: String = row.get(2).map_err(|e| e.to_string())?;
            out.push(PostgresColumn {
                name: row.get::<_, String>(0).map_err(|e| e.to_string())?,
                data_type: row.get::<_, String>(1).map_err(|e| e.to_string())?,
                is_nullable: nullable_raw.eq_ignore_ascii_case("YES"),
                ordinal_position: row.get::<_, i64>(3).map_err(|e| e.to_string())?,
            });
        }
        if out.is_empty() {
            return Err(format!(
                "Postgres: no columns for {schema}.{table} (missing relation or no privilege)"
            ));
        }
        Ok(out)
    })
}

/// Cheap connectivity check (same path as catalog browse).
pub fn test_postgres_connection(
    db: &DbSession,
    connection_string: &str,
) -> Result<(), String> {
    let conn_str = connection_string.trim();
    with_postgres_query(db, conn_str, "SELECT 1 AS ok", |conn, sql| {
        conn.execute_batch(&sql)
            .map_err(|e| redact_conn_err(conn_str, e))?;
        Ok(())
    })
}

fn redact_conn_err(conn_str: &str, err: impl ToString) -> String {
    let mut msg = err.to_string();
    if !conn_str.is_empty() {
        msg = msg.replace(conn_str, "***");
    }
    // Also strip common URI userinfo if echoed oddly
    if let Some(at) = conn_str.find('@') {
        if let Some(scheme) = conn_str.find("://") {
            let secret = &conn_str[scheme + 3..at];
            if !secret.is_empty() {
                msg = msg.replace(secret, "***");
            }
        }
    }
    format!("Postgres: {msg}")
}
