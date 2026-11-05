//! Full-set validation for query-backed KeyMaps ([ADR-0036] / [ADR-0037] §9).
//!
//! Matched-row Apply guards only see keys present in the fact input. This module
//! scans the entire map query relation (aggregates + limited diagnostics) before
//! preview / compile of a consumer that Applies the map.

use crate::compile::{describe_compiled_cte, graph_compiler, PreparedWorkspace};
use crate::session::DbSession;
use dwh_pipeline::{
    assert_no_query_map_cycle, query_backed_query_id, query_map_full_set_check_sql,
    query_maps_applied_from, validate_query_map_binding, ConnectionDef, SourceDef, Workspace,
};
use duckdb::types::ValueRef;

/// Validate every query-backed KeyMap Applied in the subgraph of `root_id`.
pub fn validate_query_backed_maps_for_root(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    prepared: &PreparedWorkspace,
    root_id: &str,
) -> Result<(), String> {
    let maps = query_maps_applied_from(workspace, root_id)?;
    if maps.is_empty() {
        return Ok(());
    }
    for map in maps {
        validate_one_query_map(db, workspace, connections, sources, prepared, map, root_id)?;
    }
    Ok(())
}

fn validate_one_query_map(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    prepared: &PreparedWorkspace,
    map: &dwh_pipeline::KeyMapDef,
    consumer_root: &str,
) -> Result<(), String> {
    let qid = query_backed_query_id(map).ok_or_else(|| {
        format!("KeyMap '{}': expected query-backed storage", map.id)
    })?;
    assert_no_query_map_cycle(workspace, consumer_root, map)?;

    let compiled = graph_compiler(workspace, connections, sources, &prepared.schemas)
        .compile_ctes_from(qid)?;
    let last = compiled.last_by_query.get(qid).ok_or_else(|| {
        format!(
            "KeyMap '{}': map query '{qid}' produced no CTE",
            map.id
        )
    })?;

    let cols = describe_compiled_cte(db, &compiled, last)?;
    validate_query_map_binding(map, workspace, &cols)?;

    let from_cols = map.from_columns_eff();
    let out_cols = map.output_columns_eff();
    let check_body = query_map_full_set_check_sql(last, &from_cols, &out_cols)?;
    let sql = compiled.wrap_select(&check_body);

    let hits: Vec<(String, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let kind = cell_as_string(row.get_ref(0).map_err(|e| e.to_string())?)?;
            let detail = cell_as_string(row.get_ref(1).map_err(|e| e.to_string())?)?;
            out.push((kind, detail));
        }
        Ok(out)
    })?;

    if hits.is_empty() {
        return Ok(());
    }
    let mut parts = Vec::new();
    for (kind, detail) in hits {
        match kind.as_str() {
            "null_from" => parts.push(format!("NULL/empty {detail}")),
            "null_output" => parts.push(format!("NULL/empty {detail}")),
            "duplicate_from" => parts.push(format!("duplicate From tuple ({detail})")),
            other => parts.push(format!("{other}: {detail}")),
        }
    }
    Err(format!(
        "KeyMap '{}' (query '{qid}'): full-set validation failed — {}. \
         UI sample / unused Apply keys do not bound this check (ADR-0036).",
        map.id,
        parts.join("; ")
    ))
}

fn cell_as_string(v: ValueRef<'_>) -> Result<String, String> {
    Ok(match v {
        ValueRef::Null => String::new(),
        ValueRef::Text(b) => String::from_utf8_lossy(b).into_owned(),
        ValueRef::Boolean(b) => b.to_string(),
        ValueRef::TinyInt(n) => n.to_string(),
        ValueRef::SmallInt(n) => n.to_string(),
        ValueRef::Int(n) => n.to_string(),
        ValueRef::BigInt(n) => n.to_string(),
        ValueRef::HugeInt(n) => n.to_string(),
        ValueRef::UTinyInt(n) => n.to_string(),
        ValueRef::USmallInt(n) => n.to_string(),
        ValueRef::UInt(n) => n.to_string(),
        ValueRef::UBigInt(n) => n.to_string(),
        ValueRef::Float(n) => n.to_string(),
        ValueRef::Double(n) => n.to_string(),
        other => format!("{other:?}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{
        KeyMapDef, KeyMapStorage, QueryDef, TransformationStep, Workspace,
    };

    fn ws_apply_query_map(map_sql: &str, fact_sql: &str) -> Workspace {
        let mut map = KeyMapDef::new("sku_map", "sku");
        map.storage = KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        map.from_column = "alias".into();
        map.to_column = "product_id".into();
        map.output_columns = vec!["product_id".into(), "variant_code".into()];
        map.entries = vec![];
        Workspace {
            queries: vec![
                QueryDef {
                    id: "q_map".into(),
                    name: "map".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: map_sql.into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "q_fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::SqlModel {
                            raw_sql: fact_sql.into(),
                        },
                        TransformationStep::ApplyKeyMap {
                            column: "alias".into(),
                            columns: vec!["alias".into()],
                            output_column: None,
                            output_bindings: vec![
                                dwh_pipeline::ApplyKeyMapOutputBinding {
                                    map_column: "product_id".into(),
                                    destination_column: "product_id".into(),
                                },
                                dwh_pipeline::ApplyKeyMapOutputBinding {
                                    map_column: "variant_code".into(),
                                    destination_column: "variant_code".into(),
                                },
                            ],
                            as_of_column: None,
                            map_id: "sku_map".into(),
                            entries: vec![],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "q_fact".into(),
            key_maps: vec![map],
        }
    }

    #[test]
    fn unused_null_output_fails_full_set() {
        // Fact only has A; map row B has NULL variant — matched-row guard would miss it.
        let ws = ws_apply_query_map(
            "select 'A' as alias, 'P100' as product_id, 'BLUE-M' as variant_code \
             union all \
             select 'B', 'P200', cast(NULL as varchar)",
            "select 'A' as alias",
        );
        let db = DbSession::new().unwrap();
        let err = crate::preview::preview_workspace(&db, &ws, &[], &[]).unwrap_err();
        assert!(
            err.contains("full-set") && (err.contains("NULL") || err.contains("null")),
            "{err}"
        );
    }

    #[test]
    fn unused_duplicate_from_fails_full_set() {
        let ws = ws_apply_query_map(
            "select 'A' as alias, 'P100' as product_id, 'BLUE-M' as variant_code \
             union all \
             select 'B', 'P200', 'RED' \
             union all \
             select 'B', 'P200', 'RED'",
            "select 'A' as alias",
        );
        let db = DbSession::new().unwrap();
        let err = crate::preview::preview_workspace(&db, &ws, &[], &[]).unwrap_err();
        assert!(
            err.contains("full-set") && err.contains("duplicate"),
            "{err}"
        );
    }

    #[test]
    fn valid_full_set_allows_preview() {
        let ws = ws_apply_query_map(
            "select 'A' as alias, 'P100' as product_id, 'BLUE-M' as variant_code \
             union all \
             select 'B', 'P200', 'RED'",
            "select 'A' as alias",
        );
        let db = DbSession::new().unwrap();
        let out = crate::preview::preview_workspace(&db, &ws, &[], &[]).unwrap();
        assert!(!out.columns.is_empty(), "{out:?}");
    }
}
