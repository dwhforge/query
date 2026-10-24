use super::model::TransformationStep;
use super::sql_escape::{escape_sql_string, quote_ident};

pub struct PipelineCompiler<'a> {
    steps: &'a [TransformationStep],
}

impl<'a> PipelineCompiler<'a> {
    pub fn new(steps: &'a [TransformationStep]) -> Self {
        Self { steps }
    }

    pub fn to_sql(&self, is_preview: bool) -> Result<String, String> {
        if self.steps.is_empty() {
            return Err("Цепочка шагов пуста".to_string());
        }

        let mut sql = String::from("WITH \n");

        for (idx, step) in self.steps.iter().enumerate() {
            let step_name = format!("step_{}", idx);
            let prev_step = if idx > 0 {
                format!("step_{}", idx - 1)
            } else {
                String::new()
            };

            let query = match step {
                TransformationStep::LoadCsv { path } => {
                    format!(
                        "SELECT * FROM read_csv_auto('{}')",
                        escape_sql_string(path)
                    )
                }
                TransformationStep::LoadParquet { path } => {
                    format!(
                        "SELECT * FROM read_parquet('{}')",
                        escape_sql_string(path)
                    )
                }
                TransformationStep::LoadPostgres {
                    connection_string,
                    table_name,
                } => {
                    format!(
                        "SELECT * FROM postgres_scan('{}', 'public', '{}')",
                        escape_sql_string(connection_string),
                        escape_sql_string(table_name)
                    )
                }
                TransformationStep::Filter { condition } => {
                    if prev_step.is_empty() {
                        return Err("Filter требует предыдущий шаг".to_string());
                    }
                    format!("SELECT * FROM {} WHERE {}", prev_step, condition)
                }
                TransformationStep::SelectColumns { columns } => {
                    if prev_step.is_empty() {
                        return Err("SelectColumns требует предыдущий шаг".to_string());
                    }
                    let cols = columns
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("SELECT {} FROM {}", cols, prev_step)
                }
                TransformationStep::RenameColumn { from, to } => {
                    if prev_step.is_empty() {
                        return Err("RenameColumn требует предыдущий шаг".to_string());
                    }
                    format!(
                        "SELECT * EXCLUDE ({}) , {} AS {} FROM {}",
                        quote_ident(from),
                        quote_ident(from),
                        quote_ident(to),
                        prev_step
                    )
                }
                TransformationStep::DeriveColumn { name, expression } => {
                    if prev_step.is_empty() {
                        return Err("DeriveColumn требует предыдущий шаг".to_string());
                    }
                    format!(
                        "SELECT *, ({}) AS {} FROM {}",
                        expression,
                        quote_ident(name),
                        prev_step
                    )
                }
                TransformationStep::GroupBy {
                    dimensions,
                    aggregates,
                } => {
                    if prev_step.is_empty() {
                        return Err("GroupBy требует предыдущий шаг".to_string());
                    }
                    let dims = dimensions
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(
                        "SELECT {}, {} FROM {} GROUP BY {}",
                        dims,
                        aggregates.join(", "),
                        prev_step,
                        dims
                    )
                }
                TransformationStep::SortBy {
                    column,
                    descending,
                } => {
                    if prev_step.is_empty() {
                        return Err("SortBy требует предыдущий шаг".to_string());
                    }
                    let order = if *descending { "DESC" } else { "ASC" };
                    format!(
                        "SELECT * FROM {} ORDER BY {} {}",
                        prev_step,
                        quote_ident(column),
                        order
                    )
                }
                TransformationStep::CustomSql { raw_sql } => {
                    raw_sql.replace("{{prev_step}}", &prev_step)
                }
            };

            sql.push_str(&format!("  {} AS ({})", step_name, query));
            if idx < self.steps.len() - 1 {
                sql.push_str(",\n");
            }
        }

        let last_step = format!("step_{}", self.steps.len() - 1);
        if is_preview {
            sql.push_str(&format!("\nSELECT * FROM {} LIMIT 50;", last_step));
        } else {
            sql.push_str(&format!("\nSELECT * FROM {};", last_step));
        }

        Ok(sql)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_load_csv_and_filter_preview() {
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
        assert!(sql.contains("step_0 AS"));
        assert!(sql.contains("step_1 AS"));
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
    fn empty_steps_error() {
        let steps: Vec<TransformationStep> = vec![];
        assert!(PipelineCompiler::new(&steps).to_sql(true).is_err());
    }
}
