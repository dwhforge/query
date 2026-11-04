//! Full-input acceptance test for Help → Mapping quality (requires the normal DuckDB runtime).
use dwh_host::demo_mapping_quality::{self, SUMMARY_QUERY, TARGETS_QUERY};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

fn as_count(v: &JsonValue) -> u64 {
    v.as_u64()
        .or_else(|| v.as_f64().map(|f| f as u64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .expect("aggregate count")
}

#[test]
fn mapping_quality_counts_all_positions_and_preserves_patterns() {
    let root = std::env::temp_dir().join(format!("dwh-quality-engine-{}", std::process::id()));
    let mut workspace = demo_mapping_quality::load(&root).unwrap();
    let session = dwh_engine::DbSession::new().unwrap();
    workspace.focus_query_id = SUMMARY_QUERY.into();
    let result = dwh_engine::preview_workspace(&session, &workspace, &[], &[]).unwrap();
    let column = |name: &str| {
        result
            .columns
            .iter()
            .position(|column| column.name == name)
            .unwrap()
    };
    let positions = column("positions");
    let signal = column("signal");
    let total = column("total_positions");
    let mut counts = BTreeMap::<String, u64>::new();
    for row in &result.rows {
        assert_eq!(as_count(&row[total]), 100_000);
        *counts
            .entry(row[signal].as_str().unwrap().into())
            .or_default() += as_count(&row[positions]);
    }
    assert_eq!(counts.values().sum::<u64>(), 100_000);
    assert_eq!(counts["unmapped"], 5_000);
    assert_eq!(counts["family_difference"], 10_000);
    assert_eq!(counts["grade_difference"], 20_000);
    assert_eq!(counts["close_alternative"], 10_000);
    assert_eq!(counts["similarity_only"], 10_000);
    assert_eq!(counts["aligned_attributes"], 45_000);
    assert!(
        result.rows.len() < 100,
        "the UI gets aggregates, not dictionary rows"
    );
    workspace.focus_query_id = TARGETS_QUERY.into();
    let hotspots = dwh_engine::preview_workspace(&session, &workspace, &[], &[]).unwrap();
    assert_eq!(hotspots.rows.len(), 12);
    let field = |name: &str| {
        hotspots
            .columns
            .iter()
            .position(|column| column.name == name)
            .unwrap()
    };
    assert_eq!(
        as_count(&hotspots.rows[0][field("positions")]),
        10_017
    );
    assert_eq!(
        as_count(&hotspots.rows[0][field("source_grades")]),
        2
    );
    assert_eq!(
        as_count(&hotspots.rows[0][field("packaging_variants")]),
        4
    );
    std::fs::remove_dir_all(root).unwrap();
}
