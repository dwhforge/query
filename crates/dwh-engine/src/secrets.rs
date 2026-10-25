//! Apply Project Connections to the DuckDB session (ADR-0012).

use dwh_pipeline::sql_escape::escape_sql_string;
use dwh_pipeline::{ConnectionDef, ConnectionKind, Workspace};
use duckdb::Connection;

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", escape_sql_string(value))
}

/// Materialize DuckDB secrets for every S3 connection referenced by the workspace
/// (and all S3 connections if `apply_all` — used when browsing before a query exists).
pub fn apply_s3_connections(
    conn: &Connection,
    connections: &[ConnectionDef],
    workspace: Option<&Workspace>,
) -> Result<(), String> {
    let ids: Vec<String> = if let Some(ws) = workspace {
        ws.referenced_connection_ids()
    } else {
        connections
            .iter()
            .filter(|c| matches!(c.kind, ConnectionKind::S3))
            .map(|c| c.id.clone())
            .collect()
    };

    for id in &ids {
        let Some(c) = connections.iter().find(|c| &c.id == id) else {
            continue;
        };
        if !matches!(c.kind, ConnectionKind::S3) {
            continue;
        }
        let Some(s3) = c.s3.as_ref() else {
            return Err(format!("S3 connection '{id}' has no s3 params"));
        };
        let secret_name = format!("dwh_conn_{}", sanitize_ident(id));
        let mut parts = vec![
            format!("TYPE s3"),
            format!("PROVIDER {}", s3.provider),
        ];
        if let Some(r) = &s3.region {
            if !r.is_empty() {
                parts.push(format!("REGION {}", sql_string_literal(r)));
            }
        }
        if let Some(e) = &s3.endpoint {
            if !e.is_empty() {
                parts.push(format!("ENDPOINT {}", sql_string_literal(e)));
            }
        }
        if s3.provider == "config" {
            if let Some(k) = &s3.access_key_id {
                parts.push(format!("KEY_ID {}", sql_string_literal(k)));
            }
            if let Some(s) = &s3.secret_access_key {
                parts.push(format!("SECRET {}", sql_string_literal(s)));
            }
            if let Some(t) = &s3.session_token {
                if !t.is_empty() {
                    parts.push(format!("SESSION_TOKEN {}", sql_string_literal(t)));
                }
            }
        }
        if let Some(style) = &s3.url_style {
            if !style.is_empty() {
                parts.push(format!("URL_STYLE {}", sql_string_literal(style)));
            }
        }
        parts.push(format!("USE_SSL {}", s3.use_ssl));
        parts.push(format!("VERIFY_SSL {}", s3.verify_ssl));

        let sql = format!(
            "CREATE OR REPLACE SECRET {secret_name} ({});",
            parts.join(", ")
        );
        conn.execute_batch(&sql)
            .map_err(|e| format!("CREATE SECRET for connection '{id}' failed: {e}"))?;
    }
    Ok(())
}

fn sanitize_ident(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect()
}
