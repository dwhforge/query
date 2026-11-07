//! Execution gates for ADR-0037/0038 multi-output Apply (cardinality + results, not SQL shape).

#[cfg(test)]
mod tests {
    use crate::compile::{compile_focus_sql, prepare_operation};
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

    fn ambiguous_query_map_ws() -> Workspace {
        let mut map = KeyMapDef::new("sku_map", "sku");
        map.storage = dwh_pipeline::KeyMapStorage::Query {
            query_id: "q_map".into(),
        };
        map.from_column = "sku".into();
        map.to_column = "product_id".into();
        map.output_columns = vec!["product_id".into(), "variant_code".into()];
        map.entries = vec![];
        map.canonicalize_outputs();
        Workspace {
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
        }
    }

    fn count_over_preview_sql(preview_sql: &str) -> String {
        let count_sql = preview_sql.replace("SELECT * FROM", "SELECT COUNT(*) AS n FROM");
        count_sql
            .split(" LIMIT ")
            .next()
            .unwrap_or(&count_sql)
            .to_string()
            + ";"
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
        let count_sql = count_over_preview_sql(&preview.sql);
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

    /// Full-set validation refuses ambiguous query maps before Apply runs.
    #[test]
    fn duckdb_apply_full_set_refuses_ambiguous_query_map() {
        let ws = ambiguous_query_map_ws();
        let db = DbSession::new().unwrap();
        let err = preview_workspace(&db, &ws, &[], &[]).unwrap_err();
        assert!(
            err.to_lowercase().contains("duplicate")
                || err.to_lowercase().contains("ambiguous")
                || err.to_lowercase().contains("full-set"),
            "full-set must abort: {err}"
        );
    }

    /// Matched-row SQL uniqueness guard must abort even when projection is COUNT(*)
    /// (compile without full-set so the guard itself is exercised).
    #[test]
    fn duckdb_apply_count_star_aborts_on_ambiguous_sql_guard() {
        let db = DbSession::new().unwrap();

        // Control: same COUNT(*) path on a valid map must succeed.
        let ok_ws = multi_output_ws(
            "select 'A' as sku",
            vec![KeyMapEntry::parts_multi(
                vec!["A".into()],
                vec!["P100".into(), "BLUE".into()],
            )],
        );
        let _ = prepare_operation(&db, &ok_ws, &[], &[]).unwrap();
        let ok_sql = compile_focus_sql(&db, &ok_ws, &[], &[], true).unwrap();
        let ok_count = count_over_preview_sql(&ok_sql);
        let n: i64 = db
            .with_conn(|conn| {
                conn.query_row(&ok_count, [], |r| r.get(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(n, 1, "valid map COUNT(*) must run: sql={ok_count}");

        let ws = ambiguous_query_map_ws();
        let _prepared = prepare_operation(&db, &ws, &[], &[]).unwrap();
        // Intentionally skip validate_prepared — isolate the emit SQL guard.
        let sql = compile_focus_sql(&db, &ws, &[], &[], true).unwrap();
        let count_sql = count_over_preview_sql(&sql);
        let err = db
            .with_conn(|conn| {
                conn.query_row(&count_sql, [], |r| r.get::<_, i64>(0))
                    .map_err(|e| e.to_string())
            })
            .unwrap_err();
        assert!(
            err.contains("KeyMap sku_map: ambiguous From"),
            "COUNT(*) must hit uniqueness guard message, got: {err}"
        );
    }

    /// Postgres abort idiom is row-dependent in emitted SQL (shape gate).
    #[test]
    fn postgres_apply_abort_shape_is_row_dependent() {
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
    }

    /// When `DWH_PG_DSN` is set, execute the PG abort idiom via ATTACH + postgres_query.
    #[test]
    fn postgres_apply_abort_evaluates_when_dsn_set() {
        let Ok(dsn) = std::env::var("DWH_PG_DSN") else {
            eprintln!("skip live PG abort evaluation: DWH_PG_DSN unset");
            return;
        };
        if dsn.trim().is_empty() {
            eprintln!("skip live PG abort evaluation: DWH_PG_DSN empty");
            return;
        }
        let db = DbSession::new().unwrap();
        db.ensure_postgres().unwrap();
        use crate::postgres_catalog::ensure_pg_attached;
        db.with_conn(|conn| {
            let alias = ensure_pg_attached(conn, dsn.trim())?;
            // True → SELECT 0 → 1/0 must fail (same idiom as emit_abort_expr Postgres).
            let fail_sql = format!(
                "SELECT * FROM postgres_query('{alias}', 'SELECT ((1 / (SELECT 0 WHERE (true)))::VARCHAR) AS x')"
            );
            let fail = conn.execute(&fail_sql, []);
            assert!(
                fail.is_err(),
                "PG abort idiom with true guard must fail, got {fail:?}"
            );
            // False → empty subquery → NULL (no division by zero).
            let ok_sql = format!(
                "SELECT * FROM postgres_query('{alias}', 'SELECT ((1 / (SELECT 0 WHERE (false)))::VARCHAR) AS x')"
            );
            conn.query_row(&ok_sql, [], |r| r.get::<_, Option<String>>(0))
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
        .unwrap();
    }
}
