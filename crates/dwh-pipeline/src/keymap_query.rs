//! Query-backed KeyMap helpers ([ADR-0036](../../../docs/adr/0036-query-backed-keymap.md)).

use crate::graph::{direct_deps_ex, reachable_from};
use crate::model::{KeyMapDef, KeyMapStorage, TransformationStep, Workspace};
use crate::sql_escape::{escape_sql_string, quote_ident};
use std::collections::{HashMap, HashSet};

/// Local query id when `storage = query`.
pub fn query_backed_query_id(map: &KeyMapDef) -> Option<&str> {
    match &map.storage {
        KeyMapStorage::Query { query_id } => {
            let t = query_id.trim();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        _ => None,
    }
}

/// Validate From/To column binding against a described schema (column names).
pub fn validate_query_map_binding(
    map: &KeyMapDef,
    workspace: &Workspace,
    schema_columns: &[String],
) -> Result<(), String> {
    map.validate()?;
    let Some(qid) = query_backed_query_id(map) else {
        return Err(format!("KeyMap '{}': not query-backed", map.id));
    };
    if workspace.query(qid).is_none() {
        return Err(format!(
            "KeyMap '{}': query '{qid}' not found in workspace",
            map.id
        ));
    }
    let from_cols = map.from_columns_eff();
    let out_cols = map.output_columns_eff();
    if out_cols.is_empty() || out_cols.iter().any(|c| c.trim().is_empty()) {
        return Err(format!("KeyMap '{}': output_columns must be non-empty", map.id));
    }
    let available: HashMap<String, String> = schema_columns
        .iter()
        .map(|c| (c.to_ascii_lowercase(), c.clone()))
        .collect();
    if available.len() != schema_columns.len() {
        // Ambiguous case-insensitive names on the query result.
        let mut seen = HashSet::new();
        for c in schema_columns {
            let k = c.to_ascii_lowercase();
            if !seen.insert(k.clone()) {
                return Err(format!(
                    "KeyMap '{}': query '{qid}' has ambiguous column '{c}' (case variants)",
                    map.id, 
                ));
            }
        }
    }
    let resolve = |name: &str| -> Result<String, String> {
        let key = name.to_ascii_lowercase();
        available.get(&key).cloned().ok_or_else(|| {
            format!(
                "KeyMap '{}': column '{name}' not found on query '{qid}'",
                map.id
            )
        })
    };
    for c in &from_cols {
        resolve(c)?;
    }
    for c in &out_cols {
        resolve(c)?;
    }
    let mut used = HashSet::new();
    for c in from_cols.iter().chain(out_cols.iter()) {
        if !used.insert(c.to_ascii_lowercase()) {
            return Err(format!(
                "KeyMap '{}': duplicate map column '{c}' (From/outputs)",
                map.id
            ));
        }
    }
    Ok(())
}

/// Query-backed maps referenced by `ApplyKeyMap` inside the subgraph of `root_id`.
/// Full-set validation must cover these relations (ADR-0036), not only matched Apply rows.
pub fn query_maps_applied_from<'a>(
    workspace: &'a Workspace,
    root_id: &str,
) -> Result<Vec<&'a KeyMapDef>, String> {
    let need = reachable_from(workspace, root_id)?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for qid in &need {
        let q = workspace
            .query(qid)
            .ok_or_else(|| format!("missing query {qid}"))?;
        for step in &q.steps {
            let TransformationStep::ApplyKeyMap { map_id, .. } = step else {
                continue;
            };
            // External Apply map_ids are validated elsewhere; full-set scan needs a local query.
            let Ok(key) = map_id.compiler_id() else {
                continue;
            };
            if key.is_empty() || !seen.insert(key.to_string()) {
                continue;
            }
            let Some(map) = workspace.key_maps.iter().find(|m| m.id == key) else {
                continue;
            };
            if query_backed_query_id(map).is_some() {
                out.push(map);
            }
        }
    }
    Ok(out)
}

