use crate::dialect::WarehouseDialect;
use crate::emit::{emit_transform_step, substitute_query_placeholders};
use crate::graph::{cte_name, topo_queries};
use crate::model::{TransformationStep, Workspace};
use crate::postgres_attach::duckdb_postgres_relation;
use crate::sql_escape::escape_sql_string;
use std::collections::HashMap;

pub struct GraphCompiler<'a> {
    workspace: &'a Workspace,
}

impl<'a> GraphCompiler<'a> {
    pub fn new(workspace: &'a Workspace) -> Self {
        Self { workspace }
    }

    pub fn to_sql(&self, is_preview: bool) -> Result<String, String> {
        if self.workspace.queries.is_empty() {
            return Err("Workspace is empty".into());
        }

        let order = topo_queries(self.workspace)?;
        let mut last_cte: HashMap<String, String> = HashMap::new();
        let mut parts: Vec<String> = Vec::new();

        for qid in &order {
            let query = self
                .workspace
                .query(qid)
                .ok_or_else(|| format!("missing query {qid}"))?;
            if query.steps.is_empty() {
                return Err(format!("query '{}' has no steps", qid));
            }

            for (idx, step) in query.steps.iter().enumerate() {
                let name = cte_name(qid, idx);
                let prev = if idx > 0 {
                    cte_name(qid, idx - 1)
                } else {
                    String::new()
                };
                let body = compile_step(step, &prev, &last_cte)?;
                parts.push(format!("  {name} AS ({body})"));
                if idx == query.steps.len() - 1 {
                    last_cte.insert(qid.clone(), name);
                }
            }
        }

        let focus_last = last_cte
            .get(&self.workspace.focus_query_id)
            .ok_or_else(|| {
                format!(
                    "focus query '{}' produced no CTE",
                    self.workspace.focus_query_id
                )
            })?;

        let mut sql = String::from("WITH \n");
        sql.push_str(&parts.join(",\n"));
        if is_preview {
            sql.push_str(&format!("\nSELECT * FROM {focus_last} LIMIT 50;"));
        } else {
            sql.push_str(&format!("\nSELECT * FROM {focus_last};"));
        }
        Ok(sql)
    }
}

/// Linear pipeline compiler (compat / single query).
pub struct PipelineCompiler<'a> {
    steps: &'a [TransformationStep],
}

impl<'a> PipelineCompiler<'a> {
    pub fn new(steps: &'a [TransformationStep]) -> Self {
        Self { steps }
    }

    pub fn to_sql(&self, is_preview: bool) -> Result<String, String> {
        let ws = Workspace::from_linear_steps(self.steps.to_vec());
        GraphCompiler::new(&ws).to_sql(is_preview)
    }
}

