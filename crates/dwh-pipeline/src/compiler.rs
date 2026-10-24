use crate::graph::{cte_name, direct_deps, topo_queries};
use crate::model::{JoinType, TransformationStep, Workspace};
use crate::sql_escape::{escape_sql_string, quote_ident};
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
        TransformationStep::LoadParquet { path } => Ok(format!(
            "SELECT * FROM read_parquet('{}')",
            escape_sql_string(path)
        )),
        TransformationStep::LoadPostgres {
            connection_string,
            schema,
            table_name,
        } => Ok(format!(
            "SELECT * FROM postgres_scan('{}', '{}', '{}')",
            escape_sql_string(connection_string),
            escape_sql_string(schema),
            escape_sql_string(table_name)
        )),
        TransformationStep::Filter { condition } => {
            require_prev(prev_step, "Filter")?;
            Ok(format!(
                "SELECT * FROM {prev_step} WHERE {condition}"
            ))
        }
        TransformationStep::SelectColumns { columns } => {
            require_prev(prev_step, "SelectColumns")?;
            let cols = columns
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!("SELECT {cols} FROM {prev_step}"))
        }
        TransformationStep::RenameColumn { from, to } => {
            require_prev(prev_step, "RenameColumn")?;
            Ok(format!(
                "SELECT * EXCLUDE ({}) , {} AS {} FROM {}",
                quote_ident(from),
                quote_ident(from),
                quote_ident(to),
                prev_step
            ))
        }
        TransformationStep::DeriveColumn { name, expression } => {
            require_prev(prev_step, "DeriveColumn")?;
            Ok(format!(
                "SELECT *, ({expression}) AS {} FROM {prev_step}",
                quote_ident(name)
            ))
        }
        TransformationStep::GroupBy {
            dimensions,
            aggregates,
        } => {
            require_prev(prev_step, "GroupBy")?;
            let dims = dimensions
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "SELECT {dims}, {} FROM {prev_step} GROUP BY {dims}",
                aggregates.join(", ")
            ))
        }
        TransformationStep::SortBy {
            column,
            descending,
        } => {
            require_prev(prev_step, "SortBy")?;
            let order = if *descending { "DESC" } else { "ASC" };
            Ok(format!(
                "SELECT * FROM {prev_step} ORDER BY {} {order}",
                quote_ident(column)
            ))
        }
        TransformationStep::Join {
            right_query_id,
            join_type,
            left_on,
            right_on,
        } => {
            require_prev(prev_step, "Join")?;
            if left_on.is_empty() || left_on.len() != right_on.len() {
                return Err("Join: left_on/right_on must be non-empty and same length".into());
            }
            let right = last_cte.get(right_query_id).ok_or_else(|| {
                format!(
                    "Join: right query '{}' not compiled yet (check deps)",
                    right_query_id
                )
            })?;
            let join_kw = join_type.sql_keyword();
            if left_on == right_on {
                let using = left_on
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                Ok(format!(
                    "SELECT * FROM {prev_step} AS l {join_kw} {right} AS r USING ({using})"
                ))
            } else {
                let ons: Vec<String> = left_on
                    .iter()
                    .zip(right_on.iter())
                    .map(|(l, r)| {
                        format!(
                            "l.{} = r.{}",
                            quote_ident(l),
                            quote_ident(r)
                        )
                    })
                    .collect();
                Ok(format!(
                    "SELECT * FROM {prev_step} AS l {join_kw} {right} AS r ON {}",
                    ons.join(" AND ")
                ))
            }
        }
        TransformationStep::Append { other_query_ids } => {
            require_prev(prev_step, "Append")?;
            if other_query_ids.is_empty() {
                return Err("Append: other_query_ids empty".into());
            }
            let mut sql = format!("SELECT * FROM {prev_step}");
            for oid in other_query_ids {
                let other = last_cte.get(oid).ok_or_else(|| {
                    format!("Append: query '{oid}' not compiled yet")
                })?;
                sql.push_str(&format!(" UNION ALL BY NAME SELECT * FROM {other}"));
            }
            Ok(sql)
        }
        TransformationStep::CustomSql { raw_sql } => {
            let mut sql = raw_sql.replace("{{prev_step}}", prev_step);
            for dep in direct_deps(std::slice::from_ref(step)) {
                if let Some(cte) = last_cte.get(&dep) {
                    sql = sql.replace(&format!("{{{{query:{dep}}}}}"), cte);
                }
            }
            Ok(sql)
        }
    }
}

fn require_prev(prev: &str, op: &str) -> Result<(), String> {
    if prev.is_empty() {
        Err(format!("{op} требует предыдущий шаг в той же query"))
    } else {
        Ok(())
    }
}

#[allow(dead_code)]
fn _join_type_use(j: &JoinType) {
    let _ = j.sql_keyword();
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
    fn join_two_queries() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "dim.csv".into(),
                    }],
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
            connection_string: "postgresql://u:p@localhost/db".into(),
            schema: "sales".into(),
            table_name: "orders".into(),
        }];
        let sql = PipelineCompiler::new(&steps).to_sql(true).unwrap();
        assert!(sql.contains("postgres_scan("));
        assert!(sql.contains("'sales'"));
        assert!(sql.contains("'orders'"));
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
}
