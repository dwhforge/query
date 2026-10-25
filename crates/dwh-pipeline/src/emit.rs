//! Shared step → SQL emit (ADR-0015). Transform steps are dialect-aware once;
//! Load / FromQuery / SqlModel adapters stay mode-specific at call sites.

use crate::dialect::{sql_rename_column, WarehouseDialect};
use crate::graph::direct_deps;
use crate::model::{JoinType, TransformationStep};
use crate::sql_escape::quote_ident;
use std::collections::HashMap;

fn require_prev(prev: &str, op: &str) -> Result<(), String> {
    if prev.is_empty() {
        Err(format!("{op} требует предыдущий шаг в той же query"))
    } else {
        Ok(())
    }
}

/// Emit a mid-chain / transform step. `relations` maps query_id → SQL relation
/// (CTE name for preview, `{{ ref('…') }}` for dbt).
///
/// `left_dbt_relation`: bare dbt call for the left side's columns when known
/// (`source('sys','t')` / `ref('stg_x')`) — used so join can drop right cols that
/// already exist on the left (Postgres rejects duplicate names).
pub fn emit_transform_step(
    step: &TransformationStep,
    prev: &str,
    relations: &HashMap<String, String>,
    dialect: WarehouseDialect,
) -> Result<String, String> {
    emit_transform_step_ex(step, prev, relations, dialect, None)
}

/// Like [`emit_transform_step`], with optional left-side dbt relation for join column merge.
pub fn emit_transform_step_ex(
    step: &TransformationStep,
    prev: &str,
    relations: &HashMap<String, String>,
    dialect: WarehouseDialect,
    left_dbt_relation: Option<&str>,
) -> Result<String, String> {
    match step {
        TransformationStep::Filter { condition } => {
            require_prev(prev, "Filter")?;
            Ok(format!("SELECT * FROM {prev} WHERE {condition}"))
        }
        TransformationStep::SelectColumns { columns } => {
            require_prev(prev, "SelectColumns")?;
            let cols = columns
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!("SELECT {cols} FROM {prev}"))
        }
        TransformationStep::RenameColumn { from, to } => {
            require_prev(prev, "RenameColumn")?;
            sql_rename_column(dialect, prev, from, to)
        }
        TransformationStep::DeriveColumn { name, expression } => {
            require_prev(prev, "DeriveColumn")?;
            Ok(format!(
                "SELECT *, ({expression}) AS {} FROM {prev}",
                quote_ident(name)
            ))
        }
        TransformationStep::GroupBy {
            dimensions,
            aggregates,
        } => {
            require_prev(prev, "GroupBy")?;
            let dims = dimensions
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "SELECT {dims}, {} FROM {prev} GROUP BY {dims}",
                aggregates.join(", ")
            ))
        }
        TransformationStep::SortBy {
            column,
            descending,
        } => {
            require_prev(prev, "SortBy")?;
            let order = if *descending { "DESC" } else { "ASC" };
            Ok(format!(
                "SELECT * FROM {prev} ORDER BY {} {order}",
                quote_ident(column)
            ))
        }
        TransformationStep::Limit { n } => {
            require_prev(prev, "Limit")?;
            if *n == 0 {
                return Err("Limit: n must be >= 1".into());
            }
            Ok(format!("SELECT * FROM {prev} LIMIT {n}"))
        }
        TransformationStep::Join {
            right_query_id,
            join_type,
            left_on,
            right_on,
        } => {
            require_prev(prev, "Join")?;
            if left_on.is_empty() || left_on.len() != right_on.len() {
                return Err("Join: left_on/right_on must be non-empty and same length".into());
            }
            let right = relations.get(right_query_id).ok_or_else(|| {
                format!("Join: right query '{right_query_id}' not compiled yet (check deps)")
            })?;
            let join_kw = join_type.sql_keyword();
            if left_on == right_on {
                let using = left_on
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                if let Some(model) = parse_dbt_ref_model(right) {
                    let skip = jinja_lower_name_list(left_on);
                    let select = dbt_join_select_jinja(&model, &skip, left_dbt_relation);
                    Ok(format!(
                        "{select}\n  FROM {prev} AS l {join_kw} {{{{ _jrel }}}} AS r USING ({using})"
                    ))
                } else {
                    Ok(format!(
                        "SELECT * FROM {prev} AS l {join_kw} {right} AS r USING ({using})"
                    ))
                }
            } else {
                emit_join_unequal_keys(
                    dialect,
                    prev,
                    right,
                    join_kw,
                    left_on,
                    right_on,
                    left_dbt_relation,
                )
            }
        }
        TransformationStep::Append { other_query_ids } => {
            require_prev(prev, "Append")?;
            if other_query_ids.is_empty() {
                return Err("Append: other_query_ids empty".into());
            }
            let mut left = format!("SELECT * FROM {prev}");
            for oid in other_query_ids {
                let other = relations
                    .get(oid)
                    .ok_or_else(|| format!("Append: query '{oid}' not compiled yet"))?;
                left = match dialect {
                    WarehouseDialect::Duckdb => {
                        format!("{left} UNION ALL BY NAME SELECT * FROM {other}")
                    }
                    WarehouseDialect::Postgres => {
                        format!("{left} UNION ALL SELECT * FROM {other}")
                    }
                };
            }
            Ok(left)
        }
        TransformationStep::CustomSql { raw_sql } => {
            require_prev(prev, "CustomSql")?;
            let mut sql = raw_sql.replace("{{prev_step}}", prev);
            for dep in direct_deps(std::slice::from_ref(step)) {
                if let Some(rel) = relations.get(&dep) {
                    sql = sql.replace(&format!("{{{{query:{dep}}}}}"), rel);
                }
            }
            Ok(sql)
        }
        TransformationStep::LoadCsv { .. }
        | TransformationStep::LoadParquet { .. }
        | TransformationStep::LoadPostgres { .. }
        | TransformationStep::FromQuery { .. }
        | TransformationStep::SqlModel { .. } => Err(
            "emit_transform_step: Load/FromQuery/SqlModel must use mode-specific adapters".into(),
        ),
    }
}