/// SQL body (no WITH) that returns up to a few diagnostic rows for full-set
/// validation of a map relation CTE. Empty result ⇒ valid.
///
/// Columns: `kind` (`null_from` | `null_output` | `duplicate_from`), `detail`.
/// Does not trim or case-fold values (ADR-0036).
pub fn query_map_full_set_check_sql(
    map_cte: &str,
    from_cols: &[String],
    output_cols: &[String],
) -> Result<String, String> {
    if from_cols.is_empty() || output_cols.is_empty() {
        return Err("query_map_full_set_check_sql: from/output columns required".into());
    }
    let from_q: Vec<String> = from_cols.iter().map(|c| quote_ident(c)).collect();
    let out_q: Vec<String> = output_cols.iter().map(|c| quote_ident(c)).collect();
    let mut arms = Vec::new();
    for (i, col) in from_q.iter().enumerate() {
        let label = escape_sql_string(&format!("From part {i} ({})", from_cols[i]));
        arms.push(format!(
            "(SELECT 'null_from' AS kind, '{label}' AS detail \
             FROM {map_cte} WHERE {col} IS NULL OR CAST({col} AS VARCHAR) = '' LIMIT 1)"
        ));
    }
    for (i, col) in out_q.iter().enumerate() {
        let label = escape_sql_string(&format!("output {i} ({})", output_cols[i]));
        arms.push(format!(
            "(SELECT 'null_output' AS kind, '{label}' AS detail \
             FROM {map_cte} WHERE {col} IS NULL OR CAST({col} AS VARCHAR) = '' LIMIT 1)"
        ));
    }
    let group = from_q.join(", ");
    let detail = if from_q.len() == 1 {
        format!("CAST({} AS VARCHAR)", from_q[0])
    } else {
        let parts: Vec<String> = from_q
            .iter()
            .map(|c| format!("CAST({c} AS VARCHAR)"))
            .collect();
        format!("concat_ws(',', {})", parts.join(", "))
    };
    arms.push(format!(
        "(SELECT 'duplicate_from' AS kind, {detail} AS detail \
         FROM {map_cte} GROUP BY {group} HAVING COUNT(*) > 1 LIMIT 1)"
    ));
    Ok(format!(
        "SELECT kind, detail FROM (\n  {}\n) _dwh_qmap_check LIMIT 8",
        arms.join("\n  UNION ALL\n  ")
    ))
}

/// Full-set row validation (ADR-0036 / ADR-0037). No trim/case normalization of values.
/// `rows` are parallel to `from_cols` then each output column.
pub fn validate_query_map_rows(
    map_id: &str,
    from_arity: usize,
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    validate_query_map_rows_ex(map_id, from_arity, 1, rows)
}

/// Like [`validate_query_map_rows`] with explicit output arity ([ADR-0037]).
pub fn validate_query_map_rows_ex(
    map_id: &str,
    from_arity: usize,
    output_arity: usize,
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    if from_arity < 1 {
        return Err(format!("KeyMap '{map_id}': From arity must be ≥ 1"));
    }
    if output_arity < 1 {
        return Err(format!("KeyMap '{map_id}': output arity must be ≥ 1"));
    }
    let mut seen: HashSet<Vec<String>> = HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        let expect = from_arity + output_arity;
        if row.len() != expect {
            return Err(format!(
                "KeyMap '{map_id}': row {i} has {} cells, expected {expect}",
                row.len()
            ));
        }
        let mut from_parts = Vec::with_capacity(from_arity);
        for (p, cell) in row.iter().take(from_arity).enumerate() {
            match cell {
                None => {
                    return Err(format!(
                        "KeyMap '{map_id}': NULL in From part {p} at row {i}"
                    ));
                }
                Some(s) if s.is_empty() => {
                    return Err(format!(
                        "KeyMap '{map_id}': empty From part {p} at row {i}"
                    ));
                }
                Some(s) => from_parts.push(s.clone()),
            }
        }
        for (o, cell) in row.iter().skip(from_arity).enumerate() {
            match cell {
                None => {
                    return Err(format!(
                        "KeyMap '{map_id}': NULL in output {o} at row {i}"
                    ));
                }
                Some(s) if s.is_empty() => {
                    return Err(format!(
                        "KeyMap '{map_id}': empty output {o} at row {i}"
                    ));
                }
                Some(_) => {}
            }
        }
        if !seen.insert(from_parts.clone()) {
            return Err(format!(
                "KeyMap '{map_id}': duplicate From tuple {from_parts:?} at row {i}"
            ));
        }
    }
    Ok(())
}

