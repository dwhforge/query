use crate::session::DbSession;
use dwh_pipeline::sql_escape::escape_sql_string;
use duckdb::params;
use serde::{Deserialize, Serialize};

/// A selectable relation in a Postgres database (table, view, …).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PostgresObject {
    pub schema: String,
    pub name: String,
    /// `table` | `view` | `materialized_view` | `foreign` | `partitioned_table` | `other`
    pub kind: String,
}

/// List user-visible relations via DuckDB `postgres_query` + `pg_catalog`.
pub fn list_postgres_objects(
    db: &DbSession,
    connection_string: &str,
) -> Result<Vec<PostgresObject>, String> {
    let conn_str = connection_string.trim();
    if conn_str.is_empty() {
        return Err("Connection string is empty".into());
    }
    db.ensure_postgres()?;

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

    let sql = format!(
        "SELECT schema_name, name, kind FROM postgres_query('{}', '{}')",
        escape_sql_string(conn_str),
        escape_sql_string(remote_sql)
    );

    db.with_conn(|conn| {
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
        if out.is_empty() {
            // Still a successful connect — empty catalog is valid.
            return Ok(out);
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
    if conn_str.is_empty() {
        return Err("Connection string is empty".into());
    }
    db.ensure_postgres()?;
    let sql = format!(
        "SELECT * FROM postgres_query('{}', 'SELECT 1 AS ok')",
        escape_sql_string(conn_str)
    );
    db.with_conn(|conn| {
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