/// Resolve `{{query:id}}` placeholders using `relations`.
pub fn substitute_query_placeholders(raw_sql: &str, relations: &HashMap<String, String>) -> String {
    let mut sql = raw_sql.trim().trim_end_matches(';').to_string();
    for (id, rel) in relations {
        sql = sql.replace(&format!("{{{{query:{id}}}}}"), rel);
    }
    sql
}

/// Join when left/right key names differ.
///
/// dbt `ref()` → jinja: `l.*` + right-only cols (skip join keys + names already on left).
/// Preview CTEs (DuckDB) → `EXCLUDE` + `USING`. Never emit `EXCLUDE` into dbt models.
fn emit_join_unequal_keys(
    dialect: WarehouseDialect,
    prev: &str,
    right: &str,
    join_kw: &str,
    left_on: &[String],
    right_on: &[String],
    left_dbt_relation: Option<&str>,
) -> Result<String, String> {
    if let Some(model) = parse_dbt_ref_model(right) {
        let skip = jinja_lower_name_list(right_on);
        let select = dbt_join_select_jinja(&model, &skip, left_dbt_relation);
        let ons: Vec<String> = left_on
            .iter()
            .zip(right_on.iter())
            .map(|(l, r)| format!("l.{} = r.{}", quote_ident(l), quote_ident(r)))
            .collect();
        return Ok(format!(
            "{select}\n  FROM {prev} AS l {join_kw} {{{{ _jrel }}}} AS r ON {}",
            ons.join(" AND ")
        ));
    }

    match dialect {
        WarehouseDialect::Duckdb => {
            let using = left_on
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let renames = left_on
                .iter()
                .zip(right_on.iter())
                .map(|(l, r)| format!("{} AS {}", quote_ident(r), quote_ident(l)))
                .collect::<Vec<_>>()
                .join(", ");
            let exclude = right_on
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "SELECT * FROM {prev} AS l {join_kw} (\n    SELECT * EXCLUDE ({exclude}), {renames} FROM {right}\n  ) AS r USING ({using})"
            ))
        }
        WarehouseDialect::Postgres => Err(format!(
            "Join (postgres): unequal keys need a dbt ref() right side (got '{right}')"
        )),
    }
}

/// dbt join projection: left wins on name clashes; right-only columns keep their names.
/// If left relation is unknown, right cols are prefixed `{model}__` (safe, stable).
fn dbt_join_select_jinja(
    model: &str,
    skip_lower_list: &str,
    left_dbt_relation: Option<&str>,
) -> String {
    match left_dbt_relation {
        Some(left) => format!(
            "{{% set _jrel = ref('{model}') %}}\n  {{% set _lrel = {left} %}}\n  {{% set _left_names = adapter.get_columns_in_relation(_lrel) | map(attribute='name') | map('lower') | list %}}\n  SELECT\n    l.*{{% for _c in adapter.get_columns_in_relation(_jrel) if (_c.name | lower) not in [{skip_lower_list}] and (_c.name | lower) not in _left_names %}}, r.{{{{ adapter.quote(_c.name) }}}}{{% endfor %}}"
        ),
        None => format!(
            "{{% set _jrel = ref('{model}') %}}\n  SELECT\n    l.*{{% for _c in adapter.get_columns_in_relation(_jrel) if (_c.name | lower) not in [{skip_lower_list}] %}}, r.{{{{ adapter.quote(_c.name) }}}} AS {{{{ adapter.quote('{model}__' ~ _c.name) }}}}{{% endfor %}}"
        ),
    }
}

