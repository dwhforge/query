//! Arrow cell → JSON for preview / Lens / diagnostics.
//! Temporal values become ISO strings so the UI never shows epoch day counts.

use duckdb::arrow::array::{
    Array, BooleanArray, Date32Array, Date64Array, Decimal128Array, Decimal256Array, Float32Array,
    Float64Array, Int16Array, Int32Array, Int64Array, Int8Array, LargeStringArray, StringArray,
    TimestampMicrosecondArray, TimestampMillisecondArray, TimestampNanosecondArray,
    TimestampSecondArray, UInt16Array, UInt32Array, UInt64Array, UInt8Array,
};
use duckdb::arrow::datatypes::DataType;
use duckdb::arrow::record_batch::RecordBatch;
use serde_json::{Number, Value as JsonValue};

fn decimal_string_to_json(s: String) -> JsonValue {
    if let Ok(f) = s.parse::<f64>() {
        if let Some(n) = Number::from_f64(f) {
            return JsonValue::Number(n);
        }
    }
    JsonValue::String(s)
}

fn date32_to_iso(days: i32) -> String {
    // Arrow Date32 = days since Unix epoch.
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(i64::from(days))))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| days.to_string())
}

fn date64_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.naive_utc().date().format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| ms.to_string())
}

fn timestamp_secs_to_iso(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| secs.to_string())
}

fn timestamp_millis_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| ms.to_string())
}

fn timestamp_micros_to_iso(us: i64) -> String {
    let secs = us.div_euclid(1_000_000);
    let nanos = (us.rem_euclid(1_000_000) * 1000) as u32;
    chrono::DateTime::from_timestamp(secs, nanos)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
        .unwrap_or_else(|| us.to_string())
}

fn timestamp_nanos_to_iso(ns: i64) -> String {
    let secs = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    chrono::DateTime::from_timestamp(secs, nanos)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.9f").to_string())
        .unwrap_or_else(|| ns.to_string())
}

pub fn map_arrow_type(dt: &DataType) -> String {
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
        DataType::Date32 | DataType::Date64 => "DATE".into(),
        DataType::Timestamp(_, _) => "TIMESTAMP".into(),
        DataType::Utf8 | DataType::LargeUtf8 => "VARCHAR".into(),
        _ => "VARCHAR".into(),
    }
}

pub fn array_value_to_json(array: &dyn Array, row: usize) -> JsonValue {
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
        return JsonValue::String(date32_to_iso(a.value(row)));
    }
    if let Some(a) = array.as_any().downcast_ref::<Date64Array>() {
        return JsonValue::String(date64_to_iso(a.value(row)));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampSecondArray>() {
        return JsonValue::String(timestamp_secs_to_iso(a.value(row)));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampMillisecondArray>() {
        return JsonValue::String(timestamp_millis_to_iso(a.value(row)));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampMicrosecondArray>() {
        return JsonValue::String(timestamp_micros_to_iso(a.value(row)));
    }
    if let Some(a) = array.as_any().downcast_ref::<TimestampNanosecondArray>() {
        return JsonValue::String(timestamp_nanos_to_iso(a.value(row)));
    }
    JsonValue::String(format!("{:?}", array.data_type()))
}

pub fn batches_to_rows(batches: &[RecordBatch]) -> Vec<Vec<JsonValue>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date32_epoch_days_format_as_iso() {
        // 2024-01-01 = 19723 days since 1970-01-01
        assert_eq!(date32_to_iso(19723), "2024-01-01");
        assert_eq!(date32_to_iso(0), "1970-01-01");
    }
}
