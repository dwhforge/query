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
            sql_rename_column(dialect, prev, from, to, left_dbt_relation)
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
            match dialect {
                WarehouseDialect::Duckdb => {
                    let mut left = format!("SELECT * FROM {prev}");
                    for oid in other_query_ids {
                        let other = relations
                            .get(oid)
                            .ok_or_else(|| format!("Append: query '{oid}' not compiled yet"))?;
                        left = format!("{left} UNION ALL BY NAME SELECT * FROM {other}");
                    }
                    Ok(left)
                }
                WarehouseDialect::Postgres => {
                    // Same meaning as DuckDB BY NAME: match columns by name, fill missing with NULL.
                    let left_rel = left_dbt_relation.ok_or_else(|| {
                        "Append (postgres): need a known left relation (LoadPostgres/FromQuery \
                         before schema-changing steps) for name-aligned UNION"
                            .to_string()
                    })?;
                    let mut right_models = Vec::with_capacity(other_query_ids.len());
                    for oid in other_query_ids {
                        let other = relations
                            .get(oid)
                            .ok_or_else(|| format!("Append: query '{oid}' not compiled yet"))?;
                        let model = parse_dbt_ref_model(other).ok_or_else(|| {
                            format!(
                                "Append (postgres): right side must be {{{{ ref('…') }}}} (got '{other}')"
                            )
                        })?;
                        right_models.push(model);
                    }
                    Ok(dbt_append_union_by_name(prev, left_rel, &right_models))
                }
            }
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

/// Case-insensitive column union; first-seen spelling is the canonical result name.
pub fn union_column_names(sources: &[&[String]]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen_lower = std::collections::HashSet::new();
    for cols in sources {
        for c in *cols {
            let key = c.to_ascii_lowercase();
            if seen_lower.insert(key) {
                out.push(c.clone());
            }
        }
    }
    out
}

/// Actual column name in `source_cols` matching `canonical` case-insensitively.
pub fn resolve_source_column<'a>(canonical: &str, source_cols: &'a [String]) -> Option<&'a str> {
    let want = canonical.to_ascii_lowercase();
    source_cols
        .iter()
        .find(|c| c.eq_ignore_ascii_case(&want))
        .map(|s| s.as_str())
}

