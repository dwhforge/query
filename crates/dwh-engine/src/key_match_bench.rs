//! Reproducible comparison with the previous patch, kept out of production code.
//! cargo test -p dwh-engine --release benchmark_key_match -- --ignored --nocapture

use crate::key_match::{
    match_keys, CandidateSearch, FuzzyPair, KeyMatchOptions, MatchPolicy, MatchRecord,
};
use std::time::Instant;

const BASELINE_SQL: &str = include_str!("../../../scripts/stress/fuzzy_baseline.sql");

fn fixture(n: usize, kind: &str) -> (Vec<MatchRecord>, Vec<MatchRecord>) {
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let recipe = if kind == "ambiguous" && i % 50 == 1 {
            i - 1
        } else {
            i
        };
        left.push(MatchRecord {
            key: format!("SKU-{i:07}"),
            label: if kind == "dense" {
                format!(
                    "Receipe group{:06} variant{i:06} Arabica premium blend",
                    i / 16
                )
            } else {
                format!("Receipe {recipe:06} Arabica premium blend 500 g")
            },
        });
        right.push(MatchRecord {
            key: format!("TECH-{i:07}"),
            label: if kind == "dense" {
                format!(
                    "Recipe group{:06} variant{i:06} Arabica premium blend",
                    i / 16
                )
            } else {
                format!("Recipe {recipe:06} Arabica premium blend 500g")
            },
        });
    }
    (left, right)
}

fn load_baseline(conn: &duckdb::Connection, left: &[MatchRecord], right: &[MatchRecord]) {
    conn.execute_batch(
        "DROP TABLE IF EXISTS raw_l; DROP TABLE IF EXISTS raw_r;
        CREATE TABLE raw_l(id BIGINT, k VARCHAR, label VARCHAR);
        CREATE TABLE raw_r(id BIGINT, k VARCHAR, label VARCHAR);",
    )
    .unwrap();
    for (table, records) in [("raw_l", left), ("raw_r", right)] {
        let mut appender = conn.appender(table).unwrap();
        for (i, r) in records.iter().enumerate() {
            appender
                .append_row(duckdb::params![i as i64, r.key, r.label])
                .unwrap();
        }
        appender.flush().unwrap();
    }
}

fn run_baseline(conn: &duckdb::Connection) -> Vec<(String, String, f64, bool)> {
    // Include normalization/materialization in SQL time, as in the old endpoint.
    conn.execute_batch("DROP TABLE IF EXISTS __bench_l; DROP TABLE IF EXISTS __bench_r;
        CREATE TEMP TABLE __bench_l AS SELECT id,k,regexp_replace(lower(trim(label)), '[^\\p{L}\\p{N}]+', ' ', 'g') AS norm FROM raw_l;
        CREATE TEMP TABLE __bench_r AS SELECT id,k,regexp_replace(lower(trim(label)), '[^\\p{L}\\p{N}]+', ' ', 'g') AS norm FROM raw_r;").unwrap();
    let mut stmt = conn.prepare(BASELINE_SQL).unwrap();
    stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

fn assert_equivalent(rust: &[FuzzyPair], sql: &[(String, String, f64, bool)]) {
    assert_eq!(rust.len(), sql.len());
    for (r, s) in rust.iter().zip(sql) {
        assert_eq!((&r.from_key, &r.to_key, r.ambiguous), (&s.0, &s.1, s.3));
        assert!(
            (r.score - s.2).abs() < 1e-12,
            "score differs: {} / {}",
            r.score,
            s.2
        );
    }
}

#[test]
#[ignore = "performance benchmark; run explicitly in release mode"]
fn benchmark_key_match() {
    let engine = std::env::var("DWH_MATCH_BENCH_ENGINE").unwrap_or_else(|_| "both".into());
    assert!(["both", "rust", "duckdb"].contains(&engine.as_str()));
    let conn = if engine != "rust" {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch("SET threads=4").unwrap();
        Some(conn)
    } else {
        None
    };
    println!("rows,fixture,rust_ms,duckdb_ms,proposals,ambiguous");
    for n in [1_000, 10_000, 100_000] {
        for kind in ["unique", "ambiguous", "dense"] {
            let (left, right) = fixture(n, kind);
            if let Some(conn) = &conn {
                load_baseline(conn, &left, &right);
            }
            // Three repetitions; no unreported warmup. Input loading is excluded
            // for both engines. Both timings include producing all output pairs.
            for _ in 0..3 {
                let started = Instant::now();
                let rust = if engine != "duckdb" {
                    match_keys(
                        &left,
                        &right,
                        KeyMatchOptions::default(),
                        MatchPolicy::Labels,
                        CandidateSearch::Indexed,
                    )
                } else {
                    Vec::new()
                };
                let rust_ms = started.elapsed().as_secs_f64() * 1000.0;
                let started = Instant::now();
                let sql = conn.as_ref().map(run_baseline).unwrap_or_default();
                let sql_ms = started.elapsed().as_secs_f64() * 1000.0;
                if engine == "both" {
                    assert_equivalent(&rust, &sql);
                }
                if engine == "rust" {
                    assert_eq!(rust.len(), n);
                }
                if engine == "duckdb" {
                    assert_eq!(sql.len(), n);
                }
                println!(
                    "{n},{},{rust_ms:.3},{sql_ms:.3},{},{}",
                    kind,
                    if engine == "duckdb" {
                        sql.len()
                    } else {
                        rust.len()
                    },
                    if engine == "duckdb" {
                        sql.iter().filter(|p| p.3).count()
                    } else {
                        rust.iter().filter(|p| p.ambiguous).count()
                    }
                );
            }
        }
    }
}
