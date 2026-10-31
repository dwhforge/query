//! Extra KeyMap Help demos (readable business labs under fixtures/examples/).
//! Patterns: docs/keymap-workflows.md · scripts/examples/

use dwh_pipeline::{
    parse_key_map_seed_csv, parse_key_map_seed_csv_mode, KeyMapCsvMode, KeyMapDef, KeyMapStorage,
    QueryDef, TransformationStep, Workspace,
};
use std::fs;
use std::path::{Path, PathBuf};

const PG_CONN: &str = "conn_postgres";
const PG_SCHEMA: &str = "keymap_demo";

fn examples(fixtures: &Path) -> PathBuf {
    fixtures.join("examples")
}

fn ex_csv(fixtures: &Path, rel: &str) -> Result<String, String> {
    let p = examples(fixtures).join(rel);
    if !p.is_file() {
        return Err(format!(
            "Missing {rel} — run: python scripts/examples/generate_all.py"
        ));
    }
    Ok(p.to_string_lossy().into_owned())
}

fn ex_parquet(fixtures: &Path, rel: &str) -> Result<String, String> {
    let p = examples(fixtures).join(rel);
    if !p.is_file() {
        return Err(format!(
            "Missing {rel} — run: python scripts/examples/generate_all.py (parquet)"
        ));
    }
    Ok(p.to_string_lossy().into_owned())
}

fn read_seed_map(fixtures: &Path, rel: &str) -> Result<Vec<dwh_pipeline::KeyMapEntry>, String> {
    let body = fs::read_to_string(examples(fixtures).join(rel))
        .map_err(|e| format!("read {rel}: {e}"))?;
    parse_key_map_seed_csv(&body)
}

fn read_named_map(
    fixtures: &Path,
    rel: &str,
    from_col: &str,
    to_col: &str,
) -> Result<Vec<dwh_pipeline::KeyMapEntry>, String> {
    let body = fs::read_to_string(examples(fixtures).join(rel))
        .map_err(|e| format!("read {rel}: {e}"))?;
    parse_key_map_seed_csv_mode(
        &body,
        KeyMapCsvMode::Header {
            from_col,
            to_col,
        },
    )
}

fn load_pg(table: &str) -> TransformationStep {
    TransformationStep::LoadPostgres {
        connection_id: Some(PG_CONN.into()),
        connection_string: String::new(),
        schema: PG_SCHEMA.into(),
        table_name: table.into(),
    }
}

fn q(id: &str, steps: Vec<TransformationStep>) -> QueryDef {
    QueryDef {
        id: id.into(),
        name: id.into(),
        steps,
        execution: Default::default(),
    }
}

