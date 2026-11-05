//! Shared step → SQL emit (ADR-0015). Transform steps are dialect-aware once;
//! Load / FromQuery / SqlModel adapters stay mode-specific at call sites.

use crate::dialect::{sql_rename_column, WarehouseDialect};
use crate::graph::direct_deps;
use crate::model::{
    ApplyKeyMapOutputBinding, JoinType, KeyMapEntry, NormalizeOp, TransformationStep,
};
use crate::sql_escape::{escape_sql_string, quote_ident};
use std::collections::HashMap;

fn require_prev(prev: &str, op: &str) -> Result<(), String> {
    if prev.is_empty() {
        Err(format!("{op} requires a previous step in the same query"))
    } else {
        Ok(())
    }
}

/// Optional schema / dbt hints for emit (ADR-0018).
#[derive(Debug, Clone, Default)]
pub struct EmitSchemaOpts<'a> {
    /// Bare dbt call (`ref('…')` / `source('…','…')`) when physical relation still matches CTE.
    pub left_dbt_relation: Option<&'a str>,
    /// Columns leaving the previous step (derived schema).
    pub prev_columns: Option<&'a [String]>,
    /// Known final schemas of other queries (Join/Append rights), query_id → columns.
    pub query_columns: Option<&'a HashMap<String, Vec<String>>>,
    /// ApplyKeyMap: map_id → SQL relation (e.g. `{{ ref('map_x') }}`) for seed join on export.
    pub key_map_relations: Option<&'a HashMap<String, String>>,
    /// ApplyKeyMap: map_id → (from_columns, output_columns) on the map relation.
    pub key_map_columns: Option<&'a HashMap<String, (Vec<String>, Vec<String>)>>,
    /// ApplyKeyMap range SCD: map_id → (valid_from_col, valid_to_col) on the map relation.
    pub key_map_range: Option<&'a HashMap<String, (String, String)>>,
}

/// Emit a mid-chain / transform step. `relations` maps query_id → SQL relation
/// (CTE name for preview, `{{ ref('…') }}` for dbt).
pub fn emit_transform_step(
    step: &TransformationStep,
    prev: &str,
    relations: &HashMap<String, String>,
    dialect: WarehouseDialect,
) -> Result<String, String> {
    emit_transform_step_ex(step, prev, relations, dialect, EmitSchemaOpts::default())
}

