//! Collect Load* column-name seeds for schema-aware dbt emit (ADR-0018 / OpenSpec).

use crate::postgres_catalog::describe_postgres_object;
use crate::session::DbSession;
use dwh_pipeline::sql_escape::escape_sql_string;
use dwh_pipeline::{ConnectionDef, TransformationStep, Workspace};
use duckdb::params;
use std::collections::HashMap;

/// Describe each Load* query → ordered column names. Missing/failed describe omits the query
/// (emit falls back or errors when schema is required).
pub fn collect_load_seeds(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
) -> Result<HashMap<String, Vec<String>>, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let mut seeds = HashMap::new();

    for q in &resolved.queries {
        let Some(step) = q.steps.first() else {
            continue;
        };
        let cols = match step {
            TransformationStep::LoadPostgres {
                connection_string,
                schema,
                table_name,
                ..
            } => match describe_postgres_object(db, connection_string, schema, table_name) {
                Ok(c) => c.into_iter().map(|col| col.name).collect::<Vec<_>>(),
                Err(e) => {
                    eprintln!(
                        "[dwh] seed skip query '{}': describe postgres {schema}.{table_name}: {e}",
                        q.id
                    );
                    continue;
                }
            },
            TransformationStep::LoadCsv { path } => {
                match describe_file_relation(db, &format!("read_csv_auto('{}')", escape_sql_string(path)))
                {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[dwh] seed skip query '{}': describe csv {path}: {e}", q.id);
                        continue;
                    }
                }
            }
            TransformationStep::LoadParquet { path, .. } => {
                match describe_file_relation(db, &format!("read_parquet('{}')", escape_sql_string(path)))
                {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!(
                            "[dwh] seed skip query '{}': describe parquet {path}: {e}",
                            q.id
                        );
                        continue;
                    }
                }
            }
            _ => continue,
        };
        if !cols.is_empty() {
            seeds.insert(q.id.clone(), cols);
        }
    }

    Ok(seeds)
}

fn describe_file_relation(db: &DbSession, relation_sql: &str) -> Result<Vec<String>, String> {
    let sql = format!("DESCRIBE SELECT * FROM {relation_sql}");
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut names = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            // DuckDB DESCRIBE: column_name, column_type, null, key, default, extra
            let name: String = row.get(0).map_err(|e| e.to_string())?;
            names.push(name);
        }
        if names.is_empty() {
            return Err(format!("no columns from DESCRIBE {relation_sql}"));
        }
        Ok(names)
    })
}
