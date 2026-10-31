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
                    steps: vec![TransformationStep::LoadCsv {
                        path: eu.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales_us".into(),
                    name: "sales_us".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: us.to_string_lossy().into(),
                    }],
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
        let seeds = collect_load_seeds(&db, &ws, &[], &[]).expect("seeds");
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
        let seeds = collect_load_seeds(&db, &ws, &[], &[]).expect("seeds");
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
}