/// Like [`emit_transform_step`], with schema / left-dbt options.
pub fn emit_transform_step_ex(
    step: &TransformationStep,
    prev: &str,
    relations: &HashMap<String, String>,
    dialect: WarehouseDialect,
    opts: EmitSchemaOpts<'_>,
) -> Result<String, String> {
    let left_dbt_relation = opts.left_dbt_relation;
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
            if let Some(cols) = opts.prev_columns {
                return Ok(format!(
                    "SELECT {} FROM {prev}",
                    rename_select_list(cols, from, to)?
                ));
            }
            sql_rename_column(dialect, prev, from, to, left_dbt_relation)
        }
        TransformationStep::DeriveColumn {
            name,
            expression,
            mode,
            op,
            sql_dialect: _,
        } => {
            require_prev(prev, "DeriveColumn")?;
            let expr = crate::derive_ops::resolve_derive_expression(
                *mode,
                op.as_ref(),
                expression,
                dialect,
            )?;
            Ok(format!(
                "SELECT *, ({expr}) AS {} FROM {prev}",
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
            let right_id = right_query_id.compiler_id()?;
            let right = relations.get(right_id).ok_or_else(|| {
                format!("Join: right query '{right_id}' not compiled yet (check deps)")
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
                    let select = dbt_join_select_jinja(
                        &model,
                        &skip,
                        left_dbt_relation,
                        opts.prev_columns,
                    );
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
                    opts.prev_columns,
                )
            }
        }
        TransformationStep::Append { other_query_ids } => {
            require_prev(prev, "Append")?;
            if other_query_ids.is_empty() {
                return Err("Append: other_query_ids empty".into());
            }
            // Portable BY NAME when step schemas are known (ADR-0018) — both dialects.
            if let (Some(left_cols), Some(qcols)) = (opts.prev_columns, opts.query_columns) {
                let mut rights = Vec::with_capacity(other_query_ids.len());
                let mut all_known = true;
                for oid in other_query_ids {
                    let oid = oid.compiler_id()?;
                    let other = relations
                        .get(oid)
                        .ok_or_else(|| format!("Append: query '{oid}' not compiled yet"))?;
                    match qcols.get(oid) {
                        Some(cols) => rights.push((other.clone(), cols.clone())),
                        None => {
                            all_known = false;
                            break;
                        }
                    }
                }
                if all_known {
                    return sql_union_all_aligned(prev, left_cols, &rights);
                }
            }
            match dialect {
                WarehouseDialect::Duckdb => {
                    let mut left = format!("SELECT * FROM {prev}");
                    for oid in other_query_ids {
                        let oid = oid.compiler_id()?;
                        let other = relations
                            .get(oid)
                            .ok_or_else(|| format!("Append: query '{oid}' not compiled yet"))?;
                        left = format!("{left} UNION ALL BY NAME SELECT * FROM {other}");
                    }
                    Ok(left)
                }
                WarehouseDialect::Postgres => {
                    let left_rel = left_dbt_relation.ok_or_else(|| {
                        "Append (postgres): need step schema or a known left relation \
                         (LoadPostgres/FromQuery) for name-aligned UNION"
                            .to_string()
                    })?;
                    let mut right_models = Vec::with_capacity(other_query_ids.len());
                    for oid in other_query_ids {
                        let oid = oid.compiler_id()?;
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
            for dep in direct_deps(std::slice::from_ref(step))? {
                if let Some(rel) = relations.get(&dep) {
                    sql = sql.replace(&format!("{{{{query:{dep}}}}}"), rel);
                }
            }
            Ok(sql)
        }
        TransformationStep::NormalizeKey { columns, ops } => {
            require_prev(prev, "NormalizeKey")?;
            if columns.is_empty() {
                return Err("NormalizeKey: columns must be non-empty".into());
            }
            if ops.is_empty() {
                return Err("NormalizeKey: ops must be non-empty".into());
            }
            emit_normalize_key(dialect, prev, columns, ops, opts.prev_columns)
        }
        TransformationStep::ApplyKeyMap {
            column,
            columns,
            output_column,
            output_bindings,
            as_of_column,
            map_id,
            entries,
        } => {
            require_prev(prev, "ApplyKeyMap")?;
            let fact_cols = crate::model::apply_keymap_columns(column, columns);
            if fact_cols.is_empty() || fact_cols.iter().any(|c| c.trim().is_empty()) {
                return Err("ApplyKeyMap: columns must be non-empty".into());
            }
            let map_key = map_id.compiler_id()?;
            if map_key.trim().is_empty() {
                return Err("ApplyKeyMap: map_id must be non-empty".into());
            }
            let seed_rel = opts
                .key_map_relations
                .and_then(|m| m.get(map_key).map(|s| s.as_str()));
            let (from_cols, output_cols) = opts
                .key_map_columns
                .and_then(|m| m.get(map_key))
                .map(|(fs, outs)| (fs.clone(), outs.clone()))
                .unwrap_or_else(|| (vec!["from".into()], vec!["to".into()]));
            if from_cols.len() != fact_cols.len() {
                return Err(format!(
                    "ApplyKeyMap: fact columns ({}) vs map from_columns ({})",
                    fact_cols.len(),
                    from_cols.len()
                ));
            }
            if output_cols.is_empty() || output_cols.iter().any(|c| c.trim().is_empty()) {
                return Err("ApplyKeyMap: map output_columns must be non-empty".into());
            }
            let primary_out = output_cols[0].as_str();
            let bindings = crate::model::apply_keymap_output_bindings(
                output_column.as_deref(),
                output_bindings,
                &fact_cols,
                primary_out,
            );
            if bindings.is_empty() {
                return Err("ApplyKeyMap: output_bindings must be non-empty".into());
            }
            let mut seen_dest = std::collections::HashSet::new();
            for b in &bindings {
                let d = b.destination_column.trim();
                if d.is_empty() || b.map_column.trim().is_empty() {
                    return Err("ApplyKeyMap: output_bindings need map_column and destination_column".into());
                }
                if !output_cols
                    .iter()
                    .any(|c| c.eq_ignore_ascii_case(b.map_column.trim()))
                {
                    return Err(format!(
                        "ApplyKeyMap: map_column '{}' not in map outputs {:?}",
                        b.map_column, output_cols
                    ));
                }
                let fold = ascii_fold_name(d);
                if !seen_dest.insert(fold) {
                    return Err(format!(
                        "ApplyKeyMap: duplicate destination_column '{d}'"
                    ));
                }
            }
            let range = opts
                .key_map_range
                .and_then(|m| m.get(map_key))
                .map(|(vf, vt)| (vf.as_str(), vt.as_str()));
            if range.is_some() {
                let as_of = as_of_column
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if as_of.is_none() {
                    return Err(format!(
                        "ApplyKeyMap '{map_key}': range SCD map requires as_of_column \
                         (fact event-time) — ADR-0028"
                    ));
                }
            }
            emit_apply_key_map(
                dialect,
                prev,
                &fact_cols,
                &bindings,
                entries,
                seed_rel,
                &from_cols,
                &output_cols,
                map_key,
                opts.prev_columns,
                as_of_column
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
                range,
            )
        }
        TransformationStep::LoadCsv { .. }
        | TransformationStep::LoadParquet { .. }
        | TransformationStep::LoadPostgres { .. }
        | TransformationStep::LoadDuckdb { .. }
        | TransformationStep::FromQuery { .. }
        | TransformationStep::SqlModel { .. } => Err(
            "emit_transform_step: Load/FromQuery/SqlModel must use mode-specific adapters".into(),
        ),
    }
}

/// Nest normalize ops around a column SQL expression (e.g. `"region"` → `trim(lower("region"))`).
pub fn normalize_column_expr(col_sql: &str, ops: &[NormalizeOp]) -> String {
    normalize_expr(col_sql, ops)
}

/// Cast to VARCHAR first, then apply normalize ops.
/// Required for numeric join keys: DuckDB rejects `trim(BIGINT)`.
pub fn normalize_key_column_expr(col_sql: &str, ops: &[NormalizeOp]) -> String {
    let as_text = format!("CAST({col_sql} AS VARCHAR)");
    if ops.is_empty() {
        as_text
    } else {
        normalize_expr(&as_text, ops)
    }
}

fn normalize_expr(col_sql: &str, ops: &[NormalizeOp]) -> String {
    let mut e = col_sql.to_string();
    for op in ops {
        e = match op {
            NormalizeOp::Trim => format!("trim({e})"),
            NormalizeOp::Lower => format!("lower({e})"),
            NormalizeOp::Upper => format!("upper({e})"),
            NormalizeOp::CollapseSpace => {
                format!("regexp_replace(trim({e}), '\\s+', ' ', 'g')")
            }
            NormalizeOp::LtrimZeros => format!("regexp_replace({e}, '^0+', '')"),
        };
    }
    e
}

fn emit_overwrite_columns(
    dialect: WarehouseDialect,
    prev: &str,
    overwrites: &[(String, String)],
    prev_columns: Option<&[String]>,
) -> Result<String, String> {
    if overwrites.is_empty() {
        return Err("overwrite: empty".into());
    }
    let fold_set: Vec<String> = overwrites
        .iter()
        .map(|(c, _)| ascii_fold_name(c))
        .collect();

    match dialect {
        WarehouseDialect::Duckdb => {
            let excl = overwrites
                .iter()
                .map(|(c, _)| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let adds = overwrites
                .iter()
                .map(|(c, expr)| format!("{expr} AS {}", quote_ident(c)))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "SELECT * EXCLUDE ({excl}), {adds} FROM {prev}"
            ))
        }
        WarehouseDialect::Postgres => {
            let Some(cols) = prev_columns else {
                return Err(
                    "NormalizeKey/ApplyKeyMap (postgres): prev_columns required".into(),
                );
            };
            let parts: Vec<String> = cols
                .iter()
                .map(|c| {
                    let f = ascii_fold_name(c);
                    if let Some((_, expr)) = overwrites
                        .iter()
                        .find(|(oc, _)| ascii_fold_name(oc) == f)
                    {
                        format!("{expr} AS {}", quote_ident(c))
                    } else if fold_set.contains(&f) {
                        // renamed target already emitted under original name
                        quote_ident(c)
                    } else {
                        quote_ident(c)
                    }
                })
                .collect();
            Ok(format!("SELECT {} FROM {prev}", parts.join(", ")))
        }
    }
}

fn emit_normalize_key(
    dialect: WarehouseDialect,
    prev: &str,
    columns: &[String],
    ops: &[NormalizeOp],
    prev_columns: Option<&[String]>,
) -> Result<String, String> {
    let overwrites: Vec<(String, String)> = columns
        .iter()
        .map(|c| {
            let q = quote_ident(c);
            (c.clone(), normalize_key_column_expr(&q, ops))
        })
        .collect();
    emit_overwrite_columns(dialect, prev, &overwrites, prev_columns)
}

/// Whether `output_column` already exists on the prior step.
///
/// - Known `prev_columns` → definitive membership check.
/// - Unknown schema → only unambiguous when output is one of the Apply fact cols (overwrite).
/// - Otherwise refuse: guessing "new" silently keeps the old value beside `*_1` duplicates.
fn output_column_exists_on_prev(
    output_column: &str,
    fact_cols: &[String],
    prev_columns: Option<&[String]>,
) -> Result<bool, String> {
    let fold = ascii_fold_name(output_column);
    if let Some(cols) = prev_columns {
        return Ok(cols.iter().any(|c| ascii_fold_name(c) == fold));
    }
    if fact_cols.iter().any(|c| ascii_fold_name(c) == fold) {
        return Ok(true);
    }
    Err(format!(
        "ApplyKeyMap: cannot tell if output_column '{output_column}' already exists \
         (prior step has no inferred schema, e.g. bare SqlModel). \
         Overwrite a fact column, or ensure the prior schema is known."
    ))
}

/// Runtime abort expression. `when_sql` must be the same predicate that guards
/// the CASE branch so Postgres cannot constant-fold `1/0` at plan time (ADR-0037).
fn emit_abort_expr(dialect: WarehouseDialect, message: &str, when_sql: &str) -> String {
    let msg = escape_sql_string(message);
    match dialect {
        WarehouseDialect::Duckdb => format!("error('{msg}')"),
        // Subquery WHERE depends on row predicates → not a plan-time constant.
        // True → SELECT 0 → 1/0 fails the statement; false → empty → NULL (unused).
        WarehouseDialect::Postgres => format!(
            "((1 / (SELECT 0 WHERE ({when_sql})))::VARCHAR /* {msg} */)"
        ),
    }
}

/// Allocates collision-safe internal SQL identifiers (ADR-0037 review).
struct AliasPool {
    used: std::collections::HashSet<String>,
}

impl AliasPool {
    fn with_reserved<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        let mut used = std::collections::HashSet::new();
        for n in names {
            let t = n.trim();
            if !t.is_empty() {
                used.insert(ascii_fold_name(t));
            }
        }
        Self { used }
    }

    fn alloc(&mut self, preferred: &str) -> String {
        let base = preferred.trim();
        let mut name = base.to_string();
        let mut i = 0u32;
        while self.used.contains(&ascii_fold_name(&name)) {
            i += 1;
            name = format!("{base}_{i}");
        }
        self.used.insert(ascii_fold_name(&name));
        name
    }
}

struct ApplyInternalAliases {
    rid: String,
    match_n: String,
    guard: String,
    rn: String,
    from: Vec<String>,
    out: Vec<String>,
    vf: Option<String>,
    vt: Option<String>,
}

fn alloc_apply_aliases(
    n: usize,
    out_n: usize,
    range: bool,
    prev_columns: Option<&[String]>,
    fact_cols: &[String],
    dest_cols: &[String],
    from_cols: &[String],
    output_cols: &[String],
    as_of: Option<&str>,
) -> Result<ApplyInternalAliases, String> {
    // SELECT * / EXCLUDE shares the user namespace with internal aliases. Without the
    // full prior schema we cannot prove uniqueness (DuckDB renames duplicate ids).
    let Some(prev) = prev_columns else {
        return Err(
            "ApplyKeyMap: prev_columns required to allocate collision-safe internal \
             aliases (SELECT * projection cannot prove uniqueness against an unknown schema)"
                .into(),
        );
    };
    let mut reserved: Vec<&str> = Vec::new();
    for c in prev {
        reserved.push(c.as_str());
    }
    for c in fact_cols {
        reserved.push(c.as_str());
    }
    for c in dest_cols {
        reserved.push(c.as_str());
    }
    for c in from_cols.iter().chain(output_cols.iter()) {
        reserved.push(c.as_str());
    }
    if let Some(a) = as_of {
        reserved.push(a);
    }
    let mut pool = AliasPool::with_reserved(reserved);
    Ok(ApplyInternalAliases {
        rid: pool.alloc("_dwh_rid"),
        match_n: pool.alloc("_dwh_match_n"),
        guard: pool.alloc("_dwh_apply_guard"),
        rn: pool.alloc("_dwh_rn"),
        from: (0..n)
            .map(|i| pool.alloc(&format!("_dwh_mf_{i}")))
            .collect(),
        out: (0..out_n)
            .map(|i| pool.alloc(&format!("_dwh_mo_{i}")))
            .collect(),
        vf: range.then(|| pool.alloc("_dwh_mvf")),
        vt: range.then(|| pool.alloc("_dwh_mvt")),
    })
}

fn emit_apply_key_map(
    dialect: WarehouseDialect,
    prev: &str,
    fact_cols: &[String],
    bindings: &[ApplyKeyMapOutputBinding],
    entries: &[KeyMapEntry],
    seed_relation: Option<&str>,
    from_cols: &[String],
    output_cols: &[String],
    map_id: &str,
    prev_columns: Option<&[String]>,
    as_of_column: Option<&str>,
    range_cols: Option<(&str, &str)>,
) -> Result<String, String> {
    let n = fact_cols.len();
    let out_n = output_cols.len();
    debug_assert_eq!(n, from_cols.len());
    let scd = range_cols.zip(as_of_column);
    let is_seed = seed_relation.is_some();

    let mut dest_meta: Vec<(String, bool)> = Vec::with_capacity(bindings.len());
    for b in bindings {
        let dest = b.destination_column.trim().to_string();
        let exists = output_column_exists_on_prev(&dest, fact_cols, prev_columns)?;
        dest_meta.push((dest, exists));
    }
    let dest_cols: Vec<String> = dest_meta.iter().map(|(d, _)| d.clone()).collect();
    let aliases = alloc_apply_aliases(
        n,
        out_n,
        range_cols.is_some(),
        prev_columns,
        fact_cols,
        &dest_cols,
        from_cols,
        output_cols,
        as_of_column,
    )?;

    // Empty correspondence: miss path only.
    if !is_seed && entries.is_empty() {
        let mut overwrites = Vec::new();
        let mut news = Vec::new();
        for (dest, exists) in &dest_meta {
            if *exists {
                overwrites.push((
                    dest.clone(),
                    format!("CAST({} AS VARCHAR)", quote_ident(dest)),
                ));
            } else {
                news.push(dest.clone());
            }
        }
        if news.is_empty() {
            return if overwrites.is_empty() {
                Ok(format!("SELECT * FROM {prev} AS t"))
            } else {
                emit_overwrite_columns(dialect, prev, &overwrites, prev_columns)
            };
        }
        return match dialect {
            WarehouseDialect::Duckdb => {
                let extras: Vec<String> = news
                    .iter()
                    .map(|d| format!("CAST(NULL AS VARCHAR) AS {}", quote_ident(d)))
                    .collect();
                if overwrites.is_empty() {
                    Ok(format!(
                        "SELECT t.*, {} FROM {prev} AS t",
                        extras.join(", ")
                    ))
                } else {
                    // Overwrite via EXCLUDE then append new nulls — reuse overwrite helper then wrap.
                    let base = emit_overwrite_columns(dialect, prev, &overwrites, prev_columns)?;
                    Ok(format!(
                        "SELECT b.*, {} FROM ({base}) AS b",
                        extras.join(", ")
                    ))
                }
            }
            WarehouseDialect::Postgres => {
                let Some(cols) = prev_columns else {
                    return Err("ApplyKeyMap (postgres): prev_columns required".into());
                };
                let overwrite_folds: std::collections::HashSet<String> = dest_meta
                    .iter()
                    .filter(|(_, e)| *e)
                    .map(|(d, _)| ascii_fold_name(d))
                    .collect();
                let mut parts: Vec<String> = cols
                    .iter()
                    .map(|c| {
                        if overwrite_folds.contains(&ascii_fold_name(c)) {
                            format!(
                                "CAST(t.{0} AS VARCHAR) AS {0}",
                                quote_ident(c)
                            )
                        } else {
                            format!("t.{}", quote_ident(c))
                        }
                    })
                    .collect();
                for d in &news {
                    parts.push(format!("CAST(NULL AS TEXT) AS {}", quote_ident(d)));
                }
                Ok(format!("SELECT {} FROM {prev} AS t", parts.join(", ")))
            }
        };
    }

    let map_sql = if let Some(rel) = seed_relation {
        format!("{rel} AS m")
    } else {
        let (vf_name, vt_name) = range_cols.unwrap_or(("", ""));
        let values = entries
            .iter()
            .map(|e| {
                let parts = e.from_parts_eff();
                let outs = e.output_values_eff();
                let mut cells: Vec<String> = parts
                    .iter()
                    .take(n)
                    .map(|p| format!("'{}'", escape_sql_string(p.trim())))
                    .collect();
                while cells.len() < n {
                    cells.push("''".into());
                }
                for i in 0..out_n {
                    let v = outs.get(i).map(String::as_str).unwrap_or("");
                    cells.push(format!("'{}'", escape_sql_string(v)));
                }
                if range_cols.is_some() {
                    let vf = e
                        .attrs
                        .get(vf_name)
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("");
                    let vt = e
                        .attrs
                        .get(vt_name)
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty());
                    cells.push(format!("'{}'", escape_sql_string(vf)));
                    match vt {
                        Some(v) => cells.push(format!("'{}'", escape_sql_string(v))),
                        None => cells.push("NULL".into()),
                    }
                }
                format!("({})", cells.join(", "))
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut alias_list: Vec<String> = aliases.from.clone();
        alias_list.extend(aliases.out.iter().cloned());
        if let (Some(vf), Some(vt)) = (&aliases.vf, &aliases.vt) {
            alias_list.push(vf.clone());
            alias_list.push(vt.clone());
        }
        format!("(VALUES {values}) AS m({})", alias_list.join(", "))
    };

    let mut join_parts: Vec<String> = (0..n)
        .map(|i| {
            let qf = quote_ident(&fact_cols[i]);
            let mf = &aliases.from[i];
            if is_seed {
                let qm = quote_ident(&from_cols[i]);
                // Join uses physical map cols; projection aliases them separately.
                format!("CAST(t0.{qf} AS VARCHAR) = CAST(m.{qm} AS VARCHAR)")
            } else {
                format!("CAST(t0.{qf} AS VARCHAR) = m.{mf}")
            }
        })
        .collect();
    if let Some(((vf_col, vt_col), as_of)) = scd {
        let q_as = quote_ident(as_of);
        if is_seed {
            let q_vf = quote_ident(vf_col);
            let q_vt = quote_ident(vt_col);
            join_parts.push(format!(
                "CAST(t0.{q_as} AS TIMESTAMP) >= CAST(m.{q_vf} AS TIMESTAMP) \
                 AND (m.{q_vt} IS NULL OR CAST(t0.{q_as} AS TIMESTAMP) < CAST(m.{q_vt} AS TIMESTAMP))"
            ));
        } else {
            let vf = aliases.vf.as_deref().unwrap();
            let vt = aliases.vt.as_deref().unwrap();
            join_parts.push(format!(
                "CAST(t0.{q_as} AS TIMESTAMP) >= CAST(m.{vf} AS TIMESTAMP) \
                 AND (m.{vt} IS NULL OR CAST(t0.{q_as} AS TIMESTAMP) < CAST(m.{vt} AS TIMESTAMP))"
            ));
        }
    }
    let join_on = join_parts.join(" AND ");

    // Always project map fields under collision-safe aliases (never same name as fact).
    let mut map_select_cols: Vec<String> = Vec::new();
    if is_seed {
        for (i, c) in from_cols.iter().enumerate() {
            map_select_cols.push(format!(
                "m.{} AS {}",
                quote_ident(c),
                aliases.from[i]
            ));
        }
        for (i, c) in output_cols.iter().enumerate() {
            map_select_cols.push(format!(
                "m.{} AS {}",
                quote_ident(c),
                aliases.out[i]
            ));
        }
        if let Some(((vf, vt), _)) = scd {
            map_select_cols.push(format!(
                "m.{} AS {}",
                quote_ident(vf),
                aliases.vf.as_deref().unwrap()
            ));
            map_select_cols.push(format!(
                "m.{} AS {}",
                quote_ident(vt),
                aliases.vt.as_deref().unwrap()
            ));
        }
    } else {
        for a in &aliases.from {
            map_select_cols.push(format!("m.{a}"));
        }
        for a in &aliases.out {
            map_select_cols.push(format!("m.{a}"));
        }
        if let (Some(vf), Some(vt)) = (&aliases.vf, &aliases.vt) {
            map_select_cols.push(format!("m.{vf}"));
            map_select_cols.push(format!("m.{vt}"));
        }
    }
    let map_select = if map_select_cols.is_empty() {
        String::new()
    } else {
        format!(", {}", map_select_cols.join(", "))
    };

    let rid = &aliases.rid;
    let match_n = &aliases.match_n;
    let guard = &aliases.guard;
    let rn = &aliases.rn;

    let joined_cte = format!(
        "SELECT t0.*, COUNT(*) OVER (PARTITION BY t0.{rid}) AS {match_n}{map_select}\n\
         FROM (SELECT *, row_number() OVER () AS {rid} FROM {prev}) AS t0\n\
         LEFT JOIN {map_sql} ON {join_on}"
    );

    // Predicates: `row_alias` is `j0` in the guard subquery, `j` in the outer SELECT.
    let amb_cond = |alias: &str| format!("{alias}.{match_n} > 1");
    let matched_probe = |alias: &str| format!("{alias}.{}", aliases.from[0]);
    let null_cond = |alias: &str| {
        let checks: Vec<String> = aliases
            .out
            .iter()
            .map(|o| {
                let expr = format!("{alias}.{o}");
                format!("({expr} IS NULL OR CAST({expr} AS VARCHAR) = '')")
            })
            .collect();
        format!(
            "{} IS NOT NULL AND ({})",
            matched_probe(alias),
            checks.join(" OR ")
        )
    };

    let amb_abort_j0 = emit_abort_expr(
        dialect,
        &format!("KeyMap {map_id}: ambiguous From (row-preserving Apply refused)"),
        &amb_cond("j0"),
    );
    let null_abort_j0 = emit_abort_expr(
        dialect,
        &format!("KeyMap {map_id}: NULL or blank output on matched row"),
        &null_cond("j0"),
    );
    let amb_abort_j = emit_abort_expr(
        dialect,
        &format!("KeyMap {map_id}: ambiguous From (row-preserving Apply refused)"),
        &amb_cond("j"),
    );
    let null_abort_j = emit_abort_expr(
        dialect,
        &format!("KeyMap {map_id}: NULL or blank output on matched row"),
        &null_cond("j"),
    );

    // Force uniqueness/NULL guards to evaluate even when destinations are pruned.
    let guard_force = format!(
        "CASE \
           WHEN {} THEN {amb_abort_j0} \
           WHEN {} THEN {null_abort_j0} \
           ELSE CAST(NULL AS VARCHAR) \
         END AS {guard}",
        amb_cond("j0"),
        null_cond("j0"),
    );

    let mut out_exprs: Vec<String> = Vec::new();
    for (i, b) in bindings.iter().enumerate() {
        let dest = b.destination_column.trim();
        let exists = dest_meta[i].1;
        let idx = output_cols
            .iter()
            .position(|c| c.eq_ignore_ascii_case(b.map_column.trim()))
            .unwrap_or(0);
        let map_expr = format!("j.{}", aliases.out[idx]);
        let q_out = quote_ident(dest);
        let miss_branch = if exists {
            format!("CAST(j.{q_out} AS VARCHAR)")
        } else {
            "CAST(NULL AS VARCHAR)".to_string()
        };
        out_exprs.push(format!(
            "CASE \
               WHEN {} THEN {amb_abort_j} \
               WHEN {} THEN {null_abort_j} \
               WHEN {} IS NULL THEN {miss_branch} \
               ELSE CAST({map_expr} AS VARCHAR) \
             END AS {q_out}",
            amb_cond("j"),
            null_cond("j"),
            matched_probe("j"),
        ));
    }

    let overwrite_dests: Vec<String> = dest_meta
        .iter()
        .filter(|(_, e)| *e)
        .map(|(d, _)| quote_ident(d))
        .collect();

    // Internal aliases only — never EXCLUDE fact columns that share map names.
    let mut map_aliases: Vec<String> = aliases.from.clone();
    map_aliases.extend(aliases.out.iter().cloned());
    if let (Some(vf), Some(vt)) = (&aliases.vf, &aliases.vt) {
        map_aliases.push(vf.clone());
        map_aliases.push(vt.clone());
    }

    match dialect {
        WarehouseDialect::Duckdb => {
            let mut exclude = vec![
                rid.clone(),
                match_n.clone(),
                guard.clone(),
            ];
            exclude.extend(overwrite_dests);
            exclude.extend(map_aliases);
            let mut seen = std::collections::HashSet::new();
            exclude.retain(|c| seen.insert(c.clone()));
            // WHERE forces guard evaluation before QUALIFY (no silent first-row).
            Ok(format!(
                "SELECT j.* EXCLUDE ({}), {}\nFROM (\n\
                   SELECT j0.*, {guard_force} FROM (\n{joined_cte}\n) AS j0\n\
                 ) AS j\n\
                 WHERE j.{guard} IS NULL\n\
                 QUALIFY row_number() OVER (PARTITION BY j.{rid} ORDER BY j.{match_n} DESC) = 1",
                exclude.join(", "),
                out_exprs.join(", "),
            ))
        }
        WarehouseDialect::Postgres => {
            let Some(cols) = prev_columns else {
                return Err("ApplyKeyMap (postgres): prev_columns required".into());
            };
            let dest_folds: std::collections::HashSet<String> = dest_meta
                .iter()
                .map(|(d, _)| ascii_fold_name(d))
                .collect();
            let mut parts: Vec<String> = cols
                .iter()
                .filter(|c| !dest_folds.contains(&ascii_fold_name(c)))
                .map(|c| format!("j.{}", quote_ident(c)))
                .collect();
            parts.extend(out_exprs.clone());
            // WHERE on guard forces abort even if an outer query drops destinations.
            Ok(format!(
                "SELECT {selects}\nFROM (\n\
                   SELECT j0.*, {guard_force},\n\
                          row_number() OVER (PARTITION BY j0.{rid} ORDER BY j0.{match_n} DESC) AS {rn}\n\
                   FROM (\n{joined_cte}\n) AS j0\n\
                 ) AS j\nWHERE j.{rn} = 1 AND j.{guard} IS NULL",
                selects = parts.join(", "),
            ))
        }
    }
}

/// dbt seed file name / model id for a KeyMap (`map_<sanitized_id>`).
pub fn key_map_seed_name(map_id: &str) -> String {
    let s = crate::graph::sanitize_id(map_id);
    if s.starts_with("map_") {
        s
    } else {
        format!("map_{s}")
    }
}

/// CSV body for `seeds/map_*.csv` with configurable header names (default `from`,`to`).
pub fn key_map_seed_csv(entries: &[KeyMapEntry]) -> String {
    key_map_seed_csv_named(entries, "from", "to")
}

pub fn key_map_seed_csv_named(
    entries: &[KeyMapEntry],
    from_col: &str,
    to_col: &str,
) -> String {
    key_map_seed_csv_cols(entries, &[from_col.to_string()], to_col)
}

/// Seed CSV with N From columns + To ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
pub fn key_map_seed_csv_cols(
    entries: &[KeyMapEntry],
    from_cols: &[String],
    to_col: &str,
) -> String {
    key_map_seed_csv_full(entries, from_cols, to_col, &[])
}

/// Seed CSV including stewardship extras (attrs / SCD bounds) after To ([ADR-0028]).
pub fn key_map_seed_csv_full(
    entries: &[KeyMapEntry],
    from_cols: &[String],
    to_col: &str,
    extra_cols: &[String],
) -> String {
    key_map_seed_csv_outputs(entries, from_cols, &[to_col.to_string()], extra_cols)
}

/// Seed CSV: From columns, then one or more output columns, then stewardship ([ADR-0037]).
pub fn key_map_seed_csv_outputs(
    entries: &[KeyMapEntry],
    from_cols: &[String],
    output_cols: &[String],
    extra_cols: &[String],
) -> String {
    let mut wtr = csv::WriterBuilder::new()
        .flexible(true)
        .from_writer(vec![]);
    let mut header: Vec<&str> = from_cols.iter().map(|s| s.as_str()).collect();
    for c in output_cols {
        header.push(c.as_str());
    }
    for c in extra_cols {
        header.push(c.as_str());
    }
    wtr.write_record(&header).expect("csv header write");
    let n = from_cols.len().max(1);
    let out_n = output_cols.len().max(1);
    for e in entries {
        let parts = e.from_parts_eff();
        let outs = e.output_values_eff();
        let mut row: Vec<String> = (0..n)
            .map(|i| {
                parts
                    .get(i)
                    .map(|p| p.trim().to_string())
                    .unwrap_or_default()
            })
            .collect();
        for i in 0..out_n {
            row.push(outs.get(i).cloned().unwrap_or_default());
        }
        for c in extra_cols {
            row.push(e.attrs.get(c).cloned().unwrap_or_default());
        }
        wtr.write_record(&row).expect("csv row write");
    }
    let bytes = wtr.into_inner().expect("csv flush");
    String::from_utf8(bytes).expect("csv utf8")
}

/// How to treat the first CSV row when parsing a KeyMap seed.
#[derive(Debug, Clone, Copy)]
pub enum KeyMapCsvMode<'a> {
    /// First row is a header only when it matches `from_col`/`to_col`
    /// (case-insensitive). Otherwise every row is data — no content guessing.
    Header { from_col: &'a str, to_col: &'a str },
    /// No header row; columns are positional 0, 1.
    Headerless,
}

/// Header policy for multi-output / stewardship seed CSV ([ADR-0037]).
/// Do not mix: either require a named header row, or treat row 1 as data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedCsvHeaderPolicy {
    /// Seed sync / export: first row must name all declared fields; dup headers refused.
    RequireHeader,
    /// Explicit headerless import: first row is data; no header/dup checks.
    Headerless,
}