fn jinja_lower_name_list(names: &[String]) -> String {
    names
        .iter()
        .map(|c| format!("'{}'", c.to_ascii_lowercase().replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `{{ ref('model') }}` → `model` (dbt export relations only).
fn parse_dbt_ref_model(right: &str) -> Option<String> {
    let t = right.trim();
    let prefix = "{{ ref('";
    let suffix = "') }}";
    if let Some(rest) = t.strip_prefix(prefix) {
        if let Some(name) = rest.strip_suffix(suffix) {
            if !name.is_empty() && !name.contains('\'') {
                return Some(name.to_string());
            }
        }
    }
    None
}

#[allow(dead_code)]
fn _join_type_use(j: &JoinType) {
    let _ = j.sql_keyword();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::JoinType;

    #[test]
    fn filter_and_join_shared() {
        let mut rel = HashMap::new();
        rel.insert("dim".into(), "cte_dim".into());
        let filter = TransformationStep::Filter {
            condition: "x > 1".into(),
        };
        assert_eq!(
            emit_transform_step(&filter, "s0", &rel, WarehouseDialect::Duckdb).unwrap(),
            "SELECT * FROM s0 WHERE x > 1"
        );
        let join = TransformationStep::Join {
            right_query_id: "dim".into(),
            join_type: JoinType::Inner,
            left_on: vec!["k".into()],
            right_on: vec!["k".into()],
        };
        let sql = emit_transform_step(&join, "s0", &rel, WarehouseDialect::Duckdb).unwrap();
        assert!(sql.contains("INNER JOIN cte_dim"));
        assert!(sql.contains("USING"));
    }

    #[test]
    fn join_unequal_keys_preview_duckdb_excludes_right_keys() {
        let mut rel = HashMap::new();
        rel.insert("dim".into(), "cte_dim".into());
        let join = TransformationStep::Join {
            right_query_id: "dim".into(),
            join_type: JoinType::Inner,
            left_on: vec!["data_source_id".into()],
            right_on: vec!["id".into()],
        };
        let sql = emit_transform_step(&join, "s0", &rel, WarehouseDialect::Duckdb).unwrap();
        assert!(sql.contains("EXCLUDE (\"id\")"));
        assert!(sql.contains("\"id\" AS \"data_source_id\""));
        assert!(sql.contains("USING (\"data_source_id\")"));
    }

    #[test]
    fn join_unequal_keys_dbt_ref_left_wins_when_left_known() {
        let mut rel = HashMap::new();
        rel.insert(
            "dim".into(),
            "{{ ref('stg_sys_data_source_items') }}".into(),
        );
        let join = TransformationStep::Join {
            right_query_id: "dim".into(),
            join_type: JoinType::Inner,
            left_on: vec!["data_source_id".into()],
            right_on: vec!["id".into()],
        };
        let sql = emit_transform_step_ex(
            &join,
            "s0",
            &rel,
            WarehouseDialect::Postgres,
            Some("source('sys', 'data_extraction_sources')"),
        )
        .unwrap();
        assert!(sql.contains("_left_names"));
        assert!(sql.contains("source('sys', 'data_extraction_sources')"));
        assert!(!sql.contains("EXCLUDE"));
        assert!(!sql.contains("__' ~ _c.name"));
        assert!(sql.contains("not in _left_names"));
    }

    #[test]
    fn join_unequal_keys_dbt_ref_prefixes_when_left_unknown() {
        let mut rel = HashMap::new();
        rel.insert(
            "dim".into(),
            "{{ ref('stg_sys_data_source_items') }}".into(),
        );
        let join = TransformationStep::Join {
            right_query_id: "dim".into(),
            join_type: JoinType::Inner,
            left_on: vec!["data_source_id".into()],
            right_on: vec!["id".into()],
        };
        let sql = emit_transform_step(&join, "s0", &rel, WarehouseDialect::Duckdb).unwrap();
        assert!(sql.contains("stg_sys_data_source_items__' ~ _c.name"));
        assert!(!sql.contains("EXCLUDE"));
    }
}