/// SELECT list aligning `source_cols` to `canonical` result names (BY NAME semantics).
/// Missing → `NULL AS "canonical"`; present → `"actual" AS "canonical"` (always alias for stable names).
pub fn select_list_aligned(canonical: &[String], source_cols: &[String]) -> String {
    canonical
        .iter()
        .map(|name| match resolve_source_column(name, source_cols) {
            Some(actual) => format!(
                "{} AS {}",
                quote_ident(actual),
                quote_ident(name)
            ),
            None => format!("NULL AS {}", quote_ident(name)),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Portable `UNION ALL` with BY NAME semantics given known schemas (order / extras / case).
pub fn sql_union_all_aligned(
    left_from: &str,
    left_cols: &[String],
    rights: &[(String, Vec<String>)], // (from_sql, cols)
) -> String {
    let mut sources: Vec<&[String]> = vec![left_cols];
    for (_, cols) in rights {
        sources.push(cols.as_slice());
    }
    let canonical = union_column_names(&sources);
    let mut parts = vec![format!(
        "SELECT {} FROM {}",
        select_list_aligned(&canonical, left_cols),
        left_from
    )];
    for (from_sql, cols) in rights {
        parts.push(format!(
            "SELECT {} FROM {}",
            select_list_aligned(&canonical, cols),
            from_sql
        ));
    }
    parts.join("\nUNION ALL\n")
}

/// Jinja fragment: build `map` lower→actual from `rel` into `_maps.<map_name>`.
fn jinja_build_col_map(rel_expr: &str, map_name: &str) -> String {
    format!(
        "  {{% set {map_name} = {{}} %}}\n\
  {{% for _c in adapter.get_columns_in_relation({rel_expr}) %}}\n\
    {{% if {map_name}.update({{ (_c.name | lower): _c.name }}) %}}{{% endif %}}\n\
  {{% endfor %}}\n"
    )
}

/// Jinja SELECT list: for each canonical `_n` in `_ns.names`, use `_maps.<map>` actual or NULL.
fn jinja_select_aligned(map_name: &str, from_sql: &str) -> String {
    format!(
        "SELECT {{% for _n in _ns.names %}}{{% set _k = _n | lower %}}{{% if _k in {map_name} %}}{{{{ adapter.quote({map_name}[_k]) }}}} AS {{{{ adapter.quote(_n) }}}}{{% else %}}NULL AS {{{{ adapter.quote(_n) }}}}{{% endif %}}{{% if not loop.last %}}, {{% endif %}}{{% endfor %}} FROM {from_sql}"
    )
}

/// Postgres / dbt stand-in for DuckDB `UNION ALL BY NAME`.
/// Left and every right: NULL for missing cols; quote **actual** source names (case-safe).
fn dbt_append_union_by_name(prev: &str, left_dbt: &str, right_models: &[String]) -> String {
    let mut out = String::new();
    out.push_str("{% set _ns = namespace(names=[], lower=[]) %}\n");
    out.push_str(&format!("  {{% set _lrel = {left_dbt} %}}\n"));
    for (i, m) in right_models.iter().enumerate() {
        out.push_str(&format!("  {{% set _r{i} = ref('{m}') %}}\n"));
    }

    // Canonical names: left order first, then right-only (case-insensitive).
    out.push_str(
        "  {% for _c in adapter.get_columns_in_relation(_lrel) %}\n\
    {% if (_c.name | lower) not in _ns.lower %}\n\
      {% do _ns.names.append(_c.name) %}\n\
      {% do _ns.lower.append(_c.name | lower) %}\n\
    {% endif %}\n\
  {% endfor %}\n",
    );
    for i in 0..right_models.len() {
        out.push_str(&format!(
            "  {{% for _c in adapter.get_columns_in_relation(_r{i}) %}}\n\
    {{% if (_c.name | lower) not in _ns.lower %}}\n\
      {{% do _ns.names.append(_c.name) %}}\n\
      {{% do _ns.lower.append(_c.name | lower) %}}\n\
    {{% endif %}}\n\
  {{% endfor %}}\n"
        ));
    }

    // lower → actual spelling per source (left + each right).
    out.push_str(&jinja_build_col_map("_lrel", "_lmap"));
    for i in 0..right_models.len() {
        out.push_str(&jinja_build_col_map(&format!("_r{i}"), &format!("_rmap{i}")));
    }

    // Every branch projects the full canonical set; missing → NULL AS canonical.
    out.push_str("  ");
    out.push_str(&jinja_select_aligned("_lmap", prev));
    for i in 0..right_models.len() {
        out.push_str("\n  UNION ALL\n  ");
        out.push_str(&jinja_select_aligned(
            &format!("_rmap{i}"),
            &format!("{{{{ _r{i} }}}}"),
        ));
    }
    out
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

    #[test]
    fn append_duckdb_uses_union_all_by_name() {
        let mut rel = HashMap::new();
        rel.insert("us".into(), "cte_us".into());
        let step = TransformationStep::Append {
            other_query_ids: vec!["us".into()],
        };
        let sql = emit_transform_step(&step, "s0", &rel, WarehouseDialect::Duckdb).unwrap();
        assert!(sql.contains("UNION ALL BY NAME"));
        assert!(sql.contains("cte_us"));
    }

    #[test]
    fn union_names_order_and_case_first_wins() {
        let left = vec!["id".into(), "Amount".into()];
        let right = vec!["amount".into(), "id".into(), "currency".into()];
        let names = union_column_names(&[&left, &right]);
        assert_eq!(names, vec!["id", "Amount", "currency"]);
    }

    #[test]
    fn select_list_right_only_null_on_left() {
        let canonical = vec!["id".into(), "amount".into(), "currency".into()];
        let left = vec!["id".into(), "amount".into()];
        let sql = select_list_aligned(&canonical, &left);
        assert_eq!(
            sql,
            "\"id\" AS \"id\", \"amount\" AS \"amount\", NULL AS \"currency\""
        );
    }

    #[test]
    fn select_list_left_only_null_on_right() {
        let canonical = vec!["id".into(), "amount".into(), "region".into()];
        let right = vec!["id".into(), "amount".into()];
        let sql = select_list_aligned(&canonical, &right);
        assert!(sql.ends_with("NULL AS \"region\""));
        assert!(!sql.contains("\"region\" AS \"region\""));
    }

    #[test]
    fn select_list_case_uses_actual_source_name() {
        let canonical = vec!["Amount".into()]; // left spelling wins
        let right = vec!["amount".into()];
        let sql = select_list_aligned(&canonical, &right);
        // Must quote the *right* physical name, alias to canonical.
        assert_eq!(sql, "\"amount\" AS \"Amount\"");
        assert_ne!(sql, "\"Amount\" AS \"Amount\"");
    }

    #[test]
    fn select_list_reorder_same_names() {
        let canonical = vec!["id".into(), "amount".into(), "region".into()];
        let right = vec!["region".into(), "id".into(), "amount".into()];
        assert_eq!(
            select_list_aligned(&canonical, &right),
            "\"id\" AS \"id\", \"amount\" AS \"amount\", \"region\" AS \"region\""
        );
    }

    #[test]
    fn sql_union_all_aligned_full_scenario() {
        let left = vec!["id".into(), "Amount".into()];
        let right = vec!["amount".into(), "id".into(), "currency".into()];
        let sql = sql_union_all_aligned(
            "s0",
            &left,
            &[("{{ ref('stg_us') }}".into(), right)],
        );
        let (left_sel, right_sel) = sql.split_once("\nUNION ALL\n").unwrap();
        assert!(left_sel.contains("NULL AS \"currency\""));
        assert!(left_sel.contains("\"Amount\" AS \"Amount\""));
        assert!(right_sel.contains("\"amount\" AS \"Amount\""));
        assert!(right_sel.contains("\"currency\" AS \"currency\""));
        assert!(!right_sel.contains("\"Amount\" AS \"Amount\""));
    }

    #[test]
    fn append_postgres_jinja_nulls_both_sides_and_maps_actual_names() {
        let mut rel = HashMap::new();
        rel.insert("us".into(), "{{ ref('stg_sales_us') }}".into());
        let step = TransformationStep::Append {
            other_query_ids: vec!["us".into()],
        };
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &rel,
            WarehouseDialect::Postgres,
            Some("ref('stg_sales_eu')"),
        )
        .unwrap();
        assert!(!sql.contains("UNION ALL SELECT *"), "must not use positional UNION ALL");
        assert!(sql.contains("_lmap"), "left lower→actual map");
        assert!(sql.contains("_rmap0"), "right lower→actual map");
        // Both branches must be able to emit NULL (right-only on left, left-only on right).
        assert_eq!(
            sql.matches("NULL AS {{ adapter.quote(_n) }}").count(),
            2,
            "NULL filler in left and right SELECT templates"
        );
        assert!(sql.contains("_lmap[_k]"), "left uses actual name from map");
        assert!(sql.contains("_rmap0[_k]"), "right uses actual name from map");
        assert!(sql.contains("AS {{ adapter.quote(_n) }}"));
    }

    #[test]
    fn append_postgres_requires_left_relation() {
        let mut rel = HashMap::new();
        rel.insert("us".into(), "{{ ref('stg_sales_us') }}".into());
        let step = TransformationStep::Append {
            other_query_ids: vec!["us".into()],
        };
        let err = emit_transform_step(&step, "s0", &rel, WarehouseDialect::Postgres).unwrap_err();
        assert!(err.contains("left relation"));
    }

    #[test]
    fn rename_postgres_uses_jinja_column_list() {
        let sql = emit_transform_step_ex(
            &TransformationStep::RenameColumn {
                from: "amt".into(),
                to: "amount".into(),
            },
            "s0",
            &HashMap::new(),
            WarehouseDialect::Postgres,
            Some("ref('stg_sales')"),
        )
        .unwrap();
        assert!(!sql.contains("EXCLUDE"));
        assert!(sql.contains("ref('stg_sales')"));
        assert!(sql.contains("AS \"amount\""));
        assert!(sql.contains("'amt'"));
    }

    #[test]
    fn rename_postgres_errors_without_left_relation() {
        let err = emit_transform_step(
            &TransformationStep::RenameColumn {
                from: "a".into(),
                to: "b".into(),
            },
            "s0",
            &HashMap::new(),
            WarehouseDialect::Postgres,
        )
        .unwrap_err();
        assert!(err.contains("left relation") || err.contains("SelectColumns"));
    }
}