/// Parse KeyMap seed CSV via the `csv` crate (handles quoted newlines).
/// Default mode expects a `from`/`to` header when present; never guesses headers
/// from alphanumeric content (so `www,web` stays a data row).
pub fn parse_key_map_seed_csv(body: &str) -> Result<Vec<KeyMapEntry>, String> {
    parse_key_map_seed_csv_mode(
        body,
        KeyMapCsvMode::Header {
            from_col: "from",
            to_col: "to",
        },
    )
}

/// Parse with an explicit header mode and expected column names.
pub fn parse_key_map_seed_csv_mode(
    body: &str,
    mode: KeyMapCsvMode<'_>,
) -> Result<Vec<KeyMapEntry>, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(false)
        .from_reader(body.as_bytes());
    let mut records = rdr.records();
    let first = match records.next() {
        Some(Ok(r)) => r,
        Some(Err(e)) => return Err(format!("key map seed CSV: {e}")),
        None => return Ok(vec![]),
    };

    if first.len() < 2 {
        return Err("key map seed CSV: need at least two columns".into());
    }

    let (from_i, to_i, start_is_header) = match mode {
        KeyMapCsvMode::Headerless => (0usize, 1usize, false),
        KeyMapCsvMode::Header { from_col, to_col } => {
            let f0 = first.get(0).unwrap_or("").trim();
            let f1 = first.get(1).unwrap_or("").trim();
            let matches_expected = f0.eq_ignore_ascii_case(from_col)
                && f1.eq_ignore_ascii_case(to_col);
            // Common aliases only when expecting the default from/to names.
            let matches_alias = from_col.eq_ignore_ascii_case("from")
                && to_col.eq_ignore_ascii_case("to")
                && (f0.eq_ignore_ascii_case("from") || f0.eq_ignore_ascii_case("src"))
                && (f1.eq_ignore_ascii_case("to") || f1.eq_ignore_ascii_case("dst"));
            (0usize, 1usize, matches_expected || matches_alias)
        }
    };

    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_row = |rec: &csv::StringRecord, lineno: usize| -> Result<(), String> {
        let from = rec
            .get(from_i)
            .unwrap_or("")
            .trim()
            .to_string();
        let to = rec.get(to_i).unwrap_or("").to_string();
        if from.is_empty() && to.trim().is_empty() {
            return Ok(());
        }
        if from.is_empty() {
            return Err(format!("key map seed line {lineno}: empty from"));
        }
        if to.is_empty() {
            return Err(format!(
                "key map seed line {lineno}: empty to for from '{from}'"
            ));
        }
        if !seen.insert(from.clone()) {
            return Err(format!(
                "key map seed: duplicate from '{from}' (line {lineno})"
            ));
        }
        entries.push(KeyMapEntry::pair(from, to));
        Ok(())
    };

    let mut lineno = 1usize;
    if !start_is_header {
        push_row(&first, lineno)?;
    }
    for rec in records {
        lineno += 1;
        let rec = rec.map_err(|e| format!("key map seed line {lineno}: {e}"))?;
        push_row(&rec, lineno)?;
    }
    Ok(entries)
}

