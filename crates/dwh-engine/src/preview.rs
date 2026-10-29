use crate::arrow_json::{batches_to_rows, map_arrow_type};
use crate::session::DbSession;
use dwh_pipeline::{ConnectionDef, GraphCompiler, TransformationStep, Workspace};
use duckdb::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ColumnMetadata {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PreviewResult {
    pub columns: Vec<ColumnMetadata>,
    pub rows: Vec<Vec<JsonValue>>,
    pub sql: String,
}

fn run_sql(db: &DbSession, sql: String) -> Result<PreviewResult, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        let columns = schema
            .fields()
            .iter()
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_arrow_type(f.data_type()),
            })
            .collect();
        Ok(PreviewResult {
            columns,
            rows: batches_to_rows(&batches),
            sql,
        })
    })
}

pub fn preview_workspace(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
) -> Result<PreviewResult, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let sql = GraphCompiler::new(&resolved).to_sql(true)?;
    run_sql(db, sql)
}

pub fn preview_pipeline(
    db: &DbSession,
    steps: &[TransformationStep],
    connections: &[ConnectionDef],
) -> Result<PreviewResult, String> {
    let ws = Workspace::from_linear_steps(steps.to_vec());
    let resolved = db.prepare_workspace(&ws, connections)?;
    let sql = GraphCompiler::new(&resolved).to_sql(true)?;
    run_sql(db, sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{QueryDef, TransformationStep, Workspace};
    use std::path::PathBuf;

    #[test]
    fn groupby_sum_preview_is_numeric_not_debug() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let eu = fixtures.join("sales_eu.csv");
        let us = fixtures.join("sales_us.csv");
        assert!(eu.is_file(), "missing {}", eu.display());

        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "sales_eu".into(),
                    name: "sales_eu".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: eu.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales_us".into(),
                    name: "sales_us".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: us.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales_all".into(),
                    name: "sales_all".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sales_eu".into(),
                        },
                        TransformationStep::Append {
                            other_query_ids: vec!["sales_us".into()],
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "by_region".into(),
                    name: "by_region".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sales_all".into(),
                        },
                        TransformationStep::GroupBy {
                            dimensions: vec!["region".into()],
                            aggregates: vec![
                                "sum(qty) as qty".into(),
                                "sum(amount) as amount".into(),
                                "count(*) as n_rows".into(),
                            ],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "by_region".into(),
            key_maps: vec![],
        };

        let db = DbSession::new().expect("duckdb");
        let result = preview_workspace(&db, &ws, &[]).expect("preview");
        assert!(!result.rows.is_empty());
        let qty_i = result
            .columns
            .iter()
            .position(|c| c.name == "qty")
            .expect("qty col");
        let amount_i = result
            .columns
            .iter()
            .position(|c| c.name == "amount")
            .expect("amount col");
        let looks_numeric = |v: &serde_json::Value| -> bool {
            if v.is_number() {
                return true;
            }
            v.as_str()
                .map(|s| s.parse::<f64>().is_ok())
                .unwrap_or(false)
        };
        for row in &result.rows {
            let q = &row[qty_i];
            let a = &row[amount_i];
            // DECIMAL may be an exact string (preferred) or a JSON number — never Arrow Debug.
            assert!(looks_numeric(q), "qty should be numeric, got {q:?}");
            assert!(looks_numeric(a), "amount should be numeric, got {a:?}");
            let qs = q.to_string();
            assert!(!qs.contains("PrimitiveArray"), "qty Debug leak: {qs}");
        }
    }

    #[test]
    fn two_right_outers_keep_all_channels() {
        use dwh_pipeline::JoinType;
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sparse = fixtures.join("sparse_sales.csv");
        let dim_r = fixtures.join("dim_region.csv");
        let dim_c = fixtures.join("dim_channel.csv");
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim_region".into(),
                    name: "dim_region".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim_r.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "dim_channel".into(),
                    name: "dim_channel".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim_c.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sparse_sales".into(),
                    name: "sparse_sales".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: sparse.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "coverage".into(),
                    name: "coverage".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sparse_sales".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim_region".into(),
                            join_type: JoinType::Right,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                        TransformationStep::Join {
                            right_query_id: "dim_channel".into(),
                            join_type: JoinType::Right,
                            left_on: vec!["channel".into()],
                            right_on: vec!["channel".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "coverage".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().expect("duckdb");
        let out = preview_workspace(&db, &ws, &[]).expect("preview");
        assert!(out.columns.iter().any(|c| c.name == "channel_name"));
        assert!(out.columns.iter().any(|c| c.name == "region_name"));
        assert!(
            out.rows.len() >= 3,
            "expected >=3 channel rows, got {}",
            out.rows.len()
        );
        let ch_i = out
            .columns
            .iter()
            .position(|c| c.name == "channel")
            .expect("channel");
        let channels: Vec<String> = out
            .rows
            .iter()
            .map(|r| r[ch_i].as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            channels.iter().any(|c| c == "partner"),
            "partner must survive second RIGHT OUTER: {channels:?}"
        );
    }

    #[test]
    fn csv_date_column_preview_is_iso_string() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let path = fixtures.join("sales_daily.csv");
        assert!(path.is_file(), "missing {}", path.display());

        let ws = Workspace {
            queries: vec![QueryDef {
                id: "sales".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv {
                    path: path.to_string_lossy().into(),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "sales".into(),
            key_maps: vec![],
        };

        let db = DbSession::new().expect("duckdb");
        let out = preview_workspace(&db, &ws, &[]).expect("preview");
        let day_i = out
            .columns
            .iter()
            .position(|c| c.name == "day")
            .expect("day col");
        assert_eq!(out.columns[day_i].col_type, "DATE");
        let cell = &out.rows[0][day_i];
        let s = cell
            .as_str()
            .unwrap_or_else(|| panic!("day should be ISO string, got {cell:?}"));
        assert!(
            s.starts_with("2024-"),
            "expected ISO date, got {s:?} (raw epoch days look like 19723)"
        );
    }
}
