use crate::session::DbSession;
use dwh_pipeline::{ConnectionDef, GraphCompiler, TransformationStep, Workspace};
use duckdb::arrow::array::{
    Array, BooleanArray, Date32Array, Date64Array, Decimal128Array, Decimal256Array, Float32Array,
    Float64Array, Int16Array, Int32Array, Int64Array, Int8Array, LargeStringArray, StringArray,
    TimestampMicrosecondArray, TimestampMillisecondArray, TimestampNanosecondArray,
    TimestampSecondArray, UInt16Array, UInt32Array, UInt64Array, UInt8Array,
};
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value as JsonValue};

/// Prefer JSON number when the decimal string fits in f64; else keep string.
fn decimal_string_to_json(s: String) -> JsonValue {
    if let Ok(f) = s.parse::<f64>() {
        if let Some(n) = Number::from_f64(f) {
            return JsonValue::Number(n);
        }
    }
    JsonValue::String(s)
}

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

fn map_arrow_type(dt: &DataType) -> String {
    match dt {
        DataType::Boolean => "BOOLEAN".into(),
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => "INTEGER".into(),
        DataType::Float16
        | DataType::Float32
        | DataType::Float64
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _) => "FLOAT".into(),
        DataType::Timestamp(_, _) | DataType::Date32 | DataType::Date64 => "TIMESTAMP".into(),
        _ => "VARCHAR".into(),
    }
}

fn array_value_to_json(array: &dyn Array, row: usize) -> JsonValue {
    if array.is_null(row) {
        return JsonValue::Null;
    }
    if let Some(a) = array.as_any().downcast_ref::<BooleanArray>() {
        return JsonValue::Bool(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Int8Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Int16Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Int32Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Int64Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<UInt8Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<UInt16Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<UInt32Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<UInt64Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Float32Array>() {
        return Number::from_f64(a.value(row) as f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null);
    }
    if let Some(a) = array.as_any().downcast_ref::<Float64Array>() {
        return Number::from_f64(a.value(row))
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null);
    }
    // DuckDB SUM/aggregates often return DECIMAL — must not fall through to Debug dump.
    if let Some(a) = array.as_any().downcast_ref::<Decimal128Array>() {
        return decimal_string_to_json(a.value_as_string(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Decimal256Array>() {
        return decimal_string_to_json(a.value_as_string(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<StringArray>() {
        return JsonValue::String(a.value(row).to_string());
    }
    if let Some(a) = array.as_any().downcast_ref::<LargeStringArray>() {
        return JsonValue::String(a.value(row).to_string());
    }
    if let Some(a) = array.as_any().downcast_ref::<Date32Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<Date64Array>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampSecondArray>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampMillisecondArray>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampMicrosecondArray>() {
        return JsonValue::from(a.value(row));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampNanosecondArray>() {
        return JsonValue::from(a.value(row));
    }
    // Last resort: one cell as string via Arrow Display, never dump whole array Debug.
    JsonValue::String(format!("{:?}", array.data_type()))
}

fn batches_to_rows(batches: &[RecordBatch]) -> Vec<Vec<JsonValue>> {
    let mut rows = Vec::new();
    for batch in batches {
        let n = batch.num_rows();
        let cols = batch.num_columns();
        for r in 0..n {
            let mut row = Vec::with_capacity(cols);
            for c in 0..cols {
                row.push(array_value_to_json(batch.column(c).as_ref(), r));
            }
            rows.push(row);
        }
    }
    rows
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
        for row in &result.rows {
            let q = &row[qty_i];
            let a = &row[amount_i];
            assert!(
                q.is_number(),
                "qty should be JSON number, got {q:?}"
            );
            assert!(
                a.is_number(),
                "amount should be JSON number, got {a:?}"
            );
            let qs = q.to_string();
            assert!(
                !qs.contains("PrimitiveArray"),
                "qty Debug leak: {qs}"
            );
        }
    }
}