/// Parse composite seed: header = from_cols… + to_col ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
pub fn parse_key_map_seed_csv_cols(
    body: &str,
    from_cols: &[String],
    to_col: &str,
) -> Result<Vec<KeyMapEntry>, String> {
    parse_key_map_seed_csv_full(body, from_cols, to_col, &[])
}

/// Parse seed with optional stewardship columns after To ([ADR-0028]).
/// Requires a named header row (seed sync / export contract).
pub fn parse_key_map_seed_csv_full(
    body: &str,
    from_cols: &[String],
    to_col: &str,
    extra_cols: &[String],
) -> Result<Vec<KeyMapEntry>, String> {
    parse_key_map_seed_csv_outputs(body, from_cols, &[to_col.to_string()], extra_cols)
}

/// Parse seed with one or more output columns ([ADR-0037]). Seed sync contract:
/// named header required; all declared fields resolve by name.
pub fn parse_key_map_seed_csv_outputs(
    body: &str,
    from_cols: &[String],
    output_cols: &[String],
    extra_cols: &[String],
) -> Result<Vec<KeyMapEntry>, String> {
    parse_key_map_seed_csv_outputs_ex(
        body,
        from_cols,
        output_cols,
        extra_cols,
        SeedCsvHeaderPolicy::RequireHeader,
    )
}