/// Query ids that `steps` depend on, including query-backed KeyMaps referenced by ApplyKeyMap.
pub fn direct_deps_with_maps(
    workspace: &Workspace,
    steps: &[TransformationStep],
) -> Result<Vec<String>, String> {
    direct_deps_ex(steps, Some(&workspace.key_maps))
}

/// Explain a cycle involving query-backed maps (best-effort chain).
pub fn explain_map_cycle(workspace: &Workspace, tip: &str) -> String {
    let mut parts = vec![tip.to_string()];
    if let Ok(reach) = reachable_from(workspace, tip) {
        for km in &workspace.key_maps {
            if let Some(qid) = query_backed_query_id(km) {
                if reach.contains(qid) {
                    parts.push(format!("map:{}→query:{}", km.id, qid));
                }
            }
        }
    }
    parts.join(" → ")
}

/// Refuse Apply of `map` inside `consumer_query_id` when that would cycle through the map query.
pub fn assert_no_query_map_cycle(
    workspace: &Workspace,
    consumer_query_id: &str,
    map: &KeyMapDef,
) -> Result<(), String> {
    let Some(map_qid) = query_backed_query_id(map) else {
        return Ok(());
    };
    if consumer_query_id == map_qid {
        return Err(format!(
            "Cycle: ApplyKeyMap '{}' cannot run inside its own map query '{}' ({})",
            map.id,
            map_qid,
            explain_map_cycle(workspace, map_qid)
        ));
    }
    // If the map query is reachable from the consumer *without* going through this Apply,
    // joining still requires compiling map_qid before consumer — fine.
    // Cycle when map_qid transitively depends on consumer (map query needs consumer result).
    match reachable_from(workspace, map_qid) {
        Ok(reach) if reach.contains(consumer_query_id) => Err(format!(
            "Cycle: KeyMap '{}' query '{}' depends on consumer '{}' ({})",
            map.id,
            map_qid,
            consumer_query_id,
            explain_map_cycle(workspace, map_qid)
        )),
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{KeyMapDef, KeyMapStorage, QueryDef, TransformationStep, Workspace};

    fn ws_with(queries: Vec<QueryDef>, maps: Vec<KeyMapDef>) -> Workspace {
        Workspace {
            focus_query_id: queries.first().map(|q| q.id.clone()).unwrap_or_default(),
            queries,
            key_maps: maps,
        }
    }

    #[test]
    fn binding_requires_columns() {
        let mut map = KeyMapDef::new("m1", "M");
        map.storage = KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        map.from_columns = vec!["a".into()];
        map.to_column = "b".into();
        map.output_columns = vec!["b".into()];
        let q = QueryDef {
            id: "q_map".into(),
            name: "map".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "x.csv".into(),
            }],
            execution: Default::default(),
        };
        let ws = ws_with(vec![q], vec![map.clone()]);
        assert!(validate_query_map_binding(&map, &ws, &["a".into(), "b".into()]).is_ok());
        assert!(validate_query_map_binding(&map, &ws, &["a".into()]).is_err());
        assert!(validate_query_map_binding(&map, &ws, &["a".into(), "a".into(), "b".into()]).is_err());
    }

    #[test]
    fn rows_reject_null_and_dupes() {
        assert!(validate_query_map_rows(
            "m",
            1,
            &[vec![Some("x".into()), Some("y".into())]]
        )
        .is_ok());
        assert!(validate_query_map_rows("m", 1, &[vec![None, Some("y".into())]]).is_err());
        assert!(validate_query_map_rows(
            "m",
            1,
            &[
                vec![Some("x".into()), Some("y".into())],
                vec![Some("x".into()), Some("z".into())],
            ]
        )
        .is_err());
    }

    #[test]
    fn full_set_check_sql_covers_from_outputs_and_dupes() {
        let sql = query_map_full_set_check_sql(
            "q_map_s0",
            &["alias".into()],
            &["product_id".into(), "variant_code".into()],
        )
        .unwrap();
        assert!(sql.contains("null_from") && sql.contains("null_output"), "{sql}");
        assert!(sql.contains("duplicate_from"), "{sql}");
        assert!(sql.contains("\"variant_code\""), "{sql}");
        assert!(!sql.to_lowercase().contains("trim("), "{sql}");
    }

    #[test]
    fn full_set_check_sql_escapes_apostrophe_in_column_labels() {
        let sql = query_map_full_set_check_sql(
            "q_map_s0",
            &["customer's_code".into()],
            &["item's_id".into()],
        )
        .unwrap();
        // Diagnostic string literals must double apostrophes; idents stay quoted.
        assert!(
            sql.contains("'From part 0 (customer''s_code)'"),
            "From label must escape apostrophe: {sql}"
        );
        assert!(
            sql.contains("'output 0 (item''s_id)'"),
            "output label must escape apostrophe: {sql}"
        );
        assert!(sql.contains("\"customer's_code\""), "{sql}");
        assert!(sql.contains("\"item's_id\""), "{sql}");
    }

    #[test]
    fn applied_maps_from_focus_lists_query_storage_only() {
        let mut qmap = KeyMapDef::new("qm", "Q");
        qmap.storage = KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        let mut seed = KeyMapDef::new("sm", "S");
        seed.storage = KeyMapStorage::Seed;
        let ws = ws_with(
            vec![
                QueryDef {
                    id: "q_map".into(),
                    name: "map".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "m.csv".into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "q_fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: "f.csv".into(),
                        },
                        TransformationStep::ApplyKeyMap {
                            column: "a".into(),
                            columns: vec![],
                            output_column: None,
                            output_bindings: vec![],
                            as_of_column: None,
                            map_id: "qm".into(),
                            entries: vec![],
                        },
                        TransformationStep::ApplyKeyMap {
                            column: "b".into(),
                            columns: vec![],
                            output_column: None,
                            output_bindings: vec![],
                            as_of_column: None,
                            map_id: "sm".into(),
                            entries: vec![],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            vec![qmap, seed],
        );
        let maps = query_maps_applied_from(&ws, "q_fact").unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].id, "qm");
    }

    #[test]
    fn direct_cycle_apply_in_map_query() {
        let mut map = KeyMapDef::new("m1", "M");
        map.storage = KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        let q = QueryDef {
            id: "q_map".into(),
            name: "map".into(),
            steps: vec![
                TransformationStep::LoadCsv {
                    path: "x.csv".into(),
                },
                TransformationStep::ApplyKeyMap {
                    column: "a".into(),
                    columns: vec![],
                    output_column: None,
            output_bindings: vec![],
                    as_of_column: None,
                    map_id: "m1".into(),
                    entries: vec![],
                },
            ],
            execution: Default::default(),
        };
        let ws = ws_with(vec![q], vec![map.clone()]);
        let err = assert_no_query_map_cycle(&ws, "q_map", &map).unwrap_err();
        assert!(err.contains("Cycle"), "{err}");
    }
}
