//! Self-contained, offline Mapping Quality lab. No changes to Join Lens or matching policy.
mod data;

use dwh_pipeline::{JoinType, KeyMapDef, QueryDef, TransformationStep as Step, Workspace};
use std::path::Path;

pub const JOIN_QUERY: &str = "quality_joined";
pub const SUMMARY_QUERY: &str = "quality_summary";
pub const TARGETS_QUERY: &str = "quality_targets";
pub const MAP_ID: &str = "map_quality_products";

fn query(id: &str, steps: Vec<Step>) -> QueryDef {
    QueryDef {
        id: id.into(),
        name: id.into(),
        steps,
        execution: Default::default(),
    }
}

/// Stable ids are a prototype UI contract, not a new project IR or universal profiler.
pub fn load(cache: &Path) -> Result<Workspace, String> {
    let files = data::ensure(cache).map_err(|error| format!("Mapping quality demo: {error}"))?;
    let entries = dwh_pipeline::parse_key_map_seed_csv(
        &std::fs::read_to_string(&files.mapping).map_err(|error| error.to_string())?,
    )?;
    let mut map = KeyMapDef::new(MAP_ID, "Commercial products → production catalog");
    map.entries = entries;
    Ok(Workspace {
        queries: vec![
            query(
                "quality_commercial",
                vec![Step::LoadCsv {
                    path: files.commercial.to_string_lossy().into_owned(),
                    path_kind: Default::default(),
                }],
            ),
            query(
                "quality_catalog",
                vec![Step::LoadCsv {
                    path: files.catalog.to_string_lossy().into_owned(),
                    path_kind: Default::default(),
                }],
            ),
            query(
                JOIN_QUERY,
                vec![
                    Step::FromQuery {
                        query_id: "quality_commercial".into(),
                    },
                    Step::DeriveColumn {
                        name: "canonical_key".into(),
                        expression: "commercial_sku".into(),
                        mode: Default::default(),
                        op: None,
                        sql_dialect: None,
                    },
                    // Empty step entries: preview/compile resolve from workspace.key_maps
                    // (avoid duplicating 95k rows in the IPC workspace payload).
                    Step::ApplyKeyMap {
                        column: "canonical_key".into(),
                        columns: vec![],
                        output_column: None,
                        output_bindings: vec![],
                        as_of_column: None,
                        map_id: MAP_ID.into(),
                        entries: vec![],
                    },
                    Step::Join {
                        right_query_id: "quality_catalog".into(),
                        join_type: JoinType::Left,
                        left_on: vec!["canonical_key".into()],
                        right_on: vec!["product_id".into()],
                    },
                ],
            ),
            query(
                SUMMARY_QUERY,
                vec![Step::SqlModel {
                    raw_sql: SUMMARY_SQL.into(),
                }],
            ),
            query(
                TARGETS_QUERY,
                vec![Step::SqlModel {
                    raw_sql: TARGETS_SQL.into(),
                }],
            ),
        ],
        focus_query_id: JOIN_QUERY.into(),
        key_maps: vec![map],
    })
}

// Differences are observations, not verdicts. The decision basis is an explicit
// synthetic annotation; these scores were not produced by a real matcher or LLM.
const SUMMARY_SQL: &str = r#"
WITH observed AS (
 SELECT *,
 CASE WHEN target_family IS NULL THEN 'unmapped'
      WHEN source_family <> target_family THEN 'family_difference'
      WHEN source_grade <> target_grade THEN 'grade_difference'
      WHEN TRY_CAST(runner_up_gap AS DOUBLE) < 0.03 THEN 'close_alternative'
      WHEN decision_method = 'fuzzy' THEN 'similarity_only'
      ELSE 'aligned_attributes' END AS signal
 FROM {{query:quality_joined}}
)
SELECT source_family, COALESCE(target_family, 'Unmapped') AS target_family,
       source_grade, COALESCE(target_grade, '—') AS target_grade,
       decision_method, signal, COUNT(*) AS positions, SUM(COUNT(*)) OVER() AS total_positions,
       SUM(revenue) AS revenue,
       to_json(list_sort(list(commercial_sku))[1:6]) AS sample_keys
FROM observed
GROUP BY 1,2,3,4,5,6
ORDER BY 1,2,3,4,5,6
"#;

const TARGETS_SQL: &str = r#"
SELECT canonical_key, target_family, target_grade, COUNT(*) AS positions,
       COUNT(DISTINCT source_grade) AS source_grades,
       COUNT(DISTINCT packaging) AS packaging_variants,
       SUM(revenue) AS revenue,
       to_json(list_sort(list(commercial_sku))[1:6]) AS sample_keys
FROM {{query:quality_joined}}
WHERE target_family IS NOT NULL
GROUP BY 1,2,3
ORDER BY positions DESC, canonical_key
LIMIT 12
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lab_has_real_mapping_and_compilable_projections() {
        let root = std::env::temp_dir().join(format!("dwh-quality-test-{}", std::process::id()));
        let workspace = load(&root).expect("generate lab");
        assert_eq!(workspace.key_maps[0].entries.len(), 95_000);
        assert_eq!(dwh_pipeline::topo_queries(&workspace).unwrap().len(), 5);
        for id in [SUMMARY_QUERY, TARGETS_QUERY] {
            let mut selected = workspace.clone();
            selected.focus_query_id = id.into();
            let sql = dwh_pipeline::GraphCompiler::new(&selected)
                .to_sql(false)
                .unwrap();
            assert!(!sql.contains("{{query:"));
            assert!(sql.contains("read_csv"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