/// Parse multi-output seed with an explicit header policy (no auto-guess).
pub fn parse_key_map_seed_csv_outputs_ex(
    body: &str,
    from_cols: &[String],
    output_cols: &[String],
    extra_cols: &[String],
    policy: SeedCsvHeaderPolicy,
) -> Result<Vec<KeyMapEntry>, String> {
    let n = from_cols.len();
    let out_n = output_cols.len();
    if n == 0 {
        return Err("parse_key_map_seed_csv_outputs: from_cols empty".into());
    }
    if out_n == 0 {
        return Err("parse_key_map_seed_csv_outputs: output_cols empty".into());
    }
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(false)
        .from_reader(body.as_bytes());
    let mut records = rdr.records();
    let first = match records.next() {
        Some(Ok(r)) => r,
        Some(Err(e)) => return Err(format!("key map seed CSV: {e}")),
        None => return Ok(vec![]),
    };
    if first.len() < n + out_n {
        return Err(format!(
            "key map seed CSV: need {} columns (from×{n} + outputs×{out_n})",
            n + out_n
        ));
    }

    let header_cells: Vec<String> = (0..first.len())
        .map(|i| first.get(i).unwrap_or("").trim().to_string())
        .collect();

    let find_idx = |want: &str| -> Option<usize> {
        header_cells
            .iter()
            .position(|h| h.eq_ignore_ascii_case(want.trim()))
    };

    let extras: Vec<String> = if !extra_cols.is_empty() {
        extra_cols.to_vec()
    } else if policy == SeedCsvHeaderPolicy::RequireHeader
        && from_cols.iter().all(|c| find_idx(c).is_some())
        && output_cols.iter().all(|c| find_idx(c).is_some())
        && header_cells.len() > n + out_n
    {
        // Trailing unnamed headers become attrs only under a recognized header row.
        let named: std::collections::HashSet<String> = from_cols
            .iter()
            .chain(output_cols.iter())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        header_cells
            .iter()
            .filter(|h| !h.is_empty() && !named.contains(&h.to_ascii_lowercase()))
            .cloned()
            .collect()
    } else {
        vec![]
    };

    let name_map: Vec<(String, usize)> = match policy {
        SeedCsvHeaderPolicy::RequireHeader => {
            // Resolve declared names first. Only then treat row 1 as a header
            // (dup check). Data rows like `A,A` must not be mistaken for headers.
            let mut out = Vec::with_capacity(n + out_n + extras.len());
            for c in from_cols.iter().chain(output_cols.iter()).chain(extras.iter()) {
                let i = find_idx(c).ok_or_else(|| {
                    format!("key map seed CSV: missing header for column '{c}'")
                })?;
                out.push((c.clone(), i));
            }
            let mut seen = std::collections::HashSet::new();
            for h in &header_cells {
                if h.is_empty() {
                    continue;
                }
                let k = h.to_ascii_lowercase();
                if !seen.insert(k) {
                    return Err(format!(
                        "key map seed CSV: duplicate header '{h}' (case-insensitive)"
                    ));
                }
            }
            out
        }
        SeedCsvHeaderPolicy::Headerless => Vec::new(),
    };

    let allow_dup_from = !extras.is_empty(); // SCD / attrs maps may repeat From
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let col_by_name = |rec: &csv::StringRecord, name: &str| -> String {
        if let Some((_, i)) = name_map.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            return rec.get(*i).unwrap_or("").to_string();
        }
        String::new()
    };

    let mut push_row = |rec: &csv::StringRecord, lineno: usize| -> Result<(), String> {
        let parts: Vec<String> = if name_map.is_empty() {
            (0..n)
                .map(|i| rec.get(i).unwrap_or("").trim().to_string())
                .collect()
        } else {
            from_cols
                .iter()
                .map(|c| col_by_name(rec, c).trim().to_string())
                .collect()
        };
        let outs: Vec<String> = if name_map.is_empty() {
            (0..out_n)
                .map(|i| rec.get(n + i).unwrap_or("").to_string())
                .collect()
        } else {
            output_cols
                .iter()
                .map(|c| col_by_name(rec, c))
                .collect()
        };
        if parts.iter().all(|p| p.is_empty()) && outs.iter().all(|o| o.trim().is_empty()) {
            return Ok(());
        }
        if parts.iter().any(|p| p.is_empty()) {
            return Err(format!("key map seed line {lineno}: empty from part"));
        }
        if outs.iter().any(|o| o.is_empty()) {
            return Err(format!(
                "key map seed line {lineno}: empty output for from {:?}",
                parts
            ));
        }
        if !allow_dup_from && !seen.insert(parts.clone()) {
            return Err(format!(
                "key map seed: duplicate from tuple {:?} (line {lineno})",
                parts
            ));
        }
        let mut entry = KeyMapEntry::parts_multi(parts, outs);
        for c in &extras {
            let v = if name_map.is_empty() {
                let base = n + out_n;
                let i = extras.iter().position(|x| x == c).unwrap_or(0);
                rec.get(base + i).unwrap_or("").to_string()
            } else {
                col_by_name(rec, c)
            };
            if !v.is_empty() {
                entry.attrs.insert(c.clone(), v);
            }
        }
        entries.push(entry);
        Ok(())
    };
    let mut lineno = 1usize;
    if policy == SeedCsvHeaderPolicy::Headerless {
        push_row(&first, lineno)?;
    }
    for rec in records {
        lineno += 1;
        let rec = rec.map_err(|e| format!("key map seed line {lineno}: {e}"))?;
        push_row(&rec, lineno)?;
    }
    Ok(entries)
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
    prev_columns: Option<&[String]>,
) -> Result<String, String> {
    if let Some(model) = parse_dbt_ref_model(right) {
        let skip = jinja_lower_name_list(right_on);
        let select =
            dbt_join_select_jinja(&model, &skip, left_dbt_relation, prev_columns);
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

/// Fold for DuckDB `UNION ALL BY NAME` matching: **ASCII** A–Z only (not Unicode case).
/// `"Имя"` and `"имя"` stay distinct; `"Amount"` / `"amount"` collide.
/// Portable RenameColumn projection when prior columns are known.
pub fn rename_select_list(cols: &[String], from: &str, to: &str) -> Result<String, String> {
    validate_unambiguous_ascii_names(cols, "RenameColumn")?;
    let fold_from = ascii_fold_name(from);
    let mut found = false;
    let mut parts = Vec::with_capacity(cols.len());
    for c in cols {
        if ascii_fold_name(c) == fold_from {
            if found {
                return Err(format!(
                    "RenameColumn: ambiguous match for '{from}' in {:?}",
                    cols
                ));
            }
            found = true;
            parts.push(format!("{} AS {}", quote_ident(c), quote_ident(to)));
        } else {
            parts.push(format!("{} AS {}", quote_ident(c), quote_ident(c)));
        }
    }
    if !found {
        return Err(format!(
            "RenameColumn: column '{from}' not in schema {:?}",
            cols
        ));
    }
    Ok(parts.join(", "))
}

pub fn ascii_fold_name(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// Reject schemas where two columns collide under [`ascii_fold_name`] (PG allows `"Amount"`+`"amount"`).
pub fn validate_unambiguous_ascii_names(cols: &[String], context: &str) -> Result<(), String> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    for c in cols {
        let key = ascii_fold_name(c);
        if let Some(prev) = seen.get(&key) {
            if *prev != c.as_str() {
                return Err(format!(
                    "{context}: ambiguous columns '{prev}' and '{c}' \
                     (ASCII case-insensitive collision; rename one before Append)"
                ));
            }
            return Err(format!("{context}: duplicate column name '{c}'"));
        }
        seen.insert(key, c.as_str());
    }
    Ok(())
}

/// Case-insensitive (ASCII) column union; first-seen spelling is the canonical result name.
/// Each source must pass [`validate_unambiguous_ascii_names`].
pub fn union_column_names(sources: &[&[String]]) -> Result<Vec<String>, String> {
    for (i, cols) in sources.iter().enumerate() {
        validate_unambiguous_ascii_names(cols, &format!("Append source[{i}]"))?;
    }
    let mut out = Vec::new();
    let mut seen_fold = std::collections::HashSet::new();
    for cols in sources {
        for c in *cols {
            if seen_fold.insert(ascii_fold_name(c)) {
                out.push(c.clone());
            }
        }
    }
    Ok(out)
}

/// Actual column name in `source_cols` matching `canonical` under [`ascii_fold_name`].
pub fn resolve_source_column<'a>(
    canonical: &str,
    source_cols: &'a [String],
) -> Result<Option<&'a str>, String> {
    validate_unambiguous_ascii_names(source_cols, "Append resolve")?;
    let want = ascii_fold_name(canonical);
    Ok(source_cols
        .iter()
        .find(|c| ascii_fold_name(c) == want)
        .map(|s| s.as_str()))
}

/// SELECT list aligning `source_cols` to `canonical` result names (BY NAME semantics).
/// Missing → `NULL AS "canonical"`; present → `"actual" AS "canonical"`.
pub fn select_list_aligned(
    canonical: &[String],
    source_cols: &[String],
) -> Result<String, String> {
    validate_unambiguous_ascii_names(source_cols, "Append select_list")?;
    let mut parts = Vec::with_capacity(canonical.len());
    for name in canonical {
        match resolve_source_column(name, source_cols)? {
            Some(actual) => parts.push(format!(
                "{} AS {}",
                quote_ident(actual),
                quote_ident(name)
            )),
            None => parts.push(format!("NULL AS {}", quote_ident(name))),
        }
    }
    Ok(parts.join(", "))
}

/// Portable `UNION ALL` with BY NAME semantics given known schemas (order / extras / ASCII case).
pub fn sql_union_all_aligned(
    left_from: &str,
    left_cols: &[String],
    rights: &[(String, Vec<String>)], // (from_sql, cols)
) -> Result<String, String> {
    let mut sources: Vec<&[String]> = vec![left_cols];
    for (_, cols) in rights {
        sources.push(cols.as_slice());
    }
    let canonical = union_column_names(&sources)?;
    let mut parts = vec![format!(
        "SELECT {} FROM {}",
        select_list_aligned(&canonical, left_cols)?,
        left_from
    )];
    for (from_sql, cols) in rights {
        parts.push(format!(
            "SELECT {} FROM {}",
            select_list_aligned(&canonical, cols)?,
            from_sql
        ));
    }
    Ok(parts.join("\nUNION ALL\n"))
}

/// Jinja expr: ASCII-only lower of `inner` (A–Z→a–z). Matches Rust [`ascii_fold_name`], not `| lower`.
fn jinja_ascii_fold(inner: &str) -> String {
    let mut expr = format!("({inner})");
    for upper in b'A'..=b'Z' {
        let u = upper as char;
        let l = (upper + 32) as char;
        expr = format!("({expr} | replace('{u}', '{l}'))");
    }
    expr
}

