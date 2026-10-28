//! Shared step → SQL emit (ADR-0015). Transform steps are dialect-aware once;
//! Load / FromQuery / SqlModel adapters stay mode-specific at call sites.

use crate::dialect::{sql_rename_column, WarehouseDialect};
use crate::graph::direct_deps;
use crate::model::{JoinType, KeyMapEntry, NormalizeOp, TransformationStep};
use crate::sql_escape::{escape_sql_string, quote_ident};
use std::collections::HashMap;

fn require_prev(prev: &str, op: &str) -> Result<(), String> {
    if prev.is_empty() {
        Err(format!("{op} требует предыдущий шаг в той же query"))
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
            // Portable BY NAME when step schemas are known (ADR-0018) — both dialects.
            if let (Some(left_cols), Some(qcols)) = (opts.prev_columns, opts.query_columns) {
                let mut rights = Vec::with_capacity(other_query_ids.len());
                let mut all_known = true;
                for oid in other_query_ids {
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
            map_id,
            entries,
        } => {
            require_prev(prev, "ApplyKeyMap")?;
            if column.trim().is_empty() {
                return Err("ApplyKeyMap: column must be non-empty".into());
            }
            if map_id.trim().is_empty() {
                return Err("ApplyKeyMap: map_id must be non-empty".into());
            }
            let seed_rel = opts
                .key_map_relations
                .and_then(|m| m.get(map_id).map(|s| s.as_str()));
            emit_apply_key_map(
                dialect,
                prev,
                column,
                entries,
                seed_rel,
                opts.prev_columns,
            )
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

/// Nest normalize ops around a column SQL expression (e.g. `"region"` → `trim(lower("region"))`).
pub fn normalize_column_expr(col_sql: &str, ops: &[NormalizeOp]) -> String {
    normalize_expr(col_sql, ops)
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
            (c.clone(), normalize_expr(&q, ops))
        })
        .collect();
    emit_overwrite_columns(dialect, prev, &overwrites, prev_columns)
}

fn emit_apply_key_map(
    dialect: WarehouseDialect,
    prev: &str,
    column: &str,
    entries: &[KeyMapEntry],
    seed_relation: Option<&str>,
    prev_columns: Option<&[String]>,
) -> Result<String, String> {
    let qcol = quote_ident(column);
    let map_sql = if let Some(rel) = seed_relation {
        format!("{rel} AS m")
    } else if entries.is_empty() {
        // No-op remap (identity) — still valid after empty map create.
        return emit_overwrite_columns(
            dialect,
            prev,
            &[(column.to_string(), format!("CAST({qcol} AS VARCHAR)"))],
            prev_columns,
        );
    } else {
        let values = entries
            .iter()
            .map(|e| {
                format!(
                    "('{}', '{}')",
                    escape_sql_string(e.from.trim()),
                    escape_sql_string(&e.to)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("(VALUES {values}) AS m(from_val, to_val)")
    };

    let join_on = if seed_relation.is_some() {
        format!("CAST(t.{qcol} AS VARCHAR) = CAST(m.\"from\" AS VARCHAR)")
    } else {
        format!("CAST(t.{qcol} AS VARCHAR) = m.from_val")
    };
    let coalesce = if seed_relation.is_some() {
        format!("COALESCE(m.\"to\", CAST(t.{qcol} AS VARCHAR))")
    } else {
        format!("COALESCE(m.to_val, CAST(t.{qcol} AS VARCHAR))")
    };

    match dialect {
        WarehouseDialect::Duckdb => Ok(format!(
            "SELECT t.* EXCLUDE ({qcol}), {coalesce} AS {qcol}\n  FROM {prev} AS t\n  LEFT JOIN {map_sql} ON {join_on}"
        )),
        WarehouseDialect::Postgres => {
            let Some(cols) = prev_columns else {
                return Err("ApplyKeyMap (postgres): prev_columns required".into());
            };
            let fold = ascii_fold_name(column);
            let parts: Vec<String> = cols
                .iter()
                .map(|c| {
                    if ascii_fold_name(c) == fold {
                        format!("{coalesce} AS {qcol}")
                    } else {
                        format!("t.{}", quote_ident(c))
                    }
                })
                .collect();
            Ok(format!(
                "SELECT {}\n  FROM {prev} AS t\n  LEFT JOIN {map_sql} ON {join_on}",
                parts.join(", ")
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

/// CSV body for `seeds/map_*.csv` (`from,to` header).
pub fn key_map_seed_csv(entries: &[KeyMapEntry]) -> String {
    let mut out = String::from("from,to\n");
    for e in entries {
        out.push_str(&csv_escape_field(e.from.trim()));
        out.push(',');
        out.push_str(&csv_escape_field(&e.to));
        out.push('\n');
    }
    out
}

/// Parse `from,to` seed CSV (header optional). Skips blank lines.
pub fn parse_key_map_seed_csv(body: &str) -> Result<Vec<KeyMapEntry>, String> {
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (lineno, raw) in body.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if lineno == 0 && line.eq_ignore_ascii_case("from,to") {
            continue;
        }
        let (from, to) = split_csv_two(line).ok_or_else(|| {
            format!("key map seed line {}: expected from,to (got '{line}')", lineno + 1)
        })?;
        let from = from.trim().to_string();
        if from.is_empty() {
            return Err(format!("key map seed line {}: empty from", lineno + 1));
        }
        if to.is_empty() {
            return Err(format!(
                "key map seed line {}: empty to for from '{from}'",
                lineno + 1
            ));
        }
        if !seen.insert(from.clone()) {
            return Err(format!(
                "key map seed: duplicate from '{from}' (line {})",
                lineno + 1
            ));
        }
        entries.push(KeyMapEntry { from, to });
    }
    Ok(entries)
}

fn split_csv_two(line: &str) -> Option<(String, String)> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    fields.push(cur);
    if fields.len() < 2 {
        return None;
    }
    let from = fields[0].trim().to_string();
    let to = fields[1..].join(",").trim().to_string();
    Some((from, to))
}

fn csv_escape_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
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
        assert!(sql.contains("trim(lower(") || sql.contains("lower(trim("));
        assert!(sql.contains("\"region\""));
    }

    #[test]
    fn apply_key_map_values_join() {
        use crate::model::KeyMapEntry;
        let step = TransformationStep::ApplyKeyMap {
            column: "channel".into(),
            map_id: "ch".into(),
            entries: vec![KeyMapEntry {
                from: "web".into(),
                to: "online".into(),
            }],
        };
        let sql = emit_transform_step(&step, "s0", &HashMap::new(), WarehouseDialect::Duckdb)
            .unwrap();
        assert!(sql.contains("VALUES"));
        assert!(sql.contains("COALESCE"));
        assert!(sql.contains("web"));
        assert!(sql.contains("online"));
    }
}
