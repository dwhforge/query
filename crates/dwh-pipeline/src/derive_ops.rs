//! Structured DeriveColumn operations — dual DuckDB / PostgreSQL emit (no Expr AST).

use crate::dialect::WarehouseDialect;
use crate::sql_escape::quote_ident;
use serde::{Deserialize, Serialize};

/// How a derived column is authored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeriveMode {
    /// Ready-made op; regenerates SQL when engine changes.
    Op,
    /// Free SQL for a known (or unknown) dialect.
    #[default]
    Sql,
}

/// Dialect tag on free-SQL derives (unknown = do not auto-assign).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SqlDialectTag {
    Duckdb,
    Postgres,
    #[default]
    Unknown,
}

impl SqlDialectTag {
    pub fn from_engine_dialect(d: WarehouseDialect) -> Self {
        match d {
            WarehouseDialect::Duckdb => SqlDialectTag::Duckdb,
            WarehouseDialect::Postgres => SqlDialectTag::Postgres,
        }
    }

    pub fn matches_engine(self, d: WarehouseDialect) -> bool {
        match self {
            SqlDialectTag::Unknown => false,
            SqlDialectTag::Duckdb => d == WarehouseDialect::Duckdb,
            SqlDialectTag::Postgres => d == WarehouseDialect::Postgres,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeriveOpId {
    /// `date_trunc('month', col)` → DATE
    MonthStart,
    /// Calendar year-month text `YYYY-MM`
    YearMonth,
    /// `coalesce(col, literal)`
    CoalesceNull,
    /// `CAST(col AS type)`
    Cast,
    /// `col_a - col_b`
    ColDiff,
    /// trim / lower / upper
    TrimCase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TrimCaseMode {
    #[default]
    Trim,
    Lower,
    Upper,
    TrimLower,
    TrimUpper,
}

/// Parameters for a ready-made derive op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeriveOp {
    pub id: DeriveOpId,
    /// Primary input column.
    #[serde(default)]
    pub column: String,
    /// Second column (`col_diff`) or unused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_b: Option<String>,
    /// Literal for coalesce, or target type for cast (`varchar`, `integer`, `date`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_mode: Option<TrimCaseMode>,
}

/// Result type hint for schema / UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeriveResultType {
    Date,
    Varchar,
    Numeric,
    SameAsInput,
}

pub fn derive_op_result_type(op: &DeriveOp) -> DeriveResultType {
    match op.id {
        DeriveOpId::MonthStart => DeriveResultType::Date,
        DeriveOpId::YearMonth => DeriveResultType::Varchar,
        DeriveOpId::CoalesceNull => DeriveResultType::SameAsInput,
        DeriveOpId::Cast => DeriveResultType::SameAsInput,
        DeriveOpId::ColDiff => DeriveResultType::Numeric,
        DeriveOpId::TrimCase => DeriveResultType::Varchar,
    }
}

fn require_col(op: &DeriveOp) -> Result<&str, String> {
    let c = op.column.trim();
    if c.is_empty() {
        return Err(format!("derive op {:?}: column is required", op.id));
    }
    Ok(c)
}

/// Generate dialect SQL for a structured op. Errors are explicit (no silent fallback).
pub fn emit_derive_op(op: &DeriveOp, dialect: WarehouseDialect) -> Result<String, String> {
    let col = require_col(op)?;
    let q = quote_ident(col);
    match op.id {
        DeriveOpId::MonthStart => Ok(format!("date_trunc('month', {q}::DATE)")),
        DeriveOpId::YearMonth => match dialect {
            WarehouseDialect::Duckdb => Ok(format!("strftime({q}::DATE, '%Y-%m')")),
            WarehouseDialect::Postgres => Ok(format!("to_char({q}::date, 'YYYY-MM')")),
        },
        DeriveOpId::CoalesceNull => {
            let lit = op
                .value
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "derive op coalesce_null: value (replacement) is required".to_string())?;
            // Quote as string literal unless it looks like a number / NULL keyword.
            let repl = if lit.eq_ignore_ascii_case("null") {
                "NULL".to_string()
            } else if lit.parse::<f64>().is_ok() {
                lit.to_string()
            } else {
                format!("'{}'", lit.replace('\'', "''"))
            };
            Ok(format!("coalesce({q}, {repl})"))
        }
        DeriveOpId::Cast => {
            let ty = op
                .value
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "derive op cast: value (target type) is required".to_string())?;
            let allowed = [
                "varchar", "text", "integer", "bigint", "double", "float", "boolean", "date",
                "timestamp", "numeric", "decimal",
            ];
            if !allowed.iter().any(|a| ty.eq_ignore_ascii_case(a)) {
                return Err(format!(
                    "derive op cast: unsupported type '{ty}' (allowed: {})",
                    allowed.join(", ")
                ));
            }
            Ok(format!("CAST({q} AS {ty})"))
        }
        DeriveOpId::ColDiff => {
            let b = op
                .column_b
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "derive op col_diff: column_b is required".to_string())?;
            Ok(format!("({q} - {})", quote_ident(b)))
        }
        DeriveOpId::TrimCase => {
            let mode = op.case_mode.unwrap_or_default();
            Ok(match mode {
                TrimCaseMode::Trim => format!("trim({q})"),
                TrimCaseMode::Lower => format!("lower({q})"),
                TrimCaseMode::Upper => format!("upper({q})"),
                TrimCaseMode::TrimLower => format!("lower(trim({q}))"),
                TrimCaseMode::TrimUpper => format!("upper(trim({q}))"),
            })
        }
    }
}

/// Resolve expression text for emit: op → generated SQL, else raw expression.
pub fn resolve_derive_expression(
    mode: DeriveMode,
    op: Option<&DeriveOp>,
    expression: &str,
    dialect: WarehouseDialect,
) -> Result<String, String> {
    match mode {
        DeriveMode::Op => {
            let op = op.ok_or_else(|| "DeriveColumn mode=op requires op parameters".to_string())?;
            emit_derive_op(op, dialect)
        }
        DeriveMode::Sql => {
            let e = expression.trim();
            if e.is_empty() {
                return Err("DeriveColumn SQL expression is empty".into());
            }
            Ok(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_start_portable() {
        let op = DeriveOp {
            id: DeriveOpId::MonthStart,
            column: "day".into(),
            column_b: None,
            value: None,
            case_mode: None,
        };
        let d = emit_derive_op(&op, WarehouseDialect::Duckdb).unwrap();
        let p = emit_derive_op(&op, WarehouseDialect::Postgres).unwrap();
        assert_eq!(d, p);
        assert!(d.contains("date_trunc"));
    }

    #[test]
    fn year_month_differs_by_dialect() {
        let op = DeriveOp {
            id: DeriveOpId::YearMonth,
            column: "day".into(),
            column_b: None,
            value: None,
            case_mode: None,
        };
        let d = emit_derive_op(&op, WarehouseDialect::Duckdb).unwrap();
        let p = emit_derive_op(&op, WarehouseDialect::Postgres).unwrap();
        assert!(d.contains("strftime"));
        assert!(p.contains("to_char"));
        assert!(!d.contains("to_char"));
        assert!(!p.contains("strftime"));
    }

    #[test]
    fn cast_rejects_unknown_type() {
        let op = DeriveOp {
            id: DeriveOpId::Cast,
            column: "x".into(),
            column_b: None,
            value: Some("xml".into()),
            case_mode: None,
        };
        let err = emit_derive_op(&op, WarehouseDialect::Duckdb).unwrap_err();
        assert!(err.contains("unsupported"));
    }
}
