//! Query-backed KeyMap helpers ([ADR-0036](../../../docs/adr/0036-query-backed-keymap.md)).

use crate::graph::{direct_deps_ex, reachable_from};
use crate::model::{KeyMapDef, KeyMapStorage, TransformationStep, Workspace};
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