/// B2 crosswalk — grocery POS ↔ WMS (seed, offline CSV).
pub fn demo_keymap_crosswalk(fixtures: &Path) -> Result<Workspace, String> {
    let pos = ex_csv(fixtures, "crosswalk/pos_sales.csv")?;
    let wms = ex_csv(fixtures, "crosswalk/wms_moves.csv")?;
    let entries = read_seed_map(fixtures, "crosswalk/map_pos_to_wms_seed.csv")?;
    let mut map = KeyMapDef::new("map_pos_to_wms", "POS sku → WMS item");
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q("pos_sales", vec![TransformationStep::LoadCsv { path: pos }]),
            q("wms_moves", vec![TransformationStep::LoadCsv { path: wms }]),
            q(
                "dirty_join",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["sku_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
            q(
                "pos_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "sku_code".into(),
                        map_id: map.id.clone(),
                        entries: entries.clone(),
                    },
                    TransformationStep::RenameColumn {
                        from: "sku_code".into(),
                        to: "item_code".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["item_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_join".into(),
        key_maps: vec![map],
    })
}

/// B3 dual maps + dim_party master (seed). Edit dim then aliases — collision-safe vs one shared map.
pub fn demo_keymap_dual(fixtures: &Path) -> Result<Workspace, String> {
    let dim = ex_csv(fixtures, "dual/dim_party.csv")?;
    let covers = ex_csv(fixtures, "dual/pos_covers.csv")?;
    let invoices = ex_csv(fixtures, "dual/ap_invoices.csv")?;
    let sales_e = read_seed_map(fixtures, "dual/map_sales_alias.csv")?;
    let spend_e = read_seed_map(fixtures, "dual/map_spend_alias.csv")?;

    let mut map_sales = KeyMapDef::new("map_sales_alias", "POS brand → party_id");
    map_sales.entries = sales_e.clone();
    let mut map_spend = KeyMapDef::new("map_spend_alias", "AP vendor → party_id");
    map_spend.entries = spend_e.clone();

    Ok(Workspace {
        queries: vec![
            q("dim_party", vec![TransformationStep::LoadCsv { path: dim }]),
            q(
                "pos_covers",
                vec![TransformationStep::LoadCsv { path: covers }],
            ),
            q(
                "ap_invoices",
                vec![TransformationStep::LoadCsv { path: invoices }],
            ),
            q(
                "dirty_sales",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_covers".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["brand".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
            q(
                "sales_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_covers".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "brand".into(),
                        map_id: map_sales.id.clone(),
                        entries: sales_e,
                    },
                    TransformationStep::RenameColumn {
                        from: "brand".into(),
                        to: "party_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["party_id".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
            q(
                "spend_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ap_invoices".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "vendor_name".into(),
                        map_id: map_spend.id.clone(),
                        entries: spend_e,
                    },
                    TransformationStep::RenameColumn {
                        from: "vendor_name".into(),
                        to: "party_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["party_id".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_sales".into(),
        key_maps: vec![map_sales, map_spend],
    })
}

/// B4 channel synonyms (seed).
pub fn demo_keymap_codes(fixtures: &Path) -> Result<Workspace, String> {
    let sales = ex_csv(fixtures, "codes/ecommerce_sales.csv")?;
    let ch = read_seed_map(fixtures, "codes/map_channel.csv")?;
    let mut map = KeyMapDef::new("map_channel", "Channel code synonyms");
    map.entries = ch.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "ecommerce_sales",
                vec![TransformationStep::LoadCsv { path: sales }],
            ),
            q(
                "sales_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ecommerce_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "channel_code".into(),
                        map_id: map.id.clone(),
                        entries: ch,
                    },
                ],
            ),
        ],
        focus_query_id: "sales_canon".into(),
        key_maps: vec![map],
    })
}

/// B5 multi-hop store → region → country (seed).
pub fn demo_keymap_hop(fixtures: &Path) -> Result<Workspace, String> {
    let sales = ex_csv(fixtures, "hop/store_sales.csv")?;
    let e1 = read_seed_map(fixtures, "hop/map_store_to_region.csv")?;
    let e2 = read_seed_map(fixtures, "hop/map_region_to_country.csv")?;
    let mut m1 = KeyMapDef::new("map_store_to_region", "Store → city region");
    m1.entries = e1.clone();
    let mut m2 = KeyMapDef::new("map_region_to_country", "Region → country");
    m2.entries = e2.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "store_sales",
                vec![TransformationStep::LoadCsv { path: sales }],
            ),
            q(
                "with_country",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "store_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "store_code".into(),
                        map_id: m1.id.clone(),
                        entries: e1,
                    },
                    TransformationStep::RenameColumn {
                        from: "store_code".into(),
                        to: "region_id".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "region_id".into(),
                        map_id: m2.id.clone(),
                        entries: e2,
                    },
                    TransformationStep::RenameColumn {
                        from: "region_id".into(),
                        to: "country_code".into(),
                    },
                ],
            ),
        ],
        focus_query_id: "with_country".into(),
        key_maps: vec![m1, m2],
    })
}