/// Build map ascii_fold→actual from relation; any repeated fold key → error (exact dup vs case clash).
fn jinja_build_col_map(rel_expr: &str, map_name: &str) -> String {
    let key = jinja_ascii_fold("_c.name");
    format!(
        "  {{% set {map_name} = {{}} %}}\n\
  {{% for _c in adapter.get_columns_in_relation({rel_expr}) %}}\n\
    {{% set _fk = {key} %}}\n\
    {{% if _fk in {map_name} %}}\n\
      {{% if {map_name}[_fk] != _c.name %}}\n\
        {{{{ exceptions.raise_compiler_error(\"Append: ambiguous columns '\" ~ {map_name}[_fk] ~ \"' and '\" ~ _c.name ~ \"' (ASCII case-insensitive collision; rename one)\") }}}}\n\
      {{% else %}}\n\
        {{{{ exceptions.raise_compiler_error(\"Append: duplicate column name '\" ~ _c.name ~ \"'\") }}}}\n\
      {{% endif %}}\n\
    {{% endif %}}\n\
    {{% if {map_name}.update({{ _fk: _c.name }}) %}}{{% endif %}}\n\
  {{% endfor %}}\n"
    )
}

/// Collect column into `_ns.names` / `_ns.fold` using ASCII fold; reject ambiguity within relation.
fn jinja_collect_canonical(rel_expr: &str) -> String {
    let key = jinja_ascii_fold("_c.name");
    format!(
        "  {{% for _c in adapter.get_columns_in_relation({rel_expr}) %}}\n\
    {{% set _fk = {key} %}}\n\
    {{% if _fk in _ns.fold %}}\n\
      {{% set _prev = _ns.names[_ns.fold.index(_fk)] %}}\n\
      {{% if _prev != _c.name %}}\n\
        {{{{ exceptions.raise_compiler_error(\"Append: ambiguous columns '\" ~ _prev ~ \"' and '\" ~ _c.name ~ \"' (ASCII case-insensitive collision; rename one)\") }}}}\n\
      {{% else %}}\n\
        {{{{ exceptions.raise_compiler_error(\"Append: duplicate column name '\" ~ _c.name ~ \"'\") }}}}\n\
      {{% endif %}}\n\
    {{% else %}}\n\
      {{% do _ns.names.append(_c.name) %}}\n\
      {{% do _ns.fold.append(_fk) %}}\n\
    {{% endif %}}\n\
  {{% endfor %}}\n"
    )
}

/// Jinja SELECT: for each canonical `_n`, use map actual or NULL (ASCII fold key).
fn jinja_select_aligned(map_name: &str, from_sql: &str) -> String {
    let key = jinja_ascii_fold("_n");
    format!(
        "SELECT {{% for _n in _ns.names %}}{{% set _k = {key} %}}{{% if _k in {map_name} %}}{{{{ adapter.quote({map_name}[_k]) }}}} AS {{{{ adapter.quote(_n) }}}}{{% else %}}NULL AS {{{{ adapter.quote(_n) }}}}{{% endif %}}{{% if not loop.last %}}, {{% endif %}}{{% endfor %}} FROM {from_sql}"
    )
}

