use crate::session::DbSession;
use dwh_pipeline::{ConnectionDef, GraphCompiler, TransformationStep, Workspace};
use duckdb::arrow::array::{
    Array, BooleanArray, Date32Array, Date64Array, Float32Array, Float64Array, Int16Array,
    Int32Array, Int64Array, Int8Array, LargeStringArray, StringArray, TimestampMicrosecondArray,
    TimestampMillisecondArray, TimestampNanosecondArray, TimestampSecondArray, UInt16Array,
    UInt32Array, UInt64Array, UInt8Array,
};
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value as JsonValue};

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
        DataType::Float16 | DataType::Float32 | DataType::Float64 | DataType::Decimal128(_, _) => {
            "FLOAT".into()
        }
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
    JsonValue::String(format!("{array:?}"))
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
