//! Collect Load* column-name seeds for schema-aware dbt emit (ADR-0018 / OpenSpec).

use crate::postgres_catalog::describe_postgres_object;
use crate::session::DbSession;
use dwh_pipeline::sql_escape::escape_sql_string;
use dwh_pipeline::{
    parquet_hive_partitioning, read_parquet_call_opts, ConnectionDef, SourceDef,
    TransformationStep, Workspace,
};
use duckdb::params;
use std::collections::HashMap;

/// Soft failure describing why a Load* query has no seed columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadSeedDiagnostic {
    pub query_id: String,
    pub message: String,
}

/// Seeds plus per-query diagnostics (unknown schema reasons).
#[derive(Debug, Clone, Default)]
pub struct LoadSeedsResult {
    pub seeds: HashMap<String, Vec<String>>,
    pub diagnostics: Vec<LoadSeedDiagnostic>,
}

/// Describe each Load* query → ordered column names.
/// Soft per-source failures are returned in [`LoadSeedsResult::diagnostics`];
/// hard session/workspace prep errors are `Err`.
pub fn collect_load_seeds(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
) -> Result<LoadSeedsResult, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let mut seeds = HashMap::new();
    let mut diagnostics = Vec::new();

    for q in &resolved.queries {
        let Some(step) = q.steps.first() else {
            continue;
        };
        let cols = match step {
            TransformationStep::LoadPostgres {
                connection_string,
                schema,
                table_name, .. } => match describe_postgres_object(db, connection_string, schema, table_name) {
                Ok(c) => c.into_iter().map(|col| col.name).collect::<Vec<_>>(),
                Err(e) => {
                    diagnostics.push(LoadSeedDiagnostic {
                        query_id: q.id.clone(),
                        message: format!("describe postgres {schema}.{table_name}: {e}"),
                    });
                    continue;
                }
            },
            TransformationStep::LoadCsv { path } => {
                match describe_file_relation(db, &format!("read_csv_auto('{}')", escape_sql_string(path)))
                {
                    Ok(c) => c,
                    Err(e) => {
                        diagnostics.push(LoadSeedDiagnostic {
                            query_id: q.id.clone(),
                            message: format!("describe csv {path}: {e}"),
                        });
                        continue;
                    }
                }
            }
            TransformationStep::LoadParquet {
                path,
                connection_id,
            } => {
                let hive =
                    parquet_hive_partitioning(sources, path, connection_id.as_deref());
                match describe_file_relation(db, &read_parquet_call_opts(path, hive)) {
                    Ok(c) => c,
                    Err(e) => {
                        diagnostics.push(LoadSeedDiagnostic {
                            query_id: q.id.clone(),
                            message: format!("describe parquet {path}: {e}"),
                        });
                        continue;
                    }
                }
            }
            _ => continue,
        };
        if cols.is_empty() {
            diagnostics.push(LoadSeedDiagnostic {
                query_id: q.id.clone(),
                message: "describe returned no columns".into(),
            });
        } else {
            seeds.insert(q.id.clone(), cols);
        }
    }

    Ok(LoadSeedsResult { seeds, diagnostics })
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
