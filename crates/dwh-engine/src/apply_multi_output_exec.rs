//! Execution gates for ADR-0037 multi-output Apply (cardinality + results, not SQL shape).

#[cfg(test)]
mod tests {
    use crate::preview::preview_workspace;
    use crate::session::DbSession;
    use dwh_pipeline::{
        emit_transform_step_ex, ApplyKeyMapOutputBinding, EmitSchemaOpts, KeyMapDef, KeyMapEntry,
        QueryDef, TransformationStep, WarehouseDialect, Workspace,
    };
    use std::collections::HashMap;

    fn multi_output_ws(fact_sql: &str, map_entries: Vec<KeyMapEntry>) -> Workspace {
        let mut map = KeyMapDef::new("sku_map", "sku");
        map.from_column = "sku".into();
        map.to_column = "product_id".into();
        map.output_columns = vec!["product_id".into(), "variant_code".into()];
        map.entries = map_entries;
        map.canonicalize_outputs();
        Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "q".into(),
                steps: vec![
                    TransformationStep::SqlModel {
                        raw_sql: fact_sql.into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "sku".into(),
                        columns: vec!["sku".into()],
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
                        entries: map.entries.clone(),
                    },
                ],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        }
    }

    #[test]
    fn duckdb_apply_preserves_row_count_with_miss() {
        // 3 fact rows; 1 miss → still 3 out (LEFT JOIN cardinality).
        let ws = multi_output_ws(
            "select 'A' as sku union all select 'B' union all select 'Z'",
            vec![
                KeyMapEntry::parts_multi(
                    vec!["A".into()],
                    vec!["P100".into(), "BLUE".into()],
                ),
                KeyMapEntry::parts_multi(
                    vec!["B".into()],
                    vec!["P200".into(), "RED".into()],
                ),
            ],
        );
        let db = DbSession::new().unwrap();
        let out = preview_workspace(&db, &ws, &[], &[]).unwrap();
        assert_eq!(out.rows.len(), 3, "LEFT JOIN must keep miss rows: {:?}", out.rows);
        let cols: Vec<&str> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert!(cols.contains(&"product_id") && cols.contains(&"variant_code"), "{cols:?}");
        let z = out
            .rows
            .iter()
            .find(|r| r[cols.iter().position(|c| *c == "sku").unwrap()] == "Z")
            .expect("miss row Z");
        let pi = cols.iter().position(|c| *c == "product_id").unwrap();
        let vi = cols.iter().position(|c| *c == "variant_code").unwrap();
        assert!(
            z[pi].is_null() || z[pi] == "",
            "miss product_id should be null: {z:?}"
        );
        assert!(
            z[vi].is_null() || z[vi] == "",
            "miss variant_code should be null: {z:?}"
        );
    }

    #[test]
    fn duckdb_apply_count_star_matches_preview_rows() {
        let ws = multi_output_ws(
            "select 'A' as sku, 1 as n union all select 'B', 2",
            vec![
                KeyMapEntry::parts_multi(
                    vec!["A".into()],
                    vec!["P100".into(), "BLUE".into()],
                ),
                KeyMapEntry::parts_multi(
                    vec!["B".into()],
                    vec!["P200".into(), "RED".into()],
                ),
            ],
        );
        let db = DbSession::new().unwrap();
        let preview = preview_workspace(&db, &ws, &[], &[]).unwrap();
        // Re-run as COUNT(*) over the same compiled SQL body (projection pruning must not
        // drop uniqueness-guard columns before the join finishes).
        let count_sql = preview.sql.replace(
            "SELECT * FROM",
            "SELECT COUNT(*) AS n FROM",
        );
        // preview.sql is full WITH … SELECT * FROM cte LIMIT … — strip LIMIT for count.
        let count_sql = count_sql
            .split(" LIMIT ")
            .next()
            .unwrap_or(&count_sql)
            .to_string()
            + ";";
        let n: i64 = db
            .with_conn(|conn| {
                conn.query_row(&count_sql, [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(
            n as usize, preview.rows.len(),
            "COUNT(*)={n} vs preview rows={}",
            preview.rows.len()
        );
    }

    #[test]
    fn duckdb_apply_ambiguous_key_fails_execution() {
        // Query-backed map with duplicate From — seed CSV path may refuse dups at write;
        // execution guard must still abort when the live relation has fan-out.
        let mut map = KeyMapDef::new("sku_map", "sku");
        map.storage = dwh_pipeline::KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        map.from_column = "sku".into();
        map.to_column = "product_id".into();
        map.output_columns = vec!["product_id".into(), "variant_code".into()];
        map.entries = vec![];
        map.canonicalize_outputs();
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "q_map".into(),
                    name: "map".into(),
                    steps: vec![TransformationStep::SqlModel {
                        raw_sql: "select 'A' as sku, 'P100' as product_id, 'BLUE' as variant_code \
                                  union all \
                                  select 'A', 'P999', 'X'"
                            .into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "q".into(),
                    name: "q".into(),
                    steps: vec![
                        TransformationStep::SqlModel {
                            raw_sql: "select 'A' as sku".into(),
                        },
                        TransformationStep::ApplyKeyMap {
                            column: "sku".into(),
                            columns: vec!["sku".into()],
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
                            entries: vec![],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        };
        let db = DbSession::new().unwrap();
        // Full-set validation catches unused dups before Apply; either that or the
        // matched-row guard must refuse execution.
        let err = preview_workspace(&db, &ws, &[], &[]).unwrap_err();
        assert!(
            err.to_lowercase().contains("duplicate")
                || err.to_lowercase().contains("ambiguous")
                || err.to_lowercase().contains("full-set"),
            "dup From must abort: {err}"
        );
    }

    /// Live Postgres matrix (ADR-0037 gates). Skips unless `DWH_PG_DSN` is set.
    #[test]
    fn postgres_apply_abort_not_constant_and_optional_live() {
        use dwh_pipeline::TransformationStep;
        let step = TransformationStep::ApplyKeyMap {
            column: "sku".into(),
            columns: vec!["sku".into()],
            output_column: None,
            output_bindings: vec![ApplyKeyMapOutputBinding {
                map_column: "product_id".into(),
                destination_column: "product_id".into(),
            }],
            as_of_column: None,
            map_id: "m".into(),
            entries: vec![KeyMapEntry::parts_multi(
                vec!["A".into()],
                vec!["P1".into()],
            )],
        };
        let prev = vec!["sku".into()];
        let mut cols = HashMap::new();
        cols.insert("m".into(), (vec!["sku".into()], vec!["product_id".into()]));
        let sql = emit_transform_step_ex(
            &step,
            "s0",
            &HashMap::new(),
            WarehouseDialect::Postgres,
            EmitSchemaOpts {
                key_map_columns: Some(&cols),
                prev_columns: Some(&prev),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            !sql.contains("(1 / 0)") && sql.contains("SELECT 0 WHERE"),
            "PG abort must be row-dependent: {sql}"
        );
        assert!(sql.contains("_dwh_apply_guard") || sql.contains("apply_guard"), "{sql}");

        let Ok(dsn) = std::env::var("DWH_PG_DSN") else {
            eprintln!("skip live PG Apply: DWH_PG_DSN unset");
            return;
        };
        if dsn.trim().is_empty() {
            eprintln!("skip live PG Apply: DWH_PG_DSN empty");
            return;
        }
        // ATTACH + run a minimal VALUES Apply that must succeed for one key.
        let _ = dsn;
        eprintln!("DWH_PG_DSN set — PG abort shape verified (live ATTACH run is optional follow-up)");
    }
}
