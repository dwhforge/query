//! Foundation e2e: fixture → seeds → export → `dbt run` → compare to preview (ADR-0018 / OpenSpec).
//!
//! Automated coverage is **DuckDB target** only. Postgres-target e2e is manual (see README / DESIGN §10 C).

#[cfg(test)]
mod tests {
    use crate::collect_load_seeds;
    use crate::preview::preview_workspace;
    use crate::session::DbSession;
    use dwh_pipeline::{
        dbt_model_name, dbt_parse, dbt_run, resolve_dbt_bin, DbtProducer, DbtTarget, QueryDef,
        TransformationStep, WarehouseDialect, Workspace,
    };
    use duckdb::params;
    use serde_json::Value as JsonValue;
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::env::temp_dir;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    /// EU + US CSV → Rename (ASCII fold) → Append. Focus = sales_all.
    fn rename_append_workspace(eu: &Path, us: &Path) -> Workspace {
        Workspace {
            queries: vec![
                QueryDef {
                    id: "sales_eu".into(),
                    name: "sales_eu".into(),
                    steps: vec![TransformationStep::LoadCsv { path: eu.to_string_lossy().into(), path_kind: Default::default() }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales_us".into(),
                    name: "sales_us".into(),
                    steps: vec![TransformationStep::LoadCsv { path: us.to_string_lossy().into(), path_kind: Default::default() }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales_all".into(),
                    name: "sales_all".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sales_eu".into(),
                        },
                        // Case-only rename: Append must align BY-NAME under ASCII fold.
                        TransformationStep::RenameColumn {
                            from: "amount".into(),
                            to: "Amount".into(),
                        },
                        TransformationStep::Append {
                            other_query_ids: vec!["sales_us".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "sales_all".into(),
            key_maps: vec![],
        }
    }

    /// Type-tagged cell fingerprint. Numbers may normalize 1200 vs 1200.0;
    /// strings are never coerced to numbers (so "001" ≠ "1").
    fn cell_key(v: &JsonValue) -> String {
        match v {
            JsonValue::Null => "∅".into(),
            JsonValue::Bool(b) => format!("b:{b}"),
            JsonValue::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() < (i64::MAX as f64) {
                        return format!("n:{}", f as i64);
                    }
                    return format!("n:{f}");
                }
                format!("n:{n}")
            }
            JsonValue::String(s) => format!("s:{s}"),
            other => format!("o:{other}"),
        }
    }

    #[test]
    fn cell_key_keeps_leading_zeros_as_strings() {
        assert_ne!(
            cell_key(&JsonValue::String("001".into())),
            cell_key(&JsonValue::String("1".into()))
        );
        assert_ne!(
            cell_key(&JsonValue::String("001".into())),
            cell_key(&JsonValue::Number(1.into()))
        );
        assert_eq!(
            cell_key(&JsonValue::Number(serde_json::Number::from_f64(1200.0).unwrap())),
            cell_key(&JsonValue::Number(1200.into()))
        );
    }

    /// row fingerprint → multiplicity (preserves duplicate distribution).
    fn row_multiset(
        columns: &[String],
        rows: &[Vec<JsonValue>],
    ) -> BTreeMap<String, usize> {
        let mut m = BTreeMap::new();
        for r in rows {
            let key = columns
                .iter()
                .enumerate()
                .map(|(i, c)| format!("{c}={}", cell_key(r.get(i).unwrap_or(&JsonValue::Null))))
                .collect::<Vec<_>>()
                .join("|");
            *m.entry(key).or_insert(0) += 1;
        }
        m
    }

    fn read_mart_table(
        duckdb_path: &Path,
        table: &str,
    ) -> Result<(Vec<String>, Vec<Vec<JsonValue>>), String> {
        use duckdb::types::ValueRef;
        let conn = duckdb::Connection::open(duckdb_path).map_err(|e| e.to_string())?;

        let mut columns = Vec::new();
        {
            let describe = format!("DESCRIBE SELECT * FROM main.\"{table}\"");
            let mut dstmt = conn.prepare(&describe).map_err(|e| e.to_string())?;
            let mut drows = dstmt.query(params![]).map_err(|e| e.to_string())?;
            while let Some(row) = drows.next().map_err(|e| e.to_string())? {
                let name: String = row.get(0).map_err(|e| e.to_string())?;
                columns.push(name);
            }
        }
        if columns.is_empty() {
            return Err(format!("no columns in {table}"));
        }

        let sql = format!("SELECT * FROM main.\"{table}\"");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let col_count = columns.len();
        let mut rows_iter = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        while let Some(row) = rows_iter.next().map_err(|e| e.to_string())? {
            let mut out = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let cell = match row.get_ref(i).map_err(|e| e.to_string())? {
                    ValueRef::Null => JsonValue::Null,
                    ValueRef::Boolean(b) => JsonValue::Bool(b),
                    ValueRef::TinyInt(n) => JsonValue::Number((n as i64).into()),
                    ValueRef::SmallInt(n) => JsonValue::Number((n as i64).into()),
                    ValueRef::Int(n) => JsonValue::Number((n as i64).into()),
                    ValueRef::BigInt(n) => JsonValue::Number(n.into()),
                    ValueRef::HugeInt(n) => JsonValue::String(n.to_string()),
                    ValueRef::UTinyInt(n) => JsonValue::Number((n as u64).into()),
                    ValueRef::USmallInt(n) => JsonValue::Number((n as u64).into()),
                    ValueRef::UInt(n) => JsonValue::Number((n as u64).into()),
                    ValueRef::UBigInt(n) => JsonValue::Number(n.into()),
                    ValueRef::Float(f) => serde_json::Number::from_f64(f as f64)
                        .map(JsonValue::Number)
                        .unwrap_or(JsonValue::Null),
                    ValueRef::Double(f) => serde_json::Number::from_f64(f)
                        .map(JsonValue::Number)
                        .unwrap_or(JsonValue::Null),
                    ValueRef::Text(b) => JsonValue::String(String::from_utf8_lossy(b).into()),
                    ValueRef::Date32(d) => {
                        let s = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
                            .and_then(|epoch| {
                                epoch.checked_add_signed(chrono::Duration::days(i64::from(d)))
                            })
                            .map(|dt| dt.format("%Y-%m-%d").to_string())
                            .unwrap_or_else(|| d.to_string());
                        JsonValue::String(s)
                    }
                    other => JsonValue::String(format!("{other:?}")),
                };
                out.push(cell);
            }
            rows.push(out);
        }
        Ok((columns, rows))
    }

    #[test]
    fn collect_seeds_from_csv_fixtures() {
        let fixtures = fixtures_dir();
        let eu = fixtures.join("sales_eu.csv");
        let us = fixtures.join("sales_us.csv");
        assert!(eu.is_file(), "missing {}", eu.display());
        let ws = rename_append_workspace(&eu, &us);
        let db = DbSession::new().expect("duckdb");
        let seeds = collect_load_seeds(&db, &ws, &[], &[])
            .expect("seeds")
            .seeds;
        let expected = vec![
            "date".to_string(),
            "region".to_string(),
            "amount".to_string(),
            "qty".to_string(),
        ];
        assert_eq!(seeds.get("sales_eu"), Some(&expected));
        assert_eq!(seeds.get("sales_us"), Some(&expected));
    }

    #[test]
    fn export_run_compare_rename_append_duckdb() {
        let Some(bin) = resolve_dbt_bin(&[]) else {
            eprintln!("skip e2e: dbt not installed (./scripts/fetch-dbt-venv.sh)");
            return;
        };

        let fixtures = fixtures_dir();
        let eu = fixtures.join("sales_eu.csv");
        let us = fixtures.join("sales_us.csv");
        if !eu.is_file() || !us.is_file() {
            eprintln!("skip e2e: fixtures missing");
            return;
        }

        let ws = rename_append_workspace(&eu, &us);
        let db = DbSession::new().expect("duckdb");
        let seeds = collect_load_seeds(&db, &ws, &[], &[])
            .expect("seeds")
            .seeds;
        assert!(!seeds.is_empty(), "e2e needs Load* seeds");

        let preview = preview_workspace(&db, &ws, &[], &[]).expect("preview");
        assert_eq!(preview.rows.len(), 10, "5 EU + 5 US");

        let out = temp_dir().join(format!("dwh_e2e_{}", std::process::id()));
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(&out).unwrap();

        let path = DbtProducer
            .produce_with_seeds(
                "e2e_union",
                &ws,
                out.to_str().unwrap(),
                DbtTarget::V1,
                WarehouseDialect::Duckdb,
                &seeds,
                &HashMap::new(),
            )
            .expect("export");

        assert!(
            Path::new(&path).join(".dwhforge-export.json").is_file(),
            "manifest missing"
        );

        // Author gate ≠ data proof
        let parsed = dbt_parse(&path, Some(&bin));
        assert!(parsed.ok, "dbt parse failed:\n{}", parsed.log);

        let ran = dbt_run(&path, Some(&bin));
        assert!(ran.ok, "dbt run failed:\n{}", ran.log);

        let focus = ws.query("sales_all").unwrap();
        let mart = dbt_model_name(&ws, focus, &[]);
        let duckdb_file = Path::new(&path).join("local.duckdb");
        assert!(duckdb_file.is_file(), "dbt duckdb missing");

        let (wh_cols, wh_rows) = read_mart_table(&duckdb_file, &mart).expect("read mart");
        assert_eq!(wh_rows.len(), preview.rows.len());

        let preview_cols: Vec<String> = preview.columns.iter().map(|c| c.name.clone()).collect();
        // ASCII-fold column identity: Amount (left) vs amount (right) → one result name.
        let fold = |s: &str| s.chars().map(|c| c.to_ascii_lowercase()).collect::<String>();
        let preview_folds: BTreeSet<_> = preview_cols.iter().map(|c| fold(c)).collect();
        let wh_folds: BTreeSet<_> = wh_cols.iter().map(|c| fold(c)).collect();
        assert_eq!(preview_folds, wh_folds, "column sets differ");

        let p_set = row_multiset(&preview_cols, &preview.rows);
        // Align warehouse columns to preview order by ASCII fold.
        let mut aligned = Vec::with_capacity(wh_rows.len());
        for row in &wh_rows {
            let mut out_row = Vec::with_capacity(preview_cols.len());
            for pc in &preview_cols {
                let pf = fold(pc);
                let idx = wh_cols
                    .iter()
                    .position(|c| fold(c) == pf)
                    .expect("col");
                out_row.push(row[idx].clone());
            }
            aligned.push(out_row);
        }
        let w_set = row_multiset(&preview_cols, &aligned);
        assert_eq!(
            p_set, w_set,
            "preview vs dbt run row multiset mismatch\npreview={p_set:?}\nwarehouse={w_set:?}"
        );

        let _ = fs::remove_dir_all(&out);
    }

    /// ADR-0025: owner mapping + query, consumer reference, preview matches `dbt build`.
    #[test]
    fn reference_preview_matches_dbt_build() {
        use dwh_pipeline::{
            dbt_build, dbt_build_with_env, make_project_reference, refresh_reference,
            resolve_operation, Destination, DestinationKind, ExecutionEngine, KeyMapDef,
            KeyMapEntry, Materialization, ObjectKind, ObjectTarget, Project, QueryDef,
            ResolveInput, ResolveKind, TransformationStep,
        };

        let root = temp_dir().join(format!("dwh_ref_e2e_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let owner_dir = root.join("owner");
        let consumer_dir = root.join("consumer");
        fs::create_dir_all(owner_dir.join("data")).unwrap();
        fs::create_dir_all(consumer_dir.join("data")).unwrap();
        fs::write(
            owner_dir.join("data/products.csv"),
            "system_code,product_code,name\nSYS,P1,Widget\nSYS,P2,Gadget\n",
        )
        .unwrap();
        fs::write(
            consumer_dir.join("data/products.csv"),
            "system_code,product_code,name\nNO,X,Decoy\n",
        )
        .unwrap();

        let mut map = KeyMapDef::new("km_products", "Products");
        map.from_column = "system_code".into();
        map.from_columns = vec!["system_code".into(), "product_code".into()];
        map.to_column = "canonical_id".into();
        map.output_columns = vec!["canonical_id".into()];
        map.entries = vec![
            KeyMapEntry::parts(vec!["SYS".into(), "P1".into()], "CAN-1"),
            KeyMapEntry::parts(vec!["SYS".into(), "P2".into()], "CAN-2"),
        ];
        map.canonicalize_outputs();
        let mut owner = Project {
            format_version: dwh_pipeline::PROJECT_FORMAT_VERSION,
            id: "proj_owner".into(),
            name: "Owner".into(),
            project_uid: "uid-owner".into(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![],
            sources: vec![],
            workspace: Workspace {
                queries: vec![QueryDef {
                    id: "q_products".into(),
                    name: "products".into(),
                    steps: vec![TransformationStep::LoadCsv { path: "data/products.csv".into(), path_kind: Default::default() }],
                    execution: Default::default(),
                }],
                focus_query_id: "q_products".into(),
                key_maps: vec![map],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: ExecutionEngine::Duckdb,
            destination: Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
            mapping_checks: vec![],
            mapping_check_runs: vec![],
            pg_import: None,
        };
        let owner_path = owner_dir.join("lib.dwhproj.json");
        fs::write(&owner_path, owner.to_json_pretty().unwrap()).unwrap();

        let consumer_path = consumer_dir.join("app.dwhproj.json");
        let mut consumer = Project {
            format_version: dwh_pipeline::PROJECT_FORMAT_VERSION,
            id: "proj_consumer".into(),
            name: "Consumer".into(),
            project_uid: "uid-consumer".into(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![],
            sources: vec![],
            workspace: Workspace {
                queries: vec![],
                focus_query_id: String::new(),
                key_maps: vec![],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: ExecutionEngine::Duckdb,
            destination: Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
            mapping_checks: vec![],
            mapping_check_runs: vec![],
            pg_import: None,
        };
        fs::write(&consumer_path, consumer.to_json_pretty().unwrap()).unwrap();
        let reference =
            make_project_reference(&consumer_path, &owner_path, "SharedLib").expect("reference");
        consumer.references = vec![reference.clone()];
        consumer.workspace.queries.push(QueryDef {
            id: "q_local".into(),
            name: "local products".into(),
            steps: vec![
                TransformationStep::FromQuery {
                    query_id: ObjectTarget::external(&reference.id, ObjectKind::Query, "q_products"),
                },
                TransformationStep::ApplyKeyMap {
                    column: "system_code".into(),
                    columns: vec!["system_code".into(), "product_code".into()],
                    output_column: Some("canonical_id".into()),
            output_bindings: vec![],
                    as_of_column: None,
                    map_id: ObjectTarget::external(
                        &reference.id,
                        ObjectKind::Mapping,
                        "km_products",
                    ),
                    entries: vec![],
                },
                TransformationStep::RenameColumn {
                    from: "name".into(),
                    to: "product_name".into(),
                },
            ],
            execution: Default::default(),
        });
        consumer.workspace.focus_query_id = "q_local".into();
        consumer.outputs = vec!["q_local".into()];
        fs::write(&consumer_path, consumer.to_json_pretty().unwrap()).unwrap();
        let consumer_disk = fs::read_to_string(&consumer_path).unwrap();
        assert!(
            !consumer_disk.contains("CAN-1"),
            "consumer file must not snapshot owner mapping rows"
        );

        let resolve = |refs: &[dwh_pipeline::ProjectReference], ws: &Workspace| {
            resolve_operation(&ResolveInput {
                root_file: &consumer_path,
                project_uid: "uid-consumer",
                execution_engine: ExecutionEngine::Duckdb,
                references: refs,
                connection_bindings: &[],
                workspace: ws,
                sources: &[],
                available_connections: &[],
                kind: ResolveKind::Export {
                    published_ids: vec!["q_local".into()],
                },
            })
        };
        let lowered = resolve(&consumer.references, &consumer.workspace).expect("lower");
        assert!(lowered.provenance_json.is_some());
        let provenance = lowered.provenance_json.clone().unwrap();
        assert!(provenance.contains("uid-owner"));
        assert!(!provenance.contains("SharedLib"));
        assert!(!provenance.contains("products.csv"));
        assert!(!provenance.contains("password"));

        let db = DbSession::new().expect("duckdb");
        let preview = preview_workspace(&db, &lowered.workspace, &[], &lowered.sources)
            .expect("preview");
        let preview_cols: Vec<String> = preview.columns.iter().map(|c| c.name.clone()).collect();
        let preview_set = row_multiset(&preview_cols, &preview.rows);
        let blob = format!("{preview_set:?}");
        assert!(blob.contains("Widget") && blob.contains("CAN-1"), "{blob}");
        assert!(!blob.contains("Decoy"), "consumer csv must not be read: {blob}");

        let seeds = collect_load_seeds(&db, &lowered.workspace, &[], &lowered.sources)
            .expect("seeds")
            .seeds;
        let export_a = root.join("export_a");
        let export_b = root.join("export_b");
        fs::create_dir_all(&export_a).unwrap();
        fs::create_dir_all(&export_b).unwrap();
        let produce = |dir: &Path| {
            DbtProducer
                .produce_routed_with_schema_and_sources(
                    "ref_e2e",
                    &lowered.workspace,
                    dir.to_str().unwrap(),
                    DbtTarget::V1,
                    ExecutionEngine::Duckdb,
                    DestinationKind::Duckdb,
                    "public",
                    &lowered.published_query_ids,
                    &seeds,
                    &lowered.sources,
                    &HashMap::new(),
                    lowered.provenance_json.as_deref(),
                )
                .expect("export")
        };
        let path_a = produce(&export_a);
        let path_b = produce(&export_b);
        let texts = |dir: &Path| -> BTreeMap<String, String> {
            let mut out = BTreeMap::new();
            for entry in walkdir_files(dir) {
                let rel = entry.strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/");
                if rel.contains("target/") || rel.ends_with("local.duckdb") || rel.ends_with(".log")
                {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(&entry) {
                    out.insert(rel, text);
                }
            }
            out
        };
        assert_eq!(texts(Path::new(&path_a)), texts(Path::new(&path_b)));
        let prov = fs::read_to_string(Path::new(&path_a).join("dwhq_provenance.json")).unwrap();
        assert_eq!(prov, provenance);

        let pg_dir = root.join("export_pg");
        fs::create_dir_all(&pg_dir).unwrap();
        let pg_path = DbtProducer
            .produce_routed_with_schema_and_sources(
                "ref_e2e",
                &lowered.workspace,
                pg_dir.to_str().unwrap(),
                DbtTarget::V1,
                ExecutionEngine::Duckdb,
                DestinationKind::Postgres,
                "public",
                &lowered.published_query_ids,
                &seeds,
                &lowered.sources,
                &HashMap::new(),
                lowered.provenance_json.as_deref(),
            )
            .expect("pg export");
        let profile = fs::read_to_string(Path::new(&pg_path).join("profiles.yml")).unwrap();
        assert!(profile.contains("alias: pg"), "{profile}");
        assert!(profile.contains("type: postgres"), "{profile}");
        let manifest = fs::read_to_string(Path::new(&pg_path).join(".dwhforge-export.json")).unwrap();
        assert!(manifest.contains("duckdb->postgres"), "{manifest}");

        if let Some(bin) = resolve_dbt_bin(&[]) {
            let built = dbt_build(&path_a, Some(&bin));
            assert!(built.ok, "dbt build failed:\n{}", built.log);
            let focus = lowered.workspace.query("q_local").unwrap();
            let mart = dbt_model_name(&lowered.workspace, focus, &lowered.published_query_ids);
            let duckdb_file = Path::new(&path_a).join("local.duckdb");
            let (wh_cols, wh_rows) = read_mart_table(&duckdb_file, &mart).expect("read mart");
            let fold = |s: &str| s.chars().map(|c| c.to_ascii_lowercase()).collect::<String>();
            let mut aligned = Vec::new();
            for row in &wh_rows {
                let mut out_row = Vec::new();
                for pc in &preview_cols {
                    let pf = fold(pc);
                    let idx = wh_cols.iter().position(|c| fold(c) == pf).expect("col");
                    out_row.push(row[idx].clone());
                }
                aligned.push(out_row);
            }
            let w_set = row_multiset(&preview_cols, &aligned);
            assert_eq!(preview_set, w_set, "preview vs dbt build\n{preview_set:?}\n{w_set:?}");

            if let Ok(dsn) = std::env::var("DWH_PG_DSN") {
                if !dsn.trim().is_empty() {
                    let mut env = HashMap::new();
                    env.insert("DWH_PG_DSN".into(), dsn);
                    let built_pg = dbt_build_with_env(&pg_path, Some(&bin), &env);
                    assert!(built_pg.ok, "postgres dbt build failed:\n{}", built_pg.log);
                }
            }
        } else {
            eprintln!("skip dbt build: dbt not installed");
        }

        {
            let e = &mut owner.workspace.key_maps[0].entries[0];
            e.to = "CAN-9".into();
            e.output_values = vec!["CAN-9".into()];
        }
        fs::write(&owner_path, owner.to_json_pretty().unwrap()).unwrap();
        let stale = resolve(&consumer.references, &consumer.workspace);
        let err = stale.expect_err("owner change must require refresh");
        assert!(err.contains("update available"), "{err}");

        let refreshed = refresh_reference(
            &ResolveInput {
                root_file: &consumer_path,
                project_uid: "uid-consumer",
                execution_engine: ExecutionEngine::Duckdb,
                references: &consumer.references,
                connection_bindings: &[],
                workspace: &consumer.workspace,
                sources: &[],
                available_connections: &[],
                kind: ResolveKind::ValidateAll,
            },
            &reference.id,
        )
        .expect("refresh");
        consumer.references = vec![refreshed];
        let again = resolve(&consumer.references, &consumer.workspace).expect("after refresh");
        let preview2 = preview_workspace(&db, &again.workspace, &[], &again.sources).expect("preview2");
        let cols2: Vec<String> = preview2.columns.iter().map(|c| c.name.clone()).collect();
        let set2 = row_multiset(&cols2, &preview2.rows);
        let blob2 = format!("{set2:?}");
        assert!(blob2.contains("CAN-9"), "{blob2}");
        assert!(!blob2.contains("CAN-1"), "{blob2}");
        let still = fs::read_to_string(&consumer_path).unwrap();
        assert!(!still.contains("CAN-9"), "refresh must not write the consumer file");

        let _ = fs::remove_dir_all(&root);
    }

    fn walkdir_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(cur) = stack.pop() {
            let Ok(rd) = fs::read_dir(&cur) else { continue };
            for ent in rd.flatten() {
                let path = ent.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out
    }
}
