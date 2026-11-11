//! Help Lab catalog + offline reconciliation flagship ([ADR-0039](../../../docs/adr/0039-help-lab-catalog.md)).

use dwh_pipeline::{
    parse_key_map_seed_csv, parse_key_map_seed_csv_full, KeyMapDef, QueryDef,
    TransformationStep, Workspace,
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
                vec![TransformationStep::LoadCsv { path: dim, path_kind: Default::default() }],
            ),
            q(
                "shipments",
                vec![TransformationStep::LoadCsv { path: shipments, path_kind: Default::default() }],
            ),
            q(
                "sales",
                vec![TransformationStep::LoadCsv { path: sales, path_kind: Default::default() }],
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

/// POS invoices ↔ vendor master — two example families:
/// 1) Exact same name, different country = different company (`ComputerParts
///    LLC` US≠DE; `Office Supply Co` US≠UK).
/// 2) Brand names with English LLM synonyms on name **and** region (`Nestlé
///    Waters` / `Danone Waters`; `NW bottled water`, `EU`/`RF`/`Russia`).
/// Mart `by_vendor_region`: vendor_name, region, SUM(qty).
pub fn demo_name_region_match(fixtures: &Path) -> Result<Workspace, String> {
    let invoices = lab_csv(fixtures, "name_region_match/pos_invoices.csv")?;
    let dim_vendor = lab_csv(fixtures, "name_region_match/dim_vendor.csv")?;
    let seed_body = fs::read_to_string(
        labs_dir(fixtures).join("name_region_match/map_pos_to_vendor_seed.csv"),
    )
    .map_err(|e| format!("read map_pos_to_vendor_seed.csv: {e}"))?;
    let entries = dwh_pipeline::parse_key_map_seed_csv_cols(
        &seed_body,
        &["vendor_label".into(), "region".into()],
        "vendor_id",
    )?;
    let mut map = KeyMapDef::new(
        "map_pos_to_vendor",
        "POS vendor_label+region → vendor_id (same name ≠ same company across regions)",
    );
    map.from_column = "vendor_label".into();
    map.from_columns = vec!["vendor_label".into(), "region".into()];
    map.to_column = "vendor_id".into();
    map.output_columns = vec!["vendor_id".into()];
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "pos_invoices",
                vec![TransformationStep::LoadCsv {
                    path: invoices,
                    path_kind: Default::default(),
                }],
            ),
            q(
                "dim_vendor",
                vec![TransformationStep::LoadCsv {
                    path: dim_vendor,
                    path_kind: Default::default(),
                }],
            ),
            // Exact dual-key Join — synonym rows (KomputerParts, USA, NW bottled water, RF) fail.
            q(
                "dirty_exact_pair",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_invoices".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_vendor".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["vendor_label".into(), "region".into()],
                        right_on: vec!["vendor_name".into(), "region".into()],
                    },
                ],
            ),
            // Name-only Join fans ComputerParts / Nestlé / Danone across regions.
            q(
                "dirty_name_only",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_invoices".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_vendor".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["vendor_label".into()],
                        right_on: vec!["vendor_name".into()],
                    },
                ],
            ),
            q(
                "invoices_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_invoices".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "vendor_label".into(),
                        columns: vec!["vendor_label".into(), "region".into()],
                        output_column: Some("vendor_id".into()),
                        output_bindings: vec![],
                        as_of_column: None,
                        map_id: map.id.clone().into(),
                        entries: entries.clone(),
                    },
                    // Keep invoice region distinct so dim `region` is the grain key.
                    TransformationStep::RenameColumn {
                        from: "region".into(),
                        to: "invoice_region".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_vendor".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["vendor_id".into()],
                        right_on: vec!["vendor_id".into()],
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "invoice_id".into(),
                            "vendor_id".into(),
                            "vendor_name".into(),
                            "region".into(),
                            "qty".into(),
                            "category".into(),
                            "vendor_label".into(),
                            "invoice_region".into(),
                        ],
                    },
                ],
            ),
            // Target mart: same vendor_name in Europe vs RUS stay separate rows.
            q(
                "by_vendor_region",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "invoices_mapped".into(),
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec!["vendor_name".into(), "region".into()],
                        aggregates: vec!["sum(qty) as qty".into()],
                    },
                    TransformationStep::SortBy {
                        column: "vendor_name".into(),
                        descending: false,
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_exact_pair".into(),
        key_maps: vec![map],
    })
}