fn compile_step(
    step: &TransformationStep,
    prev_step: &str,
    last_cte: &HashMap<String, String>,
) -> Result<String, String> {
    match step {
        TransformationStep::LoadCsv { path } => Ok(format!(
            "SELECT * FROM read_csv_auto('{}')",
            escape_sql_string(path)
        )),
        TransformationStep::LoadParquet { path, .. } => Ok(format!(
            "SELECT * FROM read_parquet('{}')",
            escape_sql_string(path)
        )),
        TransformationStep::LoadPostgres {
            connection_string,
            schema,
            table_name,
            ..
        } => {
            // DuckDB 2.0+: ATTACH (TYPE postgres) then qualified relation — not postgres_scan.
            Ok(format!(
                "SELECT * FROM {}",
                duckdb_postgres_relation(connection_string, schema, table_name)
            ))
        }
        TransformationStep::FromQuery { query_id } => {
            if !prev_step.is_empty() {
                return Err("FromQuery must be the first step of a query".into());
            }
            let src = last_cte.get(query_id).ok_or_else(|| {
                format!(
                    "FromQuery: query '{query_id}' not compiled yet (check deps / cycles)"
                )
            })?;
            Ok(format!("SELECT * FROM {src}"))
        }
        TransformationStep::SqlModel { raw_sql } => {
            if !prev_step.is_empty() {
                return Err("SqlModel must be the first step of a query".into());
            }
            Ok(substitute_query_placeholders(raw_sql, last_cte))
        }
        other => emit_transform_step(other, prev_step, last_cte, WarehouseDialect::Duckdb),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{JoinType, QueryDef, TransformationStep};

    #[test]
    fn linear_load_filter_preview() {
        let steps = vec![
            TransformationStep::LoadCsv {
                path: "/tmp/data.csv".into(),
            },
            TransformationStep::Filter {
                condition: "amount > 100".into(),
            },
        ];
        let sql = PipelineCompiler::new(&steps).to_sql(true).unwrap();
        assert!(sql.contains("read_csv_auto('/tmp/data.csv')"));
        assert!(sql.contains("WHERE amount > 100"));
        assert!(sql.contains("LIMIT 50"));
    }

    #[test]
    fn from_query_then_filter() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "sales".into(),
                    name: "sales".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "sales.csv".into(),
                    }],
                 execution: Default::default(),
},
                QueryDef {
                    id: "top".into(),
                    name: "top".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sales".into(),
                        },
                        TransformationStep::Filter {
                            condition: "qty > 1".into(),
                        },
                    ],
                 execution: Default::default(),
},
            ],
            focus_query_id: "top".into(),
        };
        let sql = GraphCompiler::new(&ws).to_sql(true).unwrap();
        assert!(sql.contains("q_sales_s0"));
        assert!(sql.contains("FROM q_sales_s0"));
        assert!(sql.contains("WHERE qty > 1"));
        assert!(sql.contains("q_top_s"));
    }

    #[test]
    fn join_two_queries() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "dim.csv".into(),
                    }],
                 execution: Default::default(),
},
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: "fact.csv".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                 execution: Default::default(),
},
            ],
            focus_query_id: "fact".into(),
        };
        let sql = GraphCompiler::new(&ws).to_sql(true).unwrap();
        assert!(sql.contains("INNER JOIN"));
        assert!(sql.contains("USING (\"region\")"));
        assert!(sql.contains("q_dim_s0"));
        assert!(sql.contains("LIMIT 50"));
    }

    #[test]
    fn empty_steps_error() {
        let steps: Vec<TransformationStep> = vec![];
        assert!(PipelineCompiler::new(&steps).to_sql(true).is_err());
    }

    #[test]
    fn escapes_quotes_in_path() {
        let steps = vec![TransformationStep::LoadCsv {
            path: "/tmp/o'Brien.csv".into(),
        }];
        let sql = PipelineCompiler::new(&steps).to_sql(true).unwrap();
        assert!(sql.contains("read_csv_auto('/tmp/o''Brien.csv')"));
    }

    #[test]
    fn load_postgres_shape() {
        let steps = vec![TransformationStep::LoadPostgres {
            connection_id: None,
            connection_string: "postgresql://u:p@localhost/db".into(),
            schema: "sales".into(),
            table_name: "orders".into(),
        }];
        let sql = PipelineCompiler::new(&steps).to_sql(true).unwrap();
        assert!(sql.contains("dwh_pg_"));
        assert!(sql.contains("\"sales\""));
        assert!(sql.contains("\"orders\""));
        assert!(!sql.contains("postgres_scan"));
        assert!(sql.contains("LIMIT 50"));
    }

    #[test]
    fn load_postgres_schema_defaults_public() {
        let step: TransformationStep = serde_json::from_str(
            r#"{"type":"LoadPostgres","payload":{"connection_string":"x","table_name":"t"}}"#,
        )
        .unwrap();
        match step {
            TransformationStep::LoadPostgres { schema, .. } => assert_eq!(schema, "public"),
            _ => panic!("expected LoadPostgres"),
        }
    }

    #[test]
    fn sql_model_root_and_custom_sql_mid() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "m".into(),
                name: "m".into(),
                steps: vec![
                    TransformationStep::SqlModel {
                        raw_sql: "select 1 as n".into(),
                    },
                    TransformationStep::CustomSql {
                        raw_sql: "select * from {{prev_step}} where n > 0".into(),
                    },
                ],
             execution: Default::default(),
}],
            focus_query_id: "m".into(),
        };
        let sql = GraphCompiler::new(&ws).to_sql(false).unwrap();
        assert!(sql.contains("select 1 as n"));
        assert!(sql.contains("where n > 0"));
    }
}