/// R1 — PG sources + live source KeyMap (crosswalk). Needs load_postgres.py + conn_postgres.
pub fn demo_keymap_pg_crosswalk(_fixtures: &Path) -> Result<Workspace, String> {
    let mut map = KeyMapDef::new("map_pos_to_wms", "POS → WMS (Postgres)");
    map.storage = KeyMapStorage::Source {
        source: PG_SCHEMA.into(),
        table: "map_pos_to_wms".into(),
        connection_id: Some(PG_CONN.into()),
    };
    map.from_column = "pos_sku".into();
    map.to_column = "wms_item".into();
    map.editable_columns = vec!["product_name".into(), "confidence".into()];
    map.entries = vec![];

    Ok(Workspace {
        queries: vec![
            q("pos_sales", vec![load_pg("pos_sales")]),
            q("wms_moves", vec![load_pg("wms_moves")]),
            q(
                "dirty_join",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["sku_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
            q(
                "pos_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "sku_code".into(),
                        map_id: map.id.clone(),
                        entries: vec![],
                    },
                    TransformationStep::RenameColumn {
                        from: "sku_code".into(),
                        to: "item_code".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["item_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_join".into(),
        key_maps: vec![map],
    })
}

/// R1 — PG dual maps (source) + dim_party master editable in WH.
pub fn demo_keymap_pg_dual(fixtures: &Path) -> Result<Workspace, String> {
    // Snapshot for preview fallback; live SoT is PG after load.
    let sales_e = read_named_map(
        fixtures,
        "dual/map_sales_alias_pg.csv",
        "alias_name",
        "party_id",
    )
    .unwrap_or_default();
    let spend_e = read_named_map(
        fixtures,
        "dual/map_spend_alias_pg.csv",
        "legal_name",
        "party_id",
    )
    .unwrap_or_default();

    let mut map_sales = KeyMapDef::new("map_sales_alias", "POS brand → party (PG)");
    map_sales.storage = KeyMapStorage::Source {
        source: PG_SCHEMA.into(),
        table: "map_sales_alias".into(),
        connection_id: Some(PG_CONN.into()),
    };
    map_sales.from_column = "alias_name".into();
    map_sales.to_column = "party_id".into();
    map_sales.editable_columns = vec!["note".into()];
    map_sales.entries = vec![];

    let mut map_spend = KeyMapDef::new("map_spend_alias", "AP vendor → party (PG)");
    map_spend.storage = KeyMapStorage::Source {
        source: PG_SCHEMA.into(),
        table: "map_spend_alias".into(),
        connection_id: Some(PG_CONN.into()),
    };
    map_spend.from_column = "legal_name".into();
    map_spend.to_column = "party_id".into();
    map_spend.editable_columns = vec!["note".into()];
    map_spend.entries = vec![];

    let _ = (sales_e, spend_e);

    Ok(Workspace {
        queries: vec![
            q("dim_party", vec![load_pg("dim_party")]),
            q("pos_covers", vec![load_pg("pos_covers")]),
            q("ap_invoices", vec![load_pg("ap_invoices")]),
            q(
                "dirty_sales",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_covers".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["brand".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
            q(
                "sales_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_covers".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "brand".into(),
                        map_id: map_sales.id.clone(),
                        entries: vec![],
                    },
                    TransformationStep::RenameColumn {
                        from: "brand".into(),
                        to: "party_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["party_id".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
            q(
                "spend_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ap_invoices".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "vendor_name".into(),
                        map_id: map_spend.id.clone(),
                        entries: vec![],
                    },
                    TransformationStep::RenameColumn {
                        from: "vendor_name".into(),
                        to: "party_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_party".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["party_id".into()],
                        right_on: vec!["party_id".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "dirty_sales".into(),
        key_maps: vec![map_sales, map_spend],
    })
}

/// storage=ref — map rows live as a query/model; KeyMap binds ref.
pub fn demo_keymap_ref(fixtures: &Path) -> Result<Workspace, String> {
    let sales = ex_csv(fixtures, "codes/ecommerce_sales.csv")?;
    let map_csv = ex_csv(fixtures, "codes/map_channel.csv")?;
    let entries = read_seed_map(fixtures, "codes/map_channel.csv")?;

    let mut map = KeyMapDef::new("map_channel", "Channel map via ref(model)");
    map.storage = KeyMapStorage::Ref {
        model: "map_channel".into(),
    };
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "map_channel",
                vec![TransformationStep::LoadCsv { path: map_csv }],
            ),
            q(
                "ecommerce_sales",
                vec![TransformationStep::LoadCsv { path: sales }],
            ),
            q(
                "sales_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ecommerce_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "channel_code".into(),
                        map_id: map.id.clone(),
                        entries,
                    },
                ],
            ),
        ],
        focus_query_id: "sales_canon".into(),
        key_maps: vec![map],
    })
}

/// R2 — POS parquet + WMS/map Postgres; engine duckdb → dest postgres.
pub fn demo_keymap_mixed(fixtures: &Path) -> Result<Workspace, String> {
    let pos_pq = ex_parquet(fixtures, "crosswalk/pos_sales.parquet")?;
    let mut map = KeyMapDef::new("map_pos_to_wms", "POS → WMS (PG map, parquet fact)");
    map.storage = KeyMapStorage::Source {
        source: PG_SCHEMA.into(),
        table: "map_pos_to_wms".into(),
        connection_id: Some(PG_CONN.into()),
    };
    map.from_column = "pos_sku".into();
    map.to_column = "wms_item".into();
    map.editable_columns = vec!["product_name".into(), "confidence".into()];
    map.entries = vec![];

    Ok(Workspace {
        queries: vec![
            q(
                "pos_sales",
                vec![TransformationStep::LoadParquet {
                    path: pos_pq,
                    connection_id: None,
                }],
            ),
            q("wms_moves", vec![load_pg("wms_moves")]),
            q(
                "pos_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "sku_code".into(),
                        map_id: map.id.clone(),
                        entries: vec![],
                    },
                    TransformationStep::RenameColumn {
                        from: "sku_code".into(),
                        to: "item_code".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["item_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "pos_mapped".into(),
        key_maps: vec![map],
    })
}

/// R3 — parquet in / duckdb out / seed map.
pub fn demo_keymap_parquet(fixtures: &Path) -> Result<Workspace, String> {
    let pos = ex_parquet(fixtures, "crosswalk/pos_sales.parquet")?;
    let wms = ex_parquet(fixtures, "crosswalk/wms_moves.parquet")?;
    let entries = read_seed_map(fixtures, "crosswalk/map_pos_to_wms_seed.csv")?;
    let mut map = KeyMapDef::new("map_pos_to_wms", "POS → WMS (seed, parquet facts)");
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q(
                "pos_sales",
                vec![TransformationStep::LoadParquet {
                    path: pos,
                    connection_id: None,
                }],
            ),
            q(
                "wms_moves",
                vec![TransformationStep::LoadParquet {
                    path: wms,
                    connection_id: None,
                }],
            ),
            q(
                "pos_mapped",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "pos_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "sku_code".into(),
                        map_id: map.id.clone(),
                        entries,
                    },
                    TransformationStep::RenameColumn {
                        from: "sku_code".into(),
                        to: "item_code".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "wms_moves".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["item_code".into(), "day".into()],
                        right_on: vec!["item_code".into(), "day".into()],
                    },
                ],
            ),
        ],
        focus_query_id: "pos_mapped".into(),
        key_maps: vec![map],
    })
}

/// R1 seed map while facts are Postgres (seed SoT, WH sources).
pub fn demo_keymap_pg_seed(fixtures: &Path) -> Result<Workspace, String> {
    let entries = read_seed_map(fixtures, "codes/map_channel.csv")?;
    let mut map = KeyMapDef::new("map_channel", "Channel synonyms (seed) on PG sales");
    map.storage = KeyMapStorage::Seed;
    map.entries = entries.clone();

    Ok(Workspace {
        queries: vec![
            q("ecommerce_sales", vec![load_pg("ecommerce_sales")]),
            q(
                "sales_canon",
                vec![
                    TransformationStep::FromQuery {
                        query_id: "ecommerce_sales".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "channel_code".into(),
                        map_id: map.id.clone(),
                        entries,
                    },
                ],
            ),
        ],
        focus_query_id: "sales_canon".into(),
        key_maps: vec![map],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    #[test]
    fn offline_labs_load() {
        let f = fixtures();
        demo_keymap_crosswalk(&f).expect("crosswalk");
        demo_keymap_dual(&f).expect("dual");
        demo_keymap_codes(&f).expect("codes");
        demo_keymap_hop(&f).expect("hop");
        demo_keymap_ref(&f).expect("ref");
        demo_keymap_parquet(&f).expect("parquet");
    }
}