/// Two independent catalogs (crm_id/name ↔ erp_id/name). Match by name in Join Lens;
/// durable seed is id→id with name attrs for editing ([ADR-0028](../../../docs/adr/0028-keymap-stewardship-shapes.md)).
pub fn demo_name_id_match(fixtures: &Path) -> Result<Workspace, String> {
    let crm = lab_csv(fixtures, "name_id_match/crm_products.csv")?;
    let erp = lab_csv(fixtures, "name_id_match/erp_products.csv")?;
    let seed_body =
        fs::read_to_string(labs_dir(fixtures).join("name_id_match/map_crm_to_erp_seed.csv"))
            .map_err(|e| format!("read map_crm_to_erp_seed.csv: {e}"))?;
    let entries = parse_key_map_seed_csv_full(
        &seed_body,
        &["from".into()],
        "to",
        &["from_name".into(), "to_name".into()],
    )?;
    let mut map = KeyMapDef::new("map_crm_to_erp", "CRM id → ERP id (matched by name)");
    map.editable_columns = vec!["from_name".into(), "to_name".into()];
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "crm_products",
                vec![TransformationStep::LoadCsv { path: crm, path_kind: Default::default() }],
            ),
            q(
                "erp_products",
                vec![TransformationStep::LoadCsv { path: erp, path_kind: Default::default() }],
            ),
            // Ids never collide across systems — Auto compares sibling `name` labels.
            q(
                "dirty_by_id",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "crm_products".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "erp_products".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["crm_id".into()],
                        right_on: vec!["erp_id".into()],
                    },
                ],
            ),
            q(
                "crm_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "crm_products".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "crm_id".into(),
                        columns: vec![],
                        output_column: None,
                        output_bindings: vec![],
                        as_of_column: None,
                        map_id: map.id.clone().into(),
                        entries: entries.clone(),
                    },
                    TransformationStep::RenameColumn {
                        from: "crm_id".into(),
                        to: "erp_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "erp_products".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["erp_id".into()],
                        right_on: vec!["erp_id".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_by_id".into(),
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

    #[test]
    fn name_id_match_builds_with_name_attrs() {
        let cards = load_help_lab_catalog(&fixtures()).expect("catalog");
        assert!(cards.iter().any(|c| c.id == "name_id_match"));
        let ws = demo_name_id_match(&fixtures()).expect("name_id_match");
        assert_eq!(ws.focus_query_id, "dirty_by_id");
        let map = &ws.key_maps[0];
        assert_eq!(map.id, "map_crm_to_erp");
        assert_eq!(
            map.editable_columns,
            vec!["from_name".to_string(), "to_name".to_string()]
        );
        assert!(!map.entries.is_empty());
        assert!(map.entries[0].attrs.contains_key("from_name"));
        assert!(ws.query("crm_mapped").is_some());
        assert!(ws.query("dirty_by_id").is_some());
    }

    #[test]
    fn name_region_match_builds_composite_map() {
        let cards = load_help_lab_catalog(&fixtures()).expect("catalog");
        assert!(cards.iter().any(|c| c.id == "name_region_match"));
        let ws = demo_name_region_match(&fixtures()).expect("name_region_match");
        assert_eq!(ws.focus_query_id, "dirty_exact_pair");
        let map = &ws.key_maps[0];
        assert_eq!(map.id, "map_pos_to_vendor");
        assert_eq!(
            map.from_columns,
            vec!["vendor_label".to_string(), "region".to_string()]
        );
        assert_eq!(map.entries.len(), 9);
        assert!(ws.query("dirty_exact_pair").is_some());
        assert!(ws.query("dirty_name_only").is_some());
        assert!(ws.query("invoices_mapped").is_some());
        assert!(ws.query("by_vendor_region").is_some());

        let mut preview_ws = ws.clone();
        preview_ws.focus_query_id = "by_vendor_region".into();
        let db = dwh_engine::DbSession::new().expect("duckdb");
        let out = dwh_engine::preview_workspace(&db, &preview_ws, &[], &[]).expect("preview");
        let names: Vec<_> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["vendor_name", "region", "qty"]);

        let regions_for = |want: &str| -> Vec<String> {
            out.rows
                .iter()
                .filter_map(|row| {
                    let name = row.first().and_then(|v| v.as_str())?;
                    if name != want {
                        return None;
                    }
                    row.get(1).and_then(|v| v.as_str()).map(str::to_string)
                })
                .collect()
        };

        let computer_parts = regions_for("ComputerParts LLC");
        assert_eq!(
            computer_parts.len(),
            2,
            "ComputerParts LLC US≠DE must stay separate: {computer_parts:?}"
        );
        assert!(computer_parts.iter().any(|r| r == "US"));
        assert!(computer_parts.iter().any(|r| r == "DE"));

        let nestle = regions_for("Nestlé Waters");
        assert_eq!(
            nestle.len(),
            2,
            "Nestlé Waters Europe≠RUS must stay separate: {nestle:?}"
        );
        assert!(nestle.iter().any(|r| r == "Europe"));
        assert!(nestle.iter().any(|r| r == "RUS"));
    }
}
