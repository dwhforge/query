//! Warehouse dialect + Query execution affinity (ADR-0014).

use crate::model::{QueryDef, TransformationStep};
use serde::{Deserialize, Serialize};

/// Where dbt models materialize / `execution=target` preview runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WarehouseDialect {
    #[default]
    Duckdb,
    Postgres,
}

impl WarehouseDialect {
    pub fn as_str(self) -> &'static str {
        match self {
            WarehouseDialect::Duckdb => "duckdb",
            WarehouseDialect::Postgres => "postgres",
        }
    }
}

/// Preview/runtime engine for one Query node (does not spread across the graph).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum QueryExecution {
    #[default]
    Local,
    Target,
}

impl QueryExecution {
    pub fn as_str(self) -> &'static str {
        match self {
            QueryExecution::Local => "local",
            QueryExecution::Target => "target",
        }
    }
}

/// Why a Query cannot use `execution=target` for the given dialect.
pub fn validate_target_execution(
    query: &QueryDef,
    dialect: WarehouseDialect,
) -> Result<(), String> {
    if query.execution != QueryExecution::Target {
        return Ok(());
    }
    match dialect {
        WarehouseDialect::Duckdb => {
            // DuckDB can federate CSV/Parquet/Postgres in preview; target=duckdb is fine.
            Ok(())
        }
        WarehouseDialect::Postgres => {
            for (idx, step) in query.steps.iter().enumerate() {
                match step {
                    TransformationStep::LoadCsv { .. } => {
                        return Err(format!(
                            "Query '{}': step {idx} LoadCsv cannot run on postgres target — use execution=local or land the file first",
                            query.name
                        ));
                    }
                    TransformationStep::LoadParquet { path, .. }
                        if path.starts_with("s3://")
                            || path.starts_with("http://")
                            || path.starts_with("https://") =>
                    {
                        return Err(format!(
                            "Query '{}': step {idx} remote Parquet cannot run on postgres target without landing — use execution=local or land to PG first",
                            query.name
                        ));
                    }
                    _ => {}
                }
            }
            Ok(())
        }
    }
}

/// Workspace uses remote object storage paths (S3/HTTP) that need landing for postgres export.
pub fn workspace_needs_s3_landing(queries: &[QueryDef]) -> bool {
    queries.iter().any(|q| {
        q.steps.iter().any(|s| match s {
            TransformationStep::LoadParquet { path, .. } | TransformationStep::LoadCsv { path } => {
                path.starts_with("s3://")
                    || path.starts_with("http://")
                    || path.starts_with("https://")
            }
            _ => false,
        })
    })
}

/// Quote an identifier for the dialect (double-quotes both; DuckDB also accepts).
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Rename column (`SELECT … FROM prev`). DuckDB: `EXCLUDE`.
/// Postgres: pass `left_dbt_relation` (`ref('…')` / `source('…','…')`) so emit can list columns via jinja.
pub fn sql_rename_column(
    dialect: WarehouseDialect,
    prev: &str,
    from: &str,
    to: &str,
    left_dbt_relation: Option<&str>,
) -> Result<String, String> {
    match dialect {
        WarehouseDialect::Duckdb => Ok(format!(
            "SELECT * EXCLUDE ({}), {} AS {} FROM {}",
            quote_ident(from),
            quote_ident(from),
            quote_ident(to),
            prev
        )),
        WarehouseDialect::Postgres => {
            let rel = left_dbt_relation.ok_or_else(|| {
                format!(
                    "RenameColumn '{from}'→'{to}' on postgres needs a known left relation \
                     (LoadPostgres/FromQuery before schema-changing steps); \
                     or use SelectColumns / target_dialect=duckdb (prev={prev})"
                )
            })?;
            let from_l = from.to_ascii_lowercase().replace('\'', "''");
            let to_sql = quote_ident(to);
            Ok(format!(
                "{{% set _ren_rel = {rel} %}}\n  SELECT\n    {{% for _c in adapter.get_columns_in_relation(_ren_rel) %}}{{% if (_c.name | lower) == '{from_l}' %}}{{{{ adapter.quote(_c.name) }}}} AS {to_sql}{{% else %}}{{{{ adapter.quote(_c.name) }}}}{{% endif %}}{{% if not loop.last %}}, {{% endif %}}{{% endfor %}}\n  FROM {prev}"
            ))
        }
    }
}

/// Append / union by column **name** (ADR-0003). DuckDB: `UNION ALL BY NAME`.
/// For postgres use [`crate::emit`] Append (jinja name-alignment) — positional `UNION ALL` diverges from preview.
pub fn sql_union_all(dialect: WarehouseDialect, left: &str, right: &str) -> Result<String, String> {
    match dialect {
        WarehouseDialect::Duckdb => Ok(format!(
            "SELECT * FROM {left} UNION ALL BY NAME SELECT * FROM {right}"
        )),
        WarehouseDialect::Postgres => Err(
            "sql_union_all: postgres needs name-aligned emit (see emit Append), not positional UNION ALL"
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::QueryDef;

    #[test]
    fn csv_blocked_on_postgres_target() {
        let q = QueryDef {
            id: "q".into(),
            name: "q".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "/tmp/a.csv".into(),
            }],
            execution: QueryExecution::Target,
        };
        assert!(validate_target_execution(&q, WarehouseDialect::Postgres).is_err());
        assert!(validate_target_execution(&q, WarehouseDialect::Duckdb).is_ok());
    }

    #[test]
    fn local_always_ok() {
        let q = QueryDef {
            id: "q".into(),
            name: "q".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "/tmp/a.csv".into(),
            }],
            execution: QueryExecution::Local,
        };
        assert!(validate_target_execution(&q, WarehouseDialect::Postgres).is_ok());
    }
}