/// Postgres / dbt stand-in for DuckDB `UNION ALL BY NAME` (ASCII fold policy).
fn dbt_append_union_by_name(prev: &str, left_dbt: &str, right_models: &[String]) -> String {
    let mut out = String::new();
    out.push_str("{% set _ns = namespace(names=[], fold=[]) %}\n");
    out.push_str(&format!("  {{% set _lrel = {left_dbt} %}}\n"));
    for (i, m) in right_models.iter().enumerate() {
        out.push_str(&format!("  {{% set _r{i} = ref('{m}') %}}\n"));
    }

    // Per-relation ambiguity is checked while building maps; cross-source merge is ASCII fold.
    out.push_str(&jinja_collect_canonical("_lrel"));
    for i in 0..right_models.len() {
        // Across sources: only append if fold key unseen (Amount on left + amount on right → one col).
        let key = jinja_ascii_fold("_c.name");
        out.push_str(&format!(
            "  {{% for _c in adapter.get_columns_in_relation(_r{i}) %}}\n\
    {{% set _fk = {key} %}}\n\
    {{% if _fk not in _ns.fold %}}\n\
      {{% do _ns.names.append(_c.name) %}}\n\
      {{% do _ns.fold.append(_fk) %}}\n\
    {{% endif %}}\n\
  {{% endfor %}}\n"
        ));
    }

    out.push_str(&jinja_build_col_map("_lrel", "_lmap"));
    for i in 0..right_models.len() {
        out.push_str(&jinja_build_col_map(&format!("_r{i}"), &format!("_rmap{i}")));
    }

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
/// Prefer live left relation, else known `prev_columns` (CTE after Rename/KeyMap), else
/// prefix right cols `{model}__` (safe when schema unknown).
fn dbt_join_select_jinja(
    model: &str,
    skip_lower_list: &str,
    left_dbt_relation: Option<&str>,
    prev_columns: Option<&[String]>,
) -> String {
    if let Some(left) = left_dbt_relation {
        return format!(
            "{{% set _jrel = ref('{model}') %}}\n  {{% set _lrel = {left} %}}\n  {{% set _left_names = adapter.get_columns_in_relation(_lrel) | map(attribute='name') | map('lower') | list %}}\n  SELECT\n    l.*{{% for _c in adapter.get_columns_in_relation(_jrel) if (_c.name | lower) not in [{skip_lower_list}] and (_c.name | lower) not in _left_names %}}, r.{{{{ adapter.quote(_c.name) }}}}{{% endfor %}}"
        );
    }
    if let Some(cols) = prev_columns.filter(|c| !c.is_empty()) {
        let left_list = jinja_lower_name_list(cols);
        return format!(
            "{{% set _jrel = ref('{model}') %}}\n  {{% set _left_names = [{left_list}] %}}\n  SELECT\n    l.*{{% for _c in adapter.get_columns_in_relation(_jrel) if (_c.name | lower) not in [{skip_lower_list}] and (_c.name | lower) not in _left_names %}}, r.{{{{ adapter.quote(_c.name) }}}}{{% endfor %}}"
        );
    }
    format!(
        "{{% set _jrel = ref('{model}') %}}\n  SELECT\n    l.*{{% for _c in adapter.get_columns_in_relation(_jrel) if (_c.name | lower) not in [{skip_lower_list}] %}}, r.{{{{ adapter.quote(_c.name) }}}} AS {{{{ adapter.quote('{model}__' ~ _c.name) }}}}{{% endfor %}}"
    )
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
            EmitSchemaOpts {
                left_dbt_relation: Some("source('sys', 'data_extraction_sources')"),
                ..Default::default()
            },
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
    fn join_equal_keys_uses_prev_columns_without_prefix() {
        let mut rel = HashMap::new();
        rel.insert("dim".into(), "{{ ref('stg_dim_company') }}".into());
        let join = TransformationStep::Join {
            right_query_id: "dim".into(),
            join_type: JoinType::Left,
            left_on: vec!["company_id".into()],
            right_on: vec!["company_id".into()],
        };
        let prev_cols = vec![
            "day".into(),
            "company_id".into(),
            "units".into(),
            "revenue".into(),
        ];
        let sql = emit_transform_step_ex(
            &join,
            "s2",
            &rel,
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                prev_columns: Some(&prev_cols),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(sql.contains("_left_names = ['day', 'company_id', 'units', 'revenue']"));
        assert!(
            !sql.contains("__' ~ _c.name"),
            "must not prefix when schema known: {sql}"
        );
        assert!(sql.contains("not in _left_names"));
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
        let names = union_column_names(&[&left, &right]).unwrap();
        assert_eq!(names, vec!["id", "Amount", "currency"]);
    }

    #[test]
    fn union_names_non_ascii_case_stays_distinct() {
        // DuckDB BY NAME: "Имя" and "имя" are different columns (not ASCII A–Z).
        let left = vec!["Имя".into()];
        let right = vec!["имя".into()];
        let names = union_column_names(&[&left, &right]).unwrap();
        assert_eq!(names, vec!["Имя", "имя"]);
        // ASCII fold leaves Cyrillic unchanged → distinct keys (unlike Jinja `| lower`).
        assert_eq!(ascii_fold_name("Имя"), "Имя");
        assert_eq!(ascii_fold_name("имя"), "имя");
        assert_ne!(ascii_fold_name("Имя"), ascii_fold_name("имя"));
    }

    #[test]
    fn ambiguous_ascii_names_rejected() {
        let cols = vec!["Amount".into(), "amount".into()];
        let err = validate_unambiguous_ascii_names(&cols, "test").unwrap_err();
        assert!(err.contains("ambiguous"));
        assert!(err.contains("Amount"));
        assert!(err.contains("amount"));
        assert!(union_column_names(&[&cols]).is_err());
        assert!(select_list_aligned(&["Amount".into()], &cols).is_err());
    }

    #[test]
    fn select_list_right_only_null_on_left() {
        let canonical = vec!["id".into(), "amount".into(), "currency".into()];
        let left = vec!["id".into(), "amount".into()];
        let sql = select_list_aligned(&canonical, &left).unwrap();
        assert_eq!(
            sql,
            "\"id\" AS \"id\", \"amount\" AS \"amount\", NULL AS \"currency\""
        );
    }

    #[test]
    fn select_list_left_only_null_on_right() {
        let canonical = vec!["id".into(), "amount".into(), "region".into()];
        let right = vec!["id".into(), "amount".into()];
        let sql = select_list_aligned(&canonical, &right).unwrap();
        assert!(sql.ends_with("NULL AS \"region\""));
        assert!(!sql.contains("\"region\" AS \"region\""));
    }

    #[test]
    fn select_list_case_uses_actual_source_name() {
        let canonical = vec!["Amount".into()]; // left spelling wins
        let right = vec!["amount".into()];
        let sql = select_list_aligned(&canonical, &right).unwrap();
        // Must quote the *right* physical name, alias to canonical.
        assert_eq!(sql, "\"amount\" AS \"Amount\"");
        assert_ne!(sql, "\"Amount\" AS \"Amount\"");
    }

    #[test]
    fn select_list_reorder_same_names() {
        let canonical = vec!["id".into(), "amount".into(), "region".into()];
        let right = vec!["region".into(), "id".into(), "amount".into()];
        assert_eq!(
            select_list_aligned(&canonical, &right).unwrap(),
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
        )
        .unwrap();
        let (left_sel, right_sel) = sql.split_once("\nUNION ALL\n").unwrap();
        assert!(left_sel.contains("NULL AS \"currency\""));
        assert!(left_sel.contains("\"Amount\" AS \"Amount\""));
        assert!(right_sel.contains("\"amount\" AS \"Amount\""));
        assert!(right_sel.contains("\"currency\" AS \"currency\""));
        assert!(!right_sel.contains("\"Amount\" AS \"Amount\""));
    }

    #[test]
    fn append_postgres_jinja_uses_ascii_fold_not_unicode_lower() {
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
            EmitSchemaOpts {
                left_dbt_relation: Some("ref('stg_sales_eu')"),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!sql.contains("UNION ALL SELECT *"));
        assert!(sql.contains("_lmap"));
        assert!(sql.contains("_rmap0"));
        assert_eq!(sql.matches("NULL AS {{ adapter.quote(_n) }}").count(), 2);
        // Must not use Unicode `| lower` for fold keys (would merge Имя/имя).
        assert!(
            !sql.contains("| lower") && !sql.contains("|lower"),
            "Append jinja must use ASCII replace-fold, not | lower: {sql}"
        );
        assert!(sql.contains("| replace('A', 'a')"));
        assert!(sql.contains("raise_compiler_error"));
        assert!(sql.contains("ambiguous columns"));
        // Exact dup ["id","id"] must error on every source map (left + right), not only left collect.
        assert!(sql.contains("duplicate column name"));
        assert_eq!(
            sql.matches("duplicate column name").count(),
            3, // left collect + _lmap + _rmap0
            "exact-duplicate check must cover left collect and each source map"
        );
    }

    #[test]
    fn duplicate_exact_name_rejected_in_rust() {
        let cols = vec!["id".into(), "id".into()];
        let err = validate_unambiguous_ascii_names(&cols, "test").unwrap_err();
        assert!(err.contains("duplicate column name 'id'"));
        assert!(!err.contains("ambiguous"));
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
            EmitSchemaOpts {
                left_dbt_relation: Some("ref('stg_sales')"),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!sql.contains("EXCLUDE"));
        assert!(sql.contains("ref('stg_sales')"));
        assert!(sql.contains("AS \"amount\""));
        assert!(sql.contains("'amt'"));
    }

    #[test]
    fn rename_and_append_postgres_use_schema_not_jinja() {
        let mut rel = HashMap::new();
        rel.insert("us".into(), "{{ ref('stg_us') }}".into());
        let mut qcols = HashMap::new();
        qcols.insert(
            "us".into(),
            vec!["id".into(), "amount".into(), "currency".into()],
        );
        let before_rename = vec!["id".into(), "amt".into()];
        let after_rename = vec!["id".into(), "amount".into()];

        let ren = emit_transform_step_ex(
            &TransformationStep::RenameColumn {
                from: "amt".into(),
                to: "amount".into(),
            },
            "s0",
            &rel,
            WarehouseDialect::Postgres,
            EmitSchemaOpts {
                prev_columns: Some(&before_rename),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!ren.contains("EXCLUDE"));
        assert!(!ren.contains("get_columns_in_relation"));
        assert!(ren.contains("\"amt\" AS \"amount\""));

        let app = emit_transform_step_ex(
            &TransformationStep::Append {
                other_query_ids: vec!["us".into()],
            },
            "s1",
            &rel,
            WarehouseDialect::Postgres,
            EmitSchemaOpts {
                prev_columns: Some(&after_rename),
                query_columns: Some(&qcols),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!app.contains("_lmap"));
        assert!(app.contains("NULL AS \"currency\""));
        assert!(app.contains("{{ ref('stg_us') }}"));
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

    #[test]
    fn normalize_key_duckdb_overwrite() {
        let step = TransformationStep::NormalizeKey {
            columns: vec!["region".into()],
            ops: vec![NormalizeOp::Trim, NormalizeOp::Lower],
        };
        let sql = emit_transform_step(&step, "s0", &HashMap::new(), WarehouseDialect::Duckdb)
            .unwrap();
        assert!(sql.contains("EXCLUDE"));
        assert!(
            sql.contains("CAST(\"region\" AS VARCHAR)")
                || sql.contains("cast(\"region\" as varchar)"),
            "NormalizeKey must cast before trim/lower: {sql}"
        );
        assert!(sql.contains("trim(lower(") || sql.contains("lower(trim("));
        assert!(sql.contains("\"region\""));
    }

    #[test]
    fn apply_key_map_multi_output_bindings() {
        use crate::model::{ApplyKeyMapOutputBinding, KeyMapEntry};
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![
                ApplyKeyMapOutputBinding {
                    map_column: "product_id".into(),
                    destination_column: "mapped_product_id".into(),
                },
                ApplyKeyMapOutputBinding {
                    map_column: "variant_code".into(),
                    destination_column: "mapped_variant".into(),
                },
            ],
            as_of_column: None,
            map_id: "sku_map".into(),
            entries: vec![KeyMapEntry::parts_multi(
                vec!["X1".into()],
                vec!["P1".into(), "V1".into()],
            )],
        };
        let mut cols = HashMap::new();
        cols.insert(
            "sku_map".into(),
            (
                vec!["from".into()],
                vec!["product_id".into(), "variant_code".into()],
            ),
        );
        let prev = vec!["sku".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(sql.contains("mapped_product_id"), "{sql}");
        assert!(sql.contains("mapped_variant"), "{sql}");
        assert!(sql.contains("_dwh_mo_0") && sql.contains("_dwh_mo_1"), "{sql}");
        assert!(sql.contains("_dwh_match_n"), "{sql}");
        assert!(sql.contains("_dwh_apply_guard"), "{sql}");
        assert!(sql.contains("error('KeyMap sku_map: ambiguous"), "{sql}");
    }

    #[test]
    fn apply_key_map_same_named_fact_and_map_outputs() {
        use crate::model::{ApplyKeyMapOutputBinding, KeyMapEntry};
        // Fact already has product_id=OLD; map overwrites with NEW via same name.
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![
                ApplyKeyMapOutputBinding {
                    map_column: "product_id".into(),
                    destination_column: "product_id".into(),
                },
                ApplyKeyMapOutputBinding {
                    map_column: "variant_code".into(),
                    destination_column: "variant_code".into(),
                },
            ],
            as_of_column: None,
            map_id: "sku_map".into(),
            entries: vec![KeyMapEntry::parts_multi(
                vec!["X1".into()],
                vec!["NEW".into(), "BLUE-M".into()],
            )],
        };
        let mut cols = HashMap::new();
        cols.insert(
            "sku_map".into(),
            (
                vec!["sku".into()],
                vec!["product_id".into(), "variant_code".into()],
            ),
        );
        let prev = vec!["sku".into(), "product_id".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                key_map_relations: Some(&{
                    let mut r = HashMap::new();
                    r.insert("sku_map".into(), "map_sku".into());
                    r
                }),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        // Map side must use internal aliases — never `m."product_id" AS "product_id"`.
        assert!(
            !sql.contains("m.\"product_id\" AS \"product_id\""),
            "must not project map cols under fact names: {sql}"
        );
        assert!(sql.contains("_dwh_mo_0") && sql.contains("_dwh_mf_0"), "{sql}");
        assert!(
            sql.contains("CAST(j._dwh_mo_0 AS VARCHAR)"),
            "overwrite must read map alias: {sql}"
        );
        // Miss path must keep fact product_id (j."product_id"), not the map alias.
        assert!(
            sql.contains("WHEN j._dwh_mf_0 IS NULL THEN CAST(j.\"product_id\" AS VARCHAR)"),
            "miss must preserve fact column: {sql}"
        );
    }

    #[test]
    fn apply_key_map_values_join() {
        use crate::model::KeyMapEntry;
        let step = TransformationStep::ApplyKeyMap {
            column: "channel".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![],
            as_of_column: None,
            map_id: "ch".into(),
            entries: vec![KeyMapEntry {
                from: "web".into(),
                from_parts: vec!["web".into()],
                to: "online".into(),
                ..Default::default()
            }],
        };
        let prev = vec!["channel".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(sql.contains("VALUES"));
        assert!(sql.contains("LEFT JOIN"));
        assert!(sql.contains("_dwh_match_n"));
        assert!(sql.contains("web"));
        assert!(sql.contains("online"));
    }

    #[test]
    fn apply_key_map_composite_values_join() {
        use crate::model::KeyMapEntry;
        let step = TransformationStep::ApplyKeyMap {
            column: String::new(),
            columns: vec!["ext_id".into(), "day".into()],
            output_column: Some("ext_id".into()),
            output_bindings: vec![],
            as_of_column: None,
            map_id: "offers".into(),
            entries: vec![KeyMapEntry::parts(
                vec!["OFF-42".into(), "2024-06-01".into()],
                "OFF-COKE",
            )],
        };
        let mut cols = HashMap::new();
        cols.insert(
            "offers".into(),
            (vec!["ext_id".into(), "day".into()], vec!["offer_sk".into()]),
        );
        let prev = vec!["ext_id".into(), "day".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(sql.contains("_dwh_mf_0") && sql.contains("_dwh_mf_1"), "{sql}");
        assert!(sql.contains("AND"), "{sql}");
        assert!(sql.contains("OFF-42") && sql.contains("2024-06-01"), "{sql}");
        assert!(sql.contains("EXCLUDE"), "{sql}");
    }

    #[test]
    fn apply_key_map_existing_output_not_in_from_uses_exclude() {
        use crate::model::KeyMapEntry;
        // output_column exists on prev but is not a From fact col → overwrite, not duplicate.
        let step = TransformationStep::ApplyKeyMap {
            column: "ext".into(),
            columns: vec!["ext".into()],
            output_column: Some("canonical".into()),
            output_bindings: vec![],
            as_of_column: None,
            map_id: "m".into(),
            entries: vec![KeyMapEntry::pair("OLD", "NEW")],
        };
        let prev_cols = vec!["ext".into(), "canonical".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                prev_columns: Some(&prev_cols),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            sql.contains("EXCLUDE") && sql.contains("\"canonical\""),
            "must overwrite existing canonical: {sql}"
        );
        assert!(
            !sql.contains("t.*,"),
            "must not append duplicate: {sql}"
        );
    }

    #[test]
    fn apply_key_map_new_output_column_no_exclude() {
        use crate::model::KeyMapEntry;
        // ADR-0024: output_column not on the fact → add column, do not EXCLUDE.
        let step = TransformationStep::ApplyKeyMap {
            column: String::new(),
            columns: vec!["ext_offer_id".into(), "day".into()],
            output_column: Some("offer_sk".into()),
            output_bindings: vec![],
            as_of_column: None,
            map_id: "offers".into(),
            entries: vec![KeyMapEntry::parts(
                vec!["OF-100".into(), "2024-06-01".into()],
                "SK-SUMMER-A",
            )],
        };
        let mut cols = HashMap::new();
        cols.insert(
            "offers".into(),
            (
                vec!["ext_offer_id".into(), "as_of_day".into()],
                vec!["offer_sk".into()],
            ),
        );
        let prev_cols = vec!["ext_offer_id".into(), "day".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                prev_columns: Some(&prev_cols),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            !sql.contains("EXCLUDE (\"offer_sk\"")
                && !sql.contains("EXCLUDE (_dwh_rid, _dwh_match_n, \"offer_sk\""),
            "new output must not be in EXCLUDE overwrite list: {sql}"
        );
        assert!(sql.contains("AS \"offer_sk\""), "{sql}");
        assert!(sql.contains("SK-SUMMER-A"), "{sql}");
        assert!(sql.contains("_dwh_match_n"), "{sql}");
    }

    #[test]
    fn apply_key_map_unknown_schema_refuses_alias_allocation() {
        use crate::model::KeyMapEntry;
        // Even overwrite of a fact column is unsafe without the full prior schema:
        // unknown inputs may already use `_dwh_*` and collide under SELECT *.
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec!["sku".into()],
            output_column: Some("sku".into()),
            output_bindings: vec![],
            as_of_column: None,
            map_id: "m".into(),
            entries: vec![KeyMapEntry::pair("OLD", "NEW")],
        };
        let err = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts::default(),
        )
        .unwrap_err();
        assert!(
            err.contains("prev_columns required"),
            "must refuse unknown schema for SELECT * aliases: {err}"
        );
    }

    #[test]
    fn headerless_csv_keeps_all_rows() {
        use crate::model::KeyMapEntry;
        let body = "www,web\nshop,store\n";
        let rows = parse_key_map_seed_csv(body).unwrap();
        assert_eq!(rows.len(), 2, "must not treat www,web as a header");
        assert_eq!(
            rows,
            vec![
                KeyMapEntry::pair("www", "web"),
                KeyMapEntry::pair("shop", "store"),
            ]
        );
        let explicit = parse_key_map_seed_csv_mode(body, KeyMapCsvMode::Headerless).unwrap();
        assert_eq!(explicit.len(), 2);
    }

    #[test]
    fn header_csv_skips_from_to_row() {
        let rows = parse_key_map_seed_csv("from,to\n001,online\n").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].from, "001");
        assert_eq!(rows[0].to, "online");
    }

    #[test]
    fn custom_header_names_only_when_matching() {
        let rows = parse_key_map_seed_csv_mode(
            "src_code,dst_code\n001,online\n",
            KeyMapCsvMode::Header {
                from_col: "src_code",
                to_col: "dst_code",
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].from, "001");
    }

    #[test]
    fn seed_csv_attrs_roundtrip() {
        use crate::model::KeyMapEntry;
        let mut e = KeyMapEntry::pair("A", "B");
        e.attrs.insert("reason".into(), "merge".into());
        let body = key_map_seed_csv_full(
            &[e],
            &["from".into()],
            "to",
            &["reason".into()],
        );
        assert!(body.contains("reason"), "{body}");
        let back = parse_key_map_seed_csv_full(
            &body,
            &["from".into()],
            "to",
            &["reason".into()],
        )
        .unwrap();
        assert_eq!(back[0].attrs.get("reason").map(String::as_str), Some("merge"));
    }

    #[test]
    fn apply_key_map_range_scd_half_open() {
        use crate::model::KeyMapEntry;
        let mut e = KeyMapEntry::pair("sku1", "item1");
        e.attrs.insert("valid_from".into(), "2024-01-01".into());
        e.attrs.insert("valid_to".into(), "2024-06-01".into());
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![],
            as_of_column: Some("event_day".into()),
            map_id: "scd".into(),
            entries: vec![e],
        };
        let mut range = HashMap::new();
        range.insert("scd".into(), ("valid_from".into(), "valid_to".into()));
        let prev = vec!["sku".into(), "event_day".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_range: Some(&range),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            sql.contains("_dwh_mvf") && sql.contains("event_day"),
            "{sql}"
        );
        assert!(
            sql.contains(
                "CAST(t0.\"event_day\" AS TIMESTAMP) >= CAST(m._dwh_mvf AS TIMESTAMP)"
            ) && sql.contains("_dwh_mvt IS NULL OR")
                && sql.contains(
                    "CAST(t0.\"event_day\" AS TIMESTAMP) < CAST(m._dwh_mvt AS TIMESTAMP)"
                ),
            "half-open TIMESTAMP predicate: {sql}"
        );
    }

    #[test]
    fn parse_seed_csv_reorder_attrs_and_outputs_by_name() {
        let body = "\
external_sku,note,product_id,variant_code,valid_from,valid_to\n\
X1,reviewed,P100,BLUE-M,2024-01-01,2024-06-01\n";
        let entries = parse_key_map_seed_csv_outputs(
            body,
            &["external_sku".into()],
            &["product_id".into(), "variant_code".into()],
            &["note".into(), "valid_from".into(), "valid_to".into()],
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].output_values_eff(),
            vec!["P100".to_string(), "BLUE-M".to_string()]
        );
        assert_eq!(entries[0].attrs.get("note").map(String::as_str), Some("reviewed"));
        assert_eq!(
            entries[0].attrs.get("valid_from").map(String::as_str),
            Some("2024-01-01")
        );
        assert_eq!(
            entries[0].attrs.get("valid_to").map(String::as_str),
            Some("2024-06-01")
        );
    }

    #[test]
    fn parse_seed_csv_rejects_duplicate_headers() {
        let err = parse_key_map_seed_csv_outputs(
            "a,A,to\n1,2,3\n",
            &["a".into()],
            &["to".into()],
            &[],
        )
        .unwrap_err();
        assert!(err.contains("duplicate header"), "{err}");
    }

    #[test]
    fn parse_seed_csv_headerless_allows_duplicate_data_cells() {
        // Row 1 is data (A→A), not a header — must not trip duplicate-header.
        let entries = parse_key_map_seed_csv_outputs_ex(
            "A,A\nB,C\n",
            &["from".into()],
            &["to".into()],
            &[],
            SeedCsvHeaderPolicy::Headerless,
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].from, "A");
        assert_eq!(entries[0].to, "A");
        assert_eq!(entries[1].from, "B");
        assert_eq!(entries[1].to, "C");
    }

    #[test]
    fn parse_seed_csv_require_header_refuses_missing_columns() {
        let err = parse_key_map_seed_csv_outputs(
            "A,A\nB,C\n",
            &["from".into()],
            &["to".into()],
            &[],
        )
        .unwrap_err();
        assert!(
            err.contains("missing header"),
            "RequireHeader must not fall back to positional data: {err}"
        );
    }

    #[test]
    fn apply_key_map_internal_aliases_avoid_prev_collision() {
        use crate::model::{ApplyKeyMapOutputBinding, KeyMapEntry};
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![ApplyKeyMapOutputBinding {
                map_column: "product_id".into(),
                destination_column: "product_id".into(),
            }],
            as_of_column: None,
            map_id: "m".into(),
            entries: vec![KeyMapEntry::pair("X1", "NEW")],
        };
        let mut cols = HashMap::new();
        cols.insert(
            "m".into(),
            (vec!["sku".into()], vec!["product_id".into()]),
        );
        // Fact already has our preferred internal names — allocator must suffix.
        let prev = vec![
            "sku".into(),
            "product_id".into(),
            "_dwh_rid".into(),
            "_dwh_mo_0".into(),
            "_dwh_apply_guard".into(),
        ];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            sql.contains("_dwh_rid_1") || sql.contains("AS _dwh_rid_1"),
            "rid must be reallocated: {sql}"
        );
        assert!(
            sql.contains("_dwh_mo_0_1") || sql.contains("_dwh_mo_1"),
            "map out alias must avoid prev _dwh_mo_0: {sql}"
        );
        assert!(
            !sql.contains("EXCLUDE (_dwh_rid,"),
            "must not EXCLUDE the user's _dwh_rid column name alone: {sql}"
        );
    }

    #[test]
    fn apply_key_map_postgres_abort_not_constant_div_zero() {
        use crate::model::KeyMapEntry;
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![],
            as_of_column: None,
            map_id: "m".into(),
            entries: vec![KeyMapEntry::pair("a", "b")],
        };
        let prev = vec!["sku".into()];
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Postgres,
            EmitSchemaOpts {
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            !sql.contains("(1 / 0)") && !sql.contains("1 / 0"),
            "must not use plan-time constant 1/0: {sql}"
        );
        assert!(
            sql.contains("SELECT 0 WHERE") && sql.contains("_dwh_apply_guard"),
            "runtime abort + forced guard: {sql}"
        );
    }

    #[test]
    fn apply_key_map_range_requires_as_of() {
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec![],
            output_column: None,
            output_bindings: vec![],
            as_of_column: None,
            map_id: "scd".into(),
            entries: vec![],
        };
        let mut range = HashMap::new();
        range.insert("scd".into(), ("valid_from".into(), "valid_to".into()));
        let err = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Duckdb,
            EmitSchemaOpts {
                key_map_range: Some(&range),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("as_of_column"), "{err}");
    }
}
