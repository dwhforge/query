//! Help Lab catalog + offline reconciliation flagship ([ADR-0039](../../../docs/adr/0039-help-lab-catalog.md)).

use dwh_pipeline::{
    parse_key_map_seed_csv, KeyMapDef, QueryDef, TransformationStep, Workspace,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// One card in `fixtures/labs/catalog.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelpLabCard {
    pub id: String,
    pub track: String,
    pub title: String,
    pub tagline: String,
    #[serde(default)]
    pub teaches: Vec<String>,
    #[serde(default)]
    pub you_keep: Vec<String>,
    pub requires: String,
    #[serde(default)]
    pub featured: bool,
}

fn labs_dir(fixtures: &Path) -> PathBuf {
    fixtures.join("labs")
}

fn lab_csv(fixtures: &Path, rel: &str) -> Result<String, String> {
    let p = labs_dir(fixtures).join(rel);
    p.canonicalize()
        .map_err(|e| format!("lab fixture {rel}: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Load and validate the Help Lab catalog.
pub fn load_help_lab_catalog(fixtures: &Path) -> Result<Vec<HelpLabCard>, String> {
    let path = labs_dir(fixtures).join("catalog.json");
    let body = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let cards: Vec<HelpLabCard> = serde_json::from_str(&body)
        .map_err(|e| format!("parse catalog.json: {e}"))?;
    if cards.is_empty() {
        return Err("catalog.json is empty".into());
    }
    for c in &cards {
        if c.id.trim().is_empty() {
            return Err("catalog entry missing id".into());
        }
        if c.title.trim().is_empty() {
            return Err(format!("catalog entry '{}' missing title", c.id));
        }
    }
    Ok(cards)
}

fn q(id: &str, steps: Vec<TransformationStep>) -> QueryDef {
    QueryDef {
        id: id.into(),
        name: id.into(),
        steps,
        execution: Default::default(),
    }
}

/// Plant shipments ↔ commercial sales — partial SKU map ([ADR-0039](../../../docs/adr/0039-help-lab-catalog.md)).
pub fn demo_recon_ship_sales(fixtures: &Path) -> Result<Workspace, String> {
    let shipments = lab_csv(fixtures, "recon_ship_sales/shipments.csv")?;
    let sales = lab_csv(fixtures, "recon_ship_sales/sales.csv")?;
    let dim = lab_csv(fixtures, "recon_ship_sales/dim_product.csv")?;
    let seed_body = fs::read_to_string(labs_dir(fixtures).join("recon_ship_sales/map_sku_seed.csv"))
        .map_err(|e| format!("read map_sku_seed.csv: {e}"))?;
    let entries = parse_key_map_seed_csv(&seed_body)?;
    let mut map = KeyMapDef::new("map_sku", "Commercial SKU → plant product");
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "dim_product",
                vec![TransformationStep::LoadCsv { path: dim }],
            ),
            q(
                "shipments",
                vec![TransformationStep::LoadCsv { path: shipments }],
            ),
            q(
                "sales",
                vec![TransformationStep::LoadCsv { path: sales }],
            ),
            // Dirty: commercial codes ≠ plant product_id
            q(
                "dirty_recon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_product".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["commercial_sku".into()],
                        right_on: vec!["product_id".into()],
                    },
                ],
            ),
            q(
                "sales_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "commercial_sku".into(),
                        columns: vec![],
                        output_column: None,
                        output_bindings: vec![],
                        as_of_column: None,
                        map_id: map.id.clone().into(),
                        entries: entries.clone(),
                    },
                    TransformationStep::RenameColumn {
                        from: "commercial_sku".into(),
                        to: "product_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_product".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["product_id".into()],
                        right_on: vec!["product_id".into()],
                    },
                ],
            ),
            q(
                "ship_by_month",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "shipments".into(),
                    },
                    TransformationStep::RenameColumn {
                        from: "plant_sku".into(),
                        to: "product_id".into(),
                    },
                    TransformationStep::RenameColumn {
                        from: "qty_t".into(),
                        to: "ship_qty_t".into(),
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "product_id".into(),
                            "month".into(),
                            "ship_qty_t".into(),
                            "cost".into(),
                        ],
                    },
                ],
            ),
            q(
                "sales_by_month",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_mapped".into(),
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "product_id".into(),
                            "month".into(),
                            "qty_t".into(),
                            "revenue".into(),
                            "product_name".into(),
                            "family".into(),
                        ],
                    },
                    TransformationStep::RenameColumn {
                        from: "qty_t".into(),
                        to: "sales_qty_t".into(),
                    },
                ],
            ),
            q(
                "recon_by_month",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ship_by_month".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "sales_by_month".into(),
                        join_type: dwh_pipeline::JoinType::Full,
                        left_on: vec!["product_id".into(), "month".into()],
                        right_on: vec!["product_id".into(), "month".into()],
                    },
                    TransformationStep::DeriveColumn {
                        name: "qty_gap_t".into(),
                        expression: "coalesce(ship_qty_t, 0) - coalesce(sales_qty_t, 0)".into(),
                        mode: Default::default(),
                        op: None,
                        sql_dialect: None,
                    },
                    TransformationStep::SortBy {
                        column: "month".into(),
                        descending: false,
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_recon".into(),
        key_maps: vec![map],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    #[test]
    fn catalog_parses_and_includes_recon() {
        let cards = load_help_lab_catalog(&fixtures()).expect("catalog");
        assert!(cards.iter().any(|c| c.id == "recon_ship_sales"));
        assert!(cards.iter().any(|c| c.featured));
        let recon = cards.iter().find(|c| c.id == "recon_ship_sales").unwrap();
        assert!(!recon.you_keep.is_empty());
        assert_eq!(recon.requires, "offline");
    }

    #[test]
    fn recon_ship_sales_builds() {
        let ws = demo_recon_ship_sales(&fixtures()).expect("recon");
        assert_eq!(ws.focus_query_id, "dirty_recon");
        assert_eq!(ws.key_maps.len(), 1);
        assert_eq!(ws.key_maps[0].id, "map_sku");
        assert!(ws.key_maps[0].entries.len() >= 2);
        assert!(ws.query("recon_by_month").is_some());
        assert!(ws.query("sales_mapped").is_some());
    }
}
