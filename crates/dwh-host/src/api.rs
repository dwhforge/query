//! Command dispatch — Electron IPC → JSON-RPC (camelCase args).

use crate::commands;
use crate::connections_io;
use crate::dbt_setup;
use crate::secrets_io;
use crate::settings_io::{self, AppSettings};
use dwh_engine::{
    blame_unmatched_key as run_blame_unmatched_key, clear_join_prepare as run_clear_join_prepare,
    prepare_workspace as run_prepare_workspace,
    describe_postgres_object as run_describe_postgres_object,
    describe_workspace as run_describe_workspace, explain_join_key as run_explain_join_key,
    explain_join_rows as run_explain_join_rows, join_diagnostics as run_join_diagnostics,
    join_key_fuzzy_suggest_on as run_join_key_fuzzy_suggest_on,
    join_key_near_miss as run_join_key_near_miss,
    join_prepare_status as run_join_prepare_status, list_postgres_objects as run_list_postgres_objects,
    ensure_join_sides_materialized as run_ensure_join_sides,
    prepare_join_inputs_with_progress as run_prepare_join_inputs,
    preview_pipeline as run_preview_steps,
    preview_prepared_join_side_filtered as run_preview_prepared_join_side_filtered,
    preview_workspace_limited as run_preview_workspace_limited,
    set_extensions_dir, set_prepare_progress, test_postgres_connection as run_test_postgres_connection,
    BlameUnmatchedKeyResult,
    DbSession, ExplainJoinKeyResult, ExplainJoinRowsResult, JoinDiagnostics, JoinKeyFuzzySuggest,
    JoinKeyNearMiss, JoinKeySide, JoinKeyTuple, JoinPrepareProgress, JoinPrepareResult,
    JoinPrepareStatus, PostgresColumn, PostgresObject, PreviewResult, QueryCancelHandle,
    PREVIEW_SAMPLE_LIMIT,
};
use dwh_pipeline::{
    dbt_build_with_env, dbt_env_from_connections, dbt_parse_with_env,
    copy_referenced_object, list_export_tree as walk_export_tree, make_project_reference,
    preview_dbt_model_sql_with_seeds_and_sources, push_key_map_to_export, reference_consumers,
    reference_statuses, refresh_reference, relink_reference, resolve_dbt_bin, resolve_operation,
    remove_key_map_from_export, sync_key_maps_from_export, ConnectionBinding, ConnectionDef,
    CopiedObject, DbtProducer, DbtTarget, ExecutionEngine, ExportResult, KeyMapDef,
    KeyMapSyncResult, LoweredOperation, ObjectKind, ObjectTarget, PreviewDbtModel,
    ProjectReference, QueryDef, ResolveInput, ResolveKind, SourceDef, TransformationStep,
    WarehouseDialect, Workspace,
};
use crate::error::{HostError, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;

static FIXTURES_DIR: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AppSession {
    #[serde(default)]
    last_project_path: Option<String>,
}

fn session_file() -> Result<PathBuf, String> {
    Ok(secrets_io::dwh_home_dir()?.join("session.json"))
}

fn remember_project_path(path: &str) -> Result<(), String> {
    let file = session_file()?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let session = AppSession {
        last_project_path: Some(path.to_string()),
    };
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

fn fixtures_dir_complete(dir: &Path) -> bool {
    dir.join("sample.csv").is_file()
        && dir.join("dim_region.csv").is_file()
        && dir.join("sales_eu.csv").is_file()
        && dir.join("sales_us.csv").is_file()
        && dir.join("sparse_sales.csv").is_file()
        && dir.join("dim_channel.csv").is_file()
}

fn set_fixtures_dir(dir: PathBuf) {
    let _ = FIXTURES_DIR.set(dir);
}

/// Resolve extensions + fixtures from env / beside binary / repo.
pub fn configure_paths() {
    if let Ok(ext) = std::env::var("DWH_EXTENSIONS_DIR") {
        let p = PathBuf::from(ext);
        if p.is_dir() {
            eprintln!("[dwh-host] extensions (env): {}", p.display());
            set_extensions_dir(p);
        }
    } else if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("extensions"),
                parent.join("resources").join("extensions"),
            ] {
                if cand.is_dir() {
                    eprintln!("[dwh-host] extensions: {}", cand.display());
                    set_extensions_dir(cand);
                    break;
                }
            }
        }
    }
    if FIXTURES_DIR.get().is_none() {
        // fall through — find later
    }

    if let Ok(fx) = std::env::var("DWH_FIXTURES_DIR") {
        let p = PathBuf::from(fx);
        if fixtures_dir_complete(&p) {
            eprintln!("[dwh-host] fixtures (env): {}", p.display());
            set_fixtures_dir(p);
            return;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("fixtures"),
                parent.join("resources").join("fixtures"),
            ] {
                if fixtures_dir_complete(&cand) {
                    eprintln!("[dwh-host] fixtures: {}", cand.display());
                    set_fixtures_dir(cand);
                    return;
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    if fixtures_dir_complete(&dev) {
        eprintln!("[dwh-host] fixtures (dev): {}", dev.display());
        set_fixtures_dir(dev);
    }
    let dev_ext = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extensions");
    if std::env::var_os("DWH_EXTENSIONS_DIR").is_none() && dev_ext.is_dir() {
        set_extensions_dir(dev_ext);
    }
}

fn find_fixtures_dir() -> Result<PathBuf, String> {
    if let Some(dir) = FIXTURES_DIR.get() {
        if fixtures_dir_complete(dir) {
            return Ok(dir.clone());
        }
    }
    configure_paths();
    FIXTURES_DIR
        .get()
        .cloned()
        .filter(|d| fixtures_dir_complete(d))
        .ok_or_else(|| {
            "Could not find fixtures/ (sample, dim_region, sales_eu, sales_us)".into()
        })
}

fn dbt_bin_candidates() -> Vec<PathBuf> {
    let mut extra = Vec::new();
    // ADR-0021: custom venv from Options first when set.
    if let Ok(settings) = settings_io::load_settings() {
        let venv = settings.dbt_venv_path.trim();
        if !venv.is_empty() {
            extra.push(settings_io::dbt_bin_in_venv(Path::new(venv)));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            extra.push(parent.join("dbt-venv/bin/dbt"));
            extra.push(parent.join("resources").join("dbt-venv/bin/dbt"));
        }
    }
    if let Ok(home) = secrets_io::dwh_home_dir() {
        extra.push(home.join("dbt-venv/bin/dbt"));
    }
    extra.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dbt-venv/bin/dbt"));
    extra
}

fn fixture_csv(fixtures: &Path, name: &str) -> Result<String, String> {
    fixtures
        .join(name)
        .canonicalize()
        .map_err(|e| format!("fixture {name}: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

fn demo_sales(fixtures: &Path) -> Result<Workspace, String> {
    let fact = fixture_csv(fixtures, "sample.csv")?;
    let dim = fixture_csv(fixtures, "dim_region.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "dim_region".into(),
                name: "dim_region".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv { path: fact }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_clean".into(),
                name: "sales_clean".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::RenameColumn {
                        from: "amount".into(),
                        to: "revenue".into(),
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "date".into(),
                            "region".into(),
                            "revenue".into(),
                            "qty".into(),
                        ],
                    },
                    TransformationStep::DeriveColumn {
                        name: "amount_per_unit".into(),
                        expression: "revenue / nullif(qty, 0)".into(),
                        mode: Default::default(),
                        op: None,
                        sql_dialect: None,
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "fact_sales".into(),
                name: "fact_sales".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_region".into(),
                        join_type: dwh_pipeline::JoinType::Inner,
                        left_on: vec!["region".into()],
                        right_on: vec!["region".into()],
                    },
                    // Mart projection — Join Lens still shows full left/right parents
                    // (e.g. date on left) even when dropped from the result.
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "region".into(),
                            "amount".into(),
                            "qty".into(),
                            "region_name".into(),
                        ],
                    },
                    TransformationStep::Filter {
                        condition: "amount > 1000".into(),
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "top_sales".into(),
                name: "top_sales".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::SortBy {
                        column: "qty".into(),
                        descending: true,
                    },
                    TransformationStep::Limit { n: 10 },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "top_by_region".into(),
                name: "top_by_region".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "fact_sales".into(),
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec!["region".into()],
                        aggregates: vec![
                            "sum(qty) as qty".into(),
                            "sum(amount) as amount".into(),
                            "count(*) as n_rows".into(),
                        ],
                    },
                    TransformationStep::SortBy {
                        column: "qty".into(),
                        descending: true,
                    },
                    TransformationStep::Limit { n: 10 },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "top_by_region".into(),
        key_maps: vec![],
    })
}

fn demo_union(fixtures: &Path) -> Result<Workspace, String> {
    let eu = fixture_csv(fixtures, "sales_eu.csv")?;
    let us = fixture_csv(fixtures, "sales_us.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "sales_eu".into(),
                name: "sales_eu".into(),
                steps: vec![TransformationStep::LoadCsv { path: eu }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_us".into(),
                name: "sales_us".into(),
                steps: vec![TransformationStep::LoadCsv { path: us }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_all".into(),
                name: "sales_all".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_eu".into(),
                    },
                    TransformationStep::Append {
                        other_query_ids: vec!["sales_us".into()],
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "by_region".into(),
                name: "by_region".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_all".into(),
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec!["region".into()],
                        aggregates: vec![
                            "sum(qty) as qty".into(),
                            "sum(amount) as amount".into(),
                            "count(*) as n_rows".into(),
                        ],
                    },
                    TransformationStep::SortBy {
                        column: "amount".into(),
                        descending: true,
                    },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "by_region".into(),
        key_maps: vec![],
    })
}

fn demo_sql(fixtures: &Path) -> Result<Workspace, String> {
    let fact = fixture_csv(fixtures, "sample.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "calendar".into(),
                name: "calendar".into(),
                steps: vec![TransformationStep::SqlModel {
                    raw_sql: "select * from (values \
                        (date '2024-01-01', 'EU'), \
                        (date '2024-01-02', 'US'), \
                        (date '2024-01-03', 'EU'), \
                        (date '2024-01-04', 'APAC'), \
                        (date '2024-01-05', 'EU'), \
                        (date '2024-01-06', 'US'), \
                        (date '2024-01-07', 'EU'), \
                        (date '2024-01-08', 'APAC'), \
                        (date '2024-01-09', 'EU'), \
                        (date '2024-01-10', 'US')\
                    ) as t(day, region)"
                        .into(),
                }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales".into(),
                name: "sales".into(),
                steps: vec![TransformationStep::LoadCsv { path: fact }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_enriched".into(),
                name: "sales_enriched".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales".into(),
                    },
                    TransformationStep::CustomSql {
                        raw_sql: "select *, row_number() over (\
                            partition by region order by amount desc\
                        ) as region_rank from {{prev_step}}"
                            .into(),
                    },
                ],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_top3".into(),
                name: "sales_top3".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_enriched".into(),
                    },
                    TransformationStep::Filter {
                        condition: "region_rank <= 3".into(),
                    },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "sales_enriched".into(),
        key_maps: vec![],
    })
}

/// Two sequential RIGHT OUTER joins — dims keep rows missing from sparse fact.
/// Select each Join step for Join Lens; second RIGHT can drop unmatched lefts
/// from the first join (RIGHT privileges the new right side).
fn demo_right_joins(fixtures: &Path) -> Result<Workspace, String> {
    let sparse = fixture_csv(fixtures, "sparse_sales.csv")?;
    let dim_r = fixture_csv(fixtures, "dim_region.csv")?;
    let dim_c = fixture_csv(fixtures, "dim_channel.csv")?;
    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "dim_region".into(),
                name: "dim_region".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim_r }],
                execution: Default::default(),
            },
            QueryDef {
                id: "dim_channel".into(),
                name: "dim_channel".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim_c }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sparse_sales".into(),
                name: "sparse_sales".into(),
                steps: vec![TransformationStep::LoadCsv { path: sparse }],
                execution: Default::default(),
            },
            QueryDef {
                id: "coverage".into(),
                name: "coverage".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sparse_sales".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_region".into(),
                        join_type: dwh_pipeline::JoinType::Right,
                        left_on: vec!["region".into()],
                        right_on: vec!["region".into()],
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_channel".into(),
                        join_type: dwh_pipeline::JoinType::Right,
                        left_on: vec!["channel".into()],
                        right_on: vec!["channel".into()],
                    },
                ],
                execution: Default::default(),
            },
        ],
        focus_query_id: "coverage".into(),
        key_maps: vec![],
    })
}

/// F&B company-name mapping lab (ADR-0020).
/// 15 brands × 60 days: `sales_daily` vs `res_consumption` spell names differently;
/// `dim_company` is canonical; KeyMap aliases → company_id; daily PnL → monthly.
/// Non-lexical sales leftovers (Auto / LLM): `DEO`→UBL (NYSE), SAB→ABEV (old name).
fn demo_keymap(fixtures: &Path) -> Result<Workspace, String> {
    use dwh_pipeline::{KeyMapDef, KeyMapEntry};
    let sales = fixture_csv(fixtures, "sales_daily.csv")?;
    let spend = fixture_csv(fixtures, "res_consumption.csv")?;
    let dim = fixture_csv(fixtures, "dim_company.csv")?;

    let mut company_map = KeyMapDef::new("map_company_alias", "F&B company aliases");
    // sales_daily `company` + res_consumption `org_name` → dim_company.company_id
    //
    // Intentionally LEFT UNMAPPED for Join Lens Auto / LLM (not fuzzy-resolvable):
    //   DEO                         → UBL   (NYSE ticker for Diageo; dim id is UBL)
    //   The South African Breweries → ABEV  (historical predecessor of AB InBev)
    // Near-lexical leftovers (Probe / fuzzy / Add to map…):
    //   SBUX, McDonalds, Costa, RedBull GmbH
    company_map.entries = vec![
        KeyMapEntry {
            from: "STARBUCKS CORP".into(),
            to: "STBUX".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Nestle SA".into(),
            to: "NESTLE".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "NESTLÉ INTERNATIONAL".into(),
            to: "NESTLE".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Coca Cola Co".into(),
            to: "KO".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "THE COCA-COLA COMPANY".into(),
            to: "KO".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Pepsi Co".into(),
            to: "PEP".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "PEPSICO INC".into(),
            to: "PEP".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Danone Group".into(),
            to: "DANO".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "DANONE SA".into(),
            to: "DANO".into(),
            ..Default::default()
        },
        // spend-side legal name only — sales uses ticker DEO (unmapped, LLM lab)
        KeyMapEntry {
            from: "DIAGEO PLC".into(),
            to: "UBL".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Heineken NV".into(),
            to: "HEIN".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "HEINEKEN N.V.".into(),
            to: "HEIN".into(),
            ..Default::default()
        },
        // spend-side only — sales uses old name "The South African Breweries" (unmapped)
        KeyMapEntry {
            from: "AB INBEV".into(),
            to: "ABEV".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Yum Brands".into(),
            to: "YUM".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "YUM! BRANDS INC".into(),
            to: "YUM".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Mondelez Int".into(),
            to: "MOND".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "MONDELEZ INTERNATIONAL".into(),
            to: "MOND".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Unilever PLC".into(),
            to: "UNIL".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "UNILEVER N.V.".into(),
            to: "UNIL".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "Keurig DrPepper".into(),
            to: "KDP".into(),
            ..Default::default()
        },
        KeyMapEntry {
            from: "KEURIG DR PEPPER".into(),
            to: "KDP".into(),
            ..Default::default()
        },
    ];

    Ok(Workspace {
        queries: vec![
            QueryDef {
                id: "dim_company".into(),
                name: "dim_company".into(),
                steps: vec![TransformationStep::LoadCsv { path: dim }],
                execution: Default::default(),
            },
            QueryDef {
                id: "sales_daily".into(),
                name: "sales_daily".into(),
                steps: vec![TransformationStep::LoadCsv { path: sales }],
                execution: Default::default(),
            },
            QueryDef {
                id: "res_consumption".into(),
                name: "res_consumption".into(),
                steps: vec![TransformationStep::LoadCsv { path: spend }],
                execution: Default::default(),
            },
            // Case A — no map: sales names ≠ company_id → Join Lens Probe / Add to map…
            QueryDef {
                id: "dirty_join".into(),
                name: "dirty_join".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_daily".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_company".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["company".into()],
                        right_on: vec!["company_id".into()],
                    },
                ],
                execution: Default::default(),
            },
            // Case B — continue sales_daily → map spellings → company_id + dim
            QueryDef {
                id: "sales_canon".into(),
                name: "sales_canon".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_daily".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "company".into(),
                        columns: vec![],
                        output_column: None,
            output_bindings: vec![],
                        as_of_column: None,
                        map_id: company_map.id.clone().into(),
                        entries: company_map.entries.clone(),
                    },
                    TransformationStep::RenameColumn {
                        from: "company".into(),
                        to: "company_id".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "dim_company".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["company_id".into()],
                        right_on: vec!["company_id".into()],
                    },
                ],
                execution: Default::default(),
            },
            // Case B' — continue res_consumption → same map on org_name
            QueryDef {
                id: "spend_canon".into(),
                name: "spend_canon".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "res_consumption".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "org_name".into(),
                        columns: vec![],
                        output_column: None,
            output_bindings: vec![],
                        as_of_column: None,
                        map_id: company_map.id.clone().into(),
                        entries: company_map.entries.clone(),
                    },
                    TransformationStep::RenameColumn {
                        from: "org_name".into(),
                        to: "company_id".into(),
                    },
                ],
                execution: Default::default(),
            },
            // Case C — one row per company×day: units, revenue, spend, cleaned net
            QueryDef {
                id: "daily_pnl".into(),
                name: "daily_pnl".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "sales_canon".into(),
                    },
                    TransformationStep::Join {
                        right_query_id: "spend_canon".into(),
                        join_type: dwh_pipeline::JoinType::Left,
                        left_on: vec!["company_id".into(), "day".into()],
                        right_on: vec!["company_id".into(), "day".into()],
                    },
                    TransformationStep::SelectColumns {
                        columns: vec![
                            "company_name".into(),
                            "company_id".into(),
                            "category".into(),
                            "day".into(),
                            "units".into(),
                            "revenue".into(),
                            "spend".into(),
                        ],
                    },
                    TransformationStep::DeriveColumn {
                        name: "net_revenue".into(),
                        expression: "revenue - coalesce(spend, 0)".into(),
                        mode: Default::default(),
                        op: None,
                        sql_dialect: None,
                    },
                    TransformationStep::SortBy {
                        column: "day".into(),
                        descending: false,
                    },
                ],
                execution: Default::default(),
            },
            // Case D — monthly rollup of cleaned net
            QueryDef {
                id: "monthly_pnl".into(),
                name: "monthly_pnl".into(),
                steps: vec![
                    TransformationStep::FromQuery {
                        query_id: "daily_pnl".into(),
                    },
                    TransformationStep::DeriveColumn {
                        name: "month".into(),
                        expression: "strftime(day::DATE, '%Y-%m')".into(),
                        mode: Default::default(),
                        op: None,
                        sql_dialect: None,
                    },
                    TransformationStep::GroupBy {
                        dimensions: vec![
                            "company_name".into(),
                            "category".into(),
                            "month".into(),
                        ],
                        aggregates: vec![
                            "sum(units) as units".into(),
                            "sum(revenue) as revenue".into(),
                            "sum(spend) as spend".into(),
                            "sum(net_revenue) as net_revenue".into(),
                            "count(*) as n_days".into(),
                        ],
                    },
                    TransformationStep::SortBy {
                        column: "month".into(),
                        descending: false,
                    },
                ],
                execution: Default::default(),
            },
        ],
        // Land on dirty join so Probe shows unmatched names → Add to map…
        focus_query_id: "dirty_join".into(),
        key_maps: vec![company_map],
    })
}

fn load_demo_workspace(name: &str) -> Result<Workspace, String> {
    if name.trim().eq_ignore_ascii_case("mapping_quality") {
        let cache = crate::secrets_io::dwh_home_dir()?.join("demos");
        return crate::demo_mapping_quality::load(&cache);
    }
    let fixtures = find_fixtures_dir()?;
    use crate::demo_help_labs as help_labs;
    use crate::demo_keymap_labs as labs;
    match name.trim().to_ascii_lowercase().as_str() {
        "sales" | "sample" | "" => demo_sales(&fixtures),
        "union" => demo_union(&fixtures),
        "sql" | "sql_hybrid" | "hybrid" => demo_sql(&fixtures),
        "right" | "right_joins" | "coverage" => demo_right_joins(&fixtures),
        "keymap" | "key_map" | "mapping" | "aliases" => demo_keymap(&fixtures),
        "recon_ship_sales" | "recon" | "ship_sales" => {
            help_labs::demo_recon_ship_sales(&fixtures)
        }
        "keymap_crosswalk" | "crosswalk" => labs::demo_keymap_crosswalk(&fixtures),
        "keymap_dual" | "dual" => labs::demo_keymap_dual(&fixtures),
        "keymap_codes" | "codes" => labs::demo_keymap_codes(&fixtures),
        "keymap_hop" | "hop" => labs::demo_keymap_hop(&fixtures),
        "keymap_offer" | "offer" | "composite" => labs::demo_keymap_offer(&fixtures),
        "keymap_pg" | "keymap_pg_crosswalk" | "pg_crosswalk" => {
            labs::demo_keymap_pg_crosswalk(&fixtures)
        }
        "keymap_pg_dual" | "pg_dual" => labs::demo_keymap_pg_dual(&fixtures),
        "keymap_pg_seed" | "pg_seed" => labs::demo_keymap_pg_seed(&fixtures),
        "keymap_ref" | "ref" => labs::demo_keymap_ref(&fixtures),
        "keymap_mixed" | "mixed" => labs::demo_keymap_mixed(&fixtures),
        "keymap_parquet" | "parquet" => labs::demo_keymap_parquet(&fixtures),
        other => Err(format!(
            "Unknown demo '{other}'. Open Help Lab for the catalog, or use: sales | union | sql | \
             right | keymap | recon_ship_sales | keymap_crosswalk | …"
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewArgs {
    workspace: Option<Workspace>,
    steps: Option<Vec<TransformationStep>>,
    connections: Option<Vec<ConnectionDef>>,
    /// Project sources — Hive partitioning and other source-specific scan opts.
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    /// Saved project file. Required when the operation cites a reference (ADR-0025).
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
    /// Output row LIMIT. Ignored when `full_preview` is true. Default sample = 50.
    #[serde(default)]
    row_limit: Option<u64>,
    /// No output row LIMIT (ADR-0041 Load full).
    #[serde(default)]
    full_preview: bool,
}

/// Read-only matching inputs; accepting proposals uses existing KeyMap editing.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyMapFuzzyArgs {
    workspace: Workspace,
    #[serde(default)]
    connections: Vec<ConnectionDef>,
    left: dwh_engine::KeyMapMatchSource,
    right: dwh_engine::KeyMapMatchSource,
    #[serde(default)]
    options: dwh_engine::KeyMatchOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinDiagArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    /// When true, Prepare rebuilds even if fingerprint matches (Reload sides).
    #[serde(default)]
    force: Option<bool>,
    /// Per-column Suggest on composite Join ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    #[serde(default)]
    key_index: Option<usize>,
    /// Composite-map mode: Join key indices that form From ([ADR-0024]).
    #[serde(default)]
    composite_indices: Option<Vec<usize>>,
    /// Which slot within `composite_indices` is fuzzy-scored (others exact).
    #[serde(default)]
    composite_fuzzy_slot: Option<usize>,
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncKeyMapsArgs {
    workspace: Workspace,
    export_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncKeyMapsOut {
    workspace: Workspace,
    result: KeyMapSyncResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushKeyMapArgs {
    export_path: String,
    key_map: KeyMapDef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveKeyMapSeedArgs {
    export_path: String,
    map_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    keys: Option<Vec<JoinKeyTuple>>,
    preview_offsets: Option<Vec<u64>>,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainKeyArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    side: String,
    key_values: Vec<serde_json::Value>,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlameKeyArgs {
    workspace: Workspace,
    host_query_id: String,
    join_step_index: usize,
    side: String,
    key_values: Vec<serde_json::Value>,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

fn cites_external(ws: &Workspace) -> bool {
    ws.queries.iter().any(|q| {
        q.steps.iter().any(|step| match step {
            TransformationStep::FromQuery { query_id }
            | TransformationStep::Join {
                right_query_id: query_id,
                ..
            }
            | TransformationStep::ApplyKeyMap {
                map_id: query_id, ..
            } => matches!(query_id, ObjectTarget::External { .. }),
            TransformationStep::Append { other_query_ids } => other_query_ids
                .iter()
                .any(|id| matches!(id, ObjectTarget::External { .. })),
            TransformationStep::SqlModel { raw_sql }
            | TransformationStep::CustomSql { raw_sql }
            | TransformationStep::DeriveColumn {
                expression: raw_sql,
                ..
            } => raw_sql.contains("{{xref:"),
            _ => false,
        })
    })
}

/// Lower a reference closure once (ADR-0025). Local operations stay on the
/// workspace the caller sent.
fn lower_for_operation(
    workspace: &Workspace,
    sources: &[SourceDef],
    connections: &[ConnectionDef],
    project_file: Option<&str>,
    project_uid: Option<&str>,
    references: &[ProjectReference],
    connection_bindings: &[ConnectionBinding],
    execution_engine: Option<WarehouseDialect>,
    kind: ResolveKind,
    published_fallback: Vec<String>,
) -> Result<LoweredOperation, String> {
    if !cites_external(workspace) {
        return Ok(LoweredOperation {
            workspace: workspace.clone(),
            sources: sources.to_vec(),
            published_query_ids: published_fallback,
            provenance_json: None,
        });
    }
    let available: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
    resolve_operation(&ResolveInput {
        root_file: Path::new(project_file.unwrap_or("")),
        project_uid: project_uid.unwrap_or(""),
        execution_engine: ExecutionEngine::from_dialect(
            execution_engine.unwrap_or(WarehouseDialect::Duckdb),
        ),
        references,
        connection_bindings,
        workspace,
        sources,
        available_connections: &available,
        kind,
    })
}

/// Join / model RPCs pin focus to the host (or model) query before lowering.
fn lower_focused(
    workspace: &Workspace,
    focus_query_id: &str,
    sources: &[SourceDef],
    connections: &[ConnectionDef],
    project_file: Option<&str>,
    project_uid: Option<&str>,
    references: &[ProjectReference],
    connection_bindings: &[ConnectionBinding],
    execution_engine: Option<WarehouseDialect>,
) -> Result<(Workspace, Vec<SourceDef>), String> {
    let mut ws = workspace.clone();
    ws.focus_query_id = focus_query_id.to_string();
    let lowered = lower_for_operation(
        &ws,
        sources,
        connections,
        project_file,
        project_uid,
        references,
        connection_bindings,
        execution_engine,
        ResolveKind::Preview,
        Vec::new(),
    )?;
    Ok((lowered.workspace, lowered.sources))
}

fn parse_join_side(side: &str) -> Result<JoinKeySide, String> {
    match side.trim().to_ascii_lowercase().as_str() {
        "left" => Ok(JoinKeySide::Left),
        "right" => Ok(JoinKeySide::Right),
        other => Err(format!("side must be 'left' or 'right' (got '{other}')").into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDbtArgs {
    workspace: Workspace,
    query_id: String,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportArgs {
    pipeline_name: String,
    workspace: Workspace,
    output_dir: String,
    dbt_target: Option<DbtTarget>,
    target_dialect: Option<WarehouseDialect>,
    connections: Option<Vec<ConnectionDef>>,
    #[serde(default)]
    sources: Option<Vec<dwh_pipeline::SourceDef>>,
    /// Explicit engine (overrides dialect-alone legacy when set with destination).
    execution_engine: Option<WarehouseDialect>,
    destination_kind: Option<WarehouseDialect>,
    /// Destination Postgres connection id → inject `DWH_PG_DSN` for post-export parse.
    destination_connection_id: Option<String>,
    /// Postgres schema for published marts (default `public`).
    destination_schema: Option<String>,
    /// Query ids to export as `mart_*` (`Project.outputs`; empty → focus only).
    #[serde(default)]
    outputs: Option<Vec<String>>,
    /// When true, skip post-export `dbt parse` (UI runs parse as a separate phase).
    #[serde(default)]
    skip_parse: Option<bool>,
    /// Saved project file. Required when the operation cites a reference (ADR-0025).
    #[serde(default)]
    project_file: Option<String>,
    #[serde(default)]
    project_uid: Option<String>,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: String,
    /// Optional process env for dbt (`DWH_PG_DSN`, …) from destination connection.
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    connections: Option<Vec<ConnectionDef>>,
    destination_connection_id: Option<String>,
    /// When true, update last-opened session path (Open / Restore). Peek loads stay false.
    #[serde(default)]
    remember: Option<bool>,
}

fn resolve_dbt_cli_env(a: &PathArg) -> HashMap<String, String> {
    if let Some(env) = &a.env {
        if !env.is_empty() {
            return env.clone();
        }
    }
    dbt_env_from_connections(
        a.connections.as_deref().unwrap_or(&[]),
        a.destination_connection_id.as_deref(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnStrArgs {
    connection_string: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DescribeArgs {
    connection_string: String,
    schema: String,
    table_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceStatusesArgs {
    project_file: String,
    #[serde(default)]
    references: Vec<ProjectReference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MakeReferenceArgs {
    project_file: String,
    owner_file: String,
    alias: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelinkReferenceArgs {
    project_file: String,
    reference: ProjectReference,
    owner_file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshReferenceArgs {
    project_file: String,
    project_uid: String,
    reference_id: String,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    workspace: Workspace,
    #[serde(default)]
    sources: Vec<SourceDef>,
    #[serde(default)]
    connections: Vec<ConnectionDef>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceConsumersArgs {
    workspace: Workspace,
    reference_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyReferencedArgs {
    project_file: String,
    #[serde(default)]
    references: Vec<ProjectReference>,
    #[serde(default)]
    connection_bindings: Vec<ConnectionBinding>,
    #[serde(default)]
    connections: Vec<ConnectionDef>,
    #[serde(default)]
    execution_engine: Option<WarehouseDialect>,
    reference_id: String,
    kind: ObjectKind,
    object_id: String,
    new_local_id: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetLlmArgs {
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatArgs {
    messages: Vec<Value>,
}

fn llm_public(settings: &AppSettings) -> Value {
    serde_json::json!({
        "base_url": settings.llm.base_url,
        "model": settings.llm.model,
        "api_key_set": !settings.llm.api_key.trim().is_empty(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalConnectionsArgs {
    connections: Vec<ConnectionDef>,
}

/// Small LRU for structural DuckDB previews (LIMIT 50). Avoids recompile+rerun
/// when the UI re-requests the same workspace (step select, tab switch, Lens).
struct PreviewCache {
    map: HashMap<u64, Value>,
    order: Vec<u64>,
    capacity: usize,
}

impl PreviewCache {
    fn new(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            capacity,
        }
    }

    fn get(&mut self, key: u64) -> Option<Value> {
        if !self.map.contains_key(&key) {
            return None;
        }
        self.order.retain(|k| *k != key);
        self.order.push(key);
        self.map.get(&key).cloned()
    }

    fn insert(&mut self, key: u64, value: Value) {
        if self.map.insert(key, value).is_none() {
            self.order.push(key);
        } else {
            self.order.retain(|k| *k != key);
            self.order.push(key);
        }
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.first().copied() {
                self.order.remove(0);
                self.map.remove(&old);
            } else {
                break;
            }
        }
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

fn fingerprint_json(parts: &[&Value]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in parts {
        if let Ok(bytes) = serde_json::to_vec(p) {
            bytes.hash(&mut h);
        }
    }
    h.finish()
}

/// One pending heavy job + one running worker.
struct HeavyJob {
    cmd: String,
    args: Value,
    reply: SyncSender<Result<Value, RpcError>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HeavyLane {
    /// Debounced preview / describe — may be superseded by a newer preview.
    Preview,
    /// Join prepare / diagnostics / lens — replace pending of same lane only.
    Analysis,
    /// KeyMap / warehouse mutations — FIFO, never superseded.
    Mutation,
}

#[derive(Default)]
struct HeavyPending {
    preview: Option<HeavyJob>,
    analysis: Option<HeavyJob>,
    /// Ordered warehouse / KeyMap jobs (read + write). No replace.
    mutations: VecDeque<HeavyJob>,
}

impl HeavyPending {
    /// Prefer mutations (FIFO), then analysis, then preview.
    fn take_next(&mut self) -> Option<HeavyJob> {
        self.mutations
            .pop_front()
            .or_else(|| self.analysis.take())
            .or_else(|| self.preview.take())
    }
}

pub struct HostState {
    pub db: Mutex<DbSession>,
    /// Outside `db` so a new preview can cancel without waiting on the conn lock.
    preview_cancel: QueryCancelHandle,
    preview_cache: Mutex<PreviewCache>,
    /// One pending slot per lane; worker prefers analysis.
    heavy_pending: Mutex<HeavyPending>,
    heavy_cv: Condvar,
    /// Fingerprint of the job currently executing (for coalesce).
    heavy_running_fp: Mutex<Option<u64>>,
    /// Prepare progress — readable without taking `db` (poll while TEMP builds).
    join_prep_progress: Mutex<JoinPrepareProgress>,
}

impl HostState {
    pub fn new() -> Result<Arc<Self>, String> {
        configure_paths();
        let db = DbSession::new()?;
        let preview_cancel = db.cancel_handle();
        let state = Arc::new(Self {
            db: Mutex::new(db),
            preview_cancel,
            preview_cache: Mutex::new(PreviewCache::new(8)),
            heavy_pending: Mutex::new(HeavyPending::default()),
            heavy_cv: Condvar::new(),
            heavy_running_fp: Mutex::new(None),
            join_prep_progress: Mutex::new(JoinPrepareProgress::default()),
        });
        let worker = Arc::clone(&state);
        thread::Builder::new()
            .name("dwh-heavy".into())
            .spawn(move || worker.heavy_worker_loop())
            .map_err(|e| format!("spawn heavy worker: {e}"))?;
        Ok(state)
    }

    /// Cancel the DuckDB query currently running (preview / diagnostics).
    pub fn interrupt_running_query(&self) {
        self.preview_cancel.interrupt();
    }

    /// Heavy DuckDB RPCs: worker-threaded. Preview/analysis replace pending peers;
    /// mutations (KeyMap R/W) are FIFO and never superseded.
    pub fn is_heavy_rpc(cmd: &str) -> bool {
        matches!(
            cmd,
            "preview_workspace"
                | "preview_pipeline"
                | "describe_workspace"
                | "join_diagnostics"
                | "join_key_near_miss"
                | "explain_join_key"
                | "explain_join_rows"
                | "blame_unmatched_key"
                | "join_key_fuzzy_suggest"
                | "prepare_join_inputs"
                | "preview_prepared_join_side"
                | "install_dbt_venv"
                | "read_key_map"
                | "write_key_map"
        )
    }

    fn heavy_lane(cmd: &str) -> HeavyLane {
        match cmd {
            "preview_workspace" | "preview_pipeline" | "describe_workspace" => {
                HeavyLane::Preview
            }
            "read_key_map" | "write_key_map" => HeavyLane::Mutation,
            _ => HeavyLane::Analysis,
        }
    }

    /// True for RPCs that run DuckDB preview SQL and should preempt the previous one.
    pub fn is_preemptible_preview(cmd: &str) -> bool {
        Self::heavy_lane(cmd) == HeavyLane::Preview
    }

    /// After KeyMap/warehouse writes: drop stale preview + join-prepare caches.
    fn invalidate_caches_after_mutation(&self, cmd: &str) {
        if cmd != "write_key_map" {
            return;
        }
        if let Ok(mut cache) = self.preview_cache.lock() {
            cache.clear();
        }
        if let Ok(db) = self.db.lock() {
            let _ = run_clear_join_prepare(&db);
        }
        if let Ok(mut g) = self.join_prep_progress.lock() {
            *g = JoinPrepareProgress::default();
        }
    }

    /// Enqueue a heavy job.
    /// Preview/analysis: supersede only the same lane.
    /// Mutation: append FIFO (never replace).
    pub fn enqueue_heavy(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        // Fast path: preview cache hit without queue.
        if let Some(hit) = self.preview_cache_lookup(cmd, &args) {
            return Ok(hit);
        }
        let lane = Self::heavy_lane(cmd);
        // Prepare: surface "queued" immediately so UI is not stuck on client "Starting…".
        if cmd == "prepare_join_inputs" {
            if let Ok(mut g) = self.join_prep_progress.lock() {
                *g = JoinPrepareProgress {
                    active: true,
                    fraction: 0.01,
                    stage: "queued".into(),
                    message: "Queued — waiting for engine…".into(),
                    left_expensive: None,
                    right_expensive: None,
                };
            }
            // Drop a running preview so prepare can take the conn sooner.
            self.interrupt_running_query();
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let job = HeavyJob {
            cmd: cmd.to_string(),
            args,
            reply: tx,
        };
        {
            let mut slot = self.heavy_pending.lock().map_err(|e| RpcError::from(e.to_string()))?;
            match lane {
                HeavyLane::Preview => {
                    if let Some(old) = slot.preview.take() {
                        let _ = old.reply.send(Err(HostError::cancelled("Preview superseded.").into()));
                    }
                    slot.preview = Some(job);
                }
                HeavyLane::Analysis => {
                    if let Some(old) = slot.analysis.take() {
                        let _ = old.reply.send(Err(HostError::cancelled("Preview superseded.").into()));
                    }
                    slot.analysis = Some(job);
                }
                HeavyLane::Mutation => {
                    slot.mutations.push_back(job);
                }
            }
            self.heavy_cv.notify_one();
        }
        rx.recv().map_err(|_| "heavy worker disconnected".to_string())?
    }

    fn preview_cache_lookup(&self, cmd: &str, args: &Value) -> Option<Value> {
        let a: PreviewArgs = serde_json::from_value(args.clone()).ok()?;
        let key = match cmd {
            "preview_pipeline" => {
                let steps = a.steps.as_ref()?;
                let conns = a.connections.clone().unwrap_or_default();
                let steps_v = serde_json::to_value(steps).ok()?;
                let conns_v = serde_json::to_value(&conns).ok()?;
                fingerprint_json(&[
                    &Value::String("pipeline".into()),
                    &steps_v,
                    &conns_v,
                ])
            }
            "preview_workspace" | "describe_workspace" => {
                let ws = a.workspace.as_ref()?;
                let conns = a.connections.clone().unwrap_or_default();
                let sources = a.sources.clone().unwrap_or_default();
                let ws_v = serde_json::to_value(ws).ok()?;
                let conns_v = serde_json::to_value(&conns).ok()?;
                let sources_v = serde_json::to_value(&sources).ok()?;
                let kind = if cmd == "describe_workspace" {
                    "describe"
                } else {
                    "workspace"
                };
                if cmd == "preview_workspace" {
                    // ADR-0041: sample vs full must not share a cache entry.
                    let limit_v = if a.full_preview {
                        Value::String("full".into())
                    } else {
                        Value::Number(a.row_limit.unwrap_or(PREVIEW_SAMPLE_LIMIT).into())
                    };
                    fingerprint_json(&[
                        &Value::String(kind.into()),
                        &ws_v,
                        &conns_v,
                        &sources_v,
                        &limit_v,
                    ])
                } else {
                    fingerprint_json(&[
                        &Value::String(kind.into()),
                        &ws_v,
                        &conns_v,
                        &sources_v,
                    ])
                }
            }
            _ => return None,
        };
        self.preview_cache.lock().ok()?.get(key)
    }

    fn heavy_worker_loop(self: &Arc<Self>) {
        loop {
            let job = {
                let mut g = match self.heavy_pending.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                loop {
                    if let Some(job) = g.take_next() {
                        break job;
                    }
                    g = match self.heavy_cv.wait(g) {
                        Ok(g) => g,
                        Err(e) => e.into_inner(),
                    };
                }
            };
            let fp = fingerprint_json(&[
                &Value::String(job.cmd.clone()),
                &job.args,
            ]);
            if let Ok(mut running) = self.heavy_running_fp.lock() {
                *running = Some(fp);
            }
            let result = self.dispatch_heavy_job(&job.cmd, job.args.clone());
            if result.is_ok() {
                self.invalidate_caches_after_mutation(&job.cmd);
            }
            if let Ok(mut running) = self.heavy_running_fp.lock() {
                *running = None;
            }
            let _ = job.reply.send(result);
        }
    }

    fn dispatch_heavy_job(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        match cmd {
            "preview_pipeline" => {
                let a: PreviewArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let steps = a.steps.ok_or("preview_pipeline: missing steps")?;
                let conns = a.connections.unwrap_or_default();
                let steps_v = serde_json::to_value(&steps).unwrap_or(Value::Null);
                let conns_v = serde_json::to_value(&conns).unwrap_or(Value::Null);
                let key = fingerprint_json(&[
                    &Value::String("pipeline".into()),
                    &steps_v,
                    &conns_v,
                ]);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    if let Some(hit) = cache.get(key) {
                        return Ok(hit);
                    }
                }
                let db = self.db.lock().map_err(|e| RpcError::from(e.to_string()))?;
                let out: PreviewResult = run_preview_steps(&db, &steps, &conns)?;
                let val = serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))?;
                drop(db);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    cache.insert(key, val.clone());
                }
                Ok(val)
            }
            "preview_workspace" => {
                let a: PreviewArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let ws = a.workspace.ok_or("preview_workspace: missing workspace")?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let full_preview = a.full_preview;
                let row_limit = if full_preview {
                    None
                } else {
                    Some(a.row_limit.unwrap_or(PREVIEW_SAMPLE_LIMIT))
                };
                let lowered = lower_for_operation(
                    &ws,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                    ResolveKind::Preview,
                    Vec::new(),
                )?;
                let ws = lowered.workspace;
                let sources = lowered.sources;
                let ws_v = serde_json::to_value(&ws).unwrap_or(Value::Null);
                let conns_v = serde_json::to_value(&conns).unwrap_or(Value::Null);
                let sources_v = serde_json::to_value(&sources).unwrap_or(Value::Null);
                let limit_v = match row_limit {
                    None => Value::String("full".into()),
                    Some(n) => Value::Number(n.into()),
                };
                let key = fingerprint_json(&[
                    &Value::String("workspace".into()),
                    &ws_v,
                    &conns_v,
                    &sources_v,
                    &limit_v,
                ]);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    if let Some(hit) = cache.get(key) {
                        return Ok(hit);
                    }
                }
                let db = self.db.lock().map_err(|e| RpcError::from(e.to_string()))?;
                let out =
                    run_preview_workspace_limited(&db, &ws, &conns, &sources, row_limit)?;
                let val = serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))?;
                drop(db);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    cache.insert(key, val.clone());
                }
                Ok(val)
            }
            "describe_workspace" => {
                let a: PreviewArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let ws = a.workspace.ok_or("describe_workspace: missing workspace")?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let lowered = lower_for_operation(
                    &ws,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                    ResolveKind::Preview,
                    Vec::new(),
                )?;
                let ws = lowered.workspace;
                let sources = lowered.sources;
                let ws_v = serde_json::to_value(&ws).unwrap_or(Value::Null);
                let conns_v = serde_json::to_value(&conns).unwrap_or(Value::Null);
                let sources_v = serde_json::to_value(&sources).unwrap_or(Value::Null);
                let key = fingerprint_json(&[
                    &Value::String("describe".into()),
                    &ws_v,
                    &conns_v,
                    &sources_v,
                ]);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    if let Some(hit) = cache.get(key) {
                        return Ok(hit);
                    }
                }
                let db = self.db.lock().map_err(|e| RpcError::from(e.to_string()))?;
                let out = run_describe_workspace(&db, &ws, &conns, &sources)?;
                let val = serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))?;
                drop(db);
                if let Ok(mut cache) = self.preview_cache.lock() {
                    cache.insert(key, val.clone());
                }
                Ok(val)
            }
            other => self.dispatch_locked(other, args),
        }
    }

    pub fn dispatch(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        if Self::is_heavy_rpc(cmd) {
            return self.enqueue_heavy(cmd, args);
        }
        match cmd {
            // Must not take `db` lock — prepare holds it while TEMP builds.
            "join_prepare_progress" => {
                let out = self
                    .join_prep_progress
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            // Must not *wait* on `db` — a blocked status poll stalls the accept
            // loop so Cancel never gets read. try_lock: if prepare holds db,
            // report "not ready" (UI already polls join_prepare_progress).
            "join_prepare_status" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let sources = a.sources.unwrap_or_default();
                let conns = a.connections.unwrap_or_default();
                let (ws, sources) = match lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                ) {
                    Ok(v) => v,
                    Err(e) => return Err(RpcError::from(e)),
                };
                let out = match self.db.try_lock() {
                    Ok(db) => run_join_prepare_status(
                        &db,
                        &ws,
                        &sources,
                        &conns,
                        &a.host_query_id,
                        a.join_step_index,
                    ),
                    Err(_) => JoinPrepareStatus {
                        prepared: false,
                        fingerprint: None,
                        host_query_id: None,
                        join_step_index: None,
                        left_rows: None,
                        right_rows: None,
                        left_expensive: None,
                        right_expensive: None,
                        left_materialized: None,
                        right_materialized: None,
                        stale: false,
                    },
                };
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "cancel_running_query" => {
                self.interrupt_running_query();
                Ok(Value::Bool(true))
            }
            "get_llm_config" => {
                let settings = settings_io::load_settings()?;
                Ok(llm_public(&settings))
            }
            "set_llm_config" => {
                let a: SetLlmArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let mut settings = settings_io::load_settings()?;
                let base = a.base_url.trim().trim_end_matches('/').to_string();
                if !(base.starts_with("https://") || base.starts_with("http://")) {
                    return Err("llm.base_url must start with http:// or https://".into());
                }
                settings.llm.base_url = base;
                settings.llm.model = a.model.trim().to_string();
                if a.clear_api_key {
                    settings.llm.api_key.clear();
                } else if let Some(key) = a.api_key {
                    let key = key.trim();
                    if !key.is_empty() {
                        settings.llm.api_key = key.to_string();
                    }
                }
                settings_io::save_settings(&settings)?;
                Ok(llm_public(&settings))
            }
            "llm_chat" => {
                let a: LlmChatArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let settings = settings_io::load_settings()?;
                let content = crate::llm::complete_chat(&settings.llm, &a.messages)?;
                Ok(serde_json::json!({ "content": content }))
            }
            _ => self.dispatch_locked(cmd, args),
        }
    }

    fn dispatch_locked(&self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        let db = self.db.lock().map_err(|e| RpcError::from(e.to_string()))?;
        match cmd {
            "prepare_join_inputs" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let out: JoinPrepareResult = run_prepare_join_inputs(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    Some(&self.join_prep_progress),
                    a.force.unwrap_or(false),
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "clear_join_prepare" => {
                run_clear_join_prepare(&db)?;
                Ok(Value::Bool(true))
            }
            "preview_prepared_join_side" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct PrepSideArgs {
                    side: String,
                    #[serde(default)]
                    limit: Option<u64>,
                    /// Join-key column names on this side (left_on / right_on).
                    #[serde(default)]
                    key_columns: Option<Vec<String>>,
                    /// Distinct key tuples from the center result (same arity as key_columns).
                    #[serde(default)]
                    key_tuples: Option<Vec<Vec<serde_json::Value>>>,
                }
                let a: PrepSideArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let cols = a.key_columns.unwrap_or_default();
                let tuples = a.key_tuples.unwrap_or_default();
                let limit = a
                    .limit
                    .unwrap_or_else(|| std::cmp::max(50u64, tuples.len() as u64));
                let out = run_preview_prepared_join_side_filtered(
                    &db,
                    &a.side,
                    limit,
                    &cols,
                    &tuples,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "join_diagnostics" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                // Upgrade live sides → TEMP (with progress) before anti-join scans.
                run_ensure_join_sides(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    Some(&self.join_prep_progress),
                )?;
                set_prepare_progress(
                    &self.join_prep_progress,
                    JoinPrepareProgress {
                        active: true,
                        fraction: 0.55,
                        stage: "diagnostics".into(),
                        message: "Computing unmatched / fanout counts…".into(),
                        left_expensive: None,
                        right_expensive: None,
                    },
                );
                let out: JoinDiagnostics = run_join_diagnostics(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                )?;
                set_prepare_progress(
                    &self.join_prep_progress,
                    JoinPrepareProgress {
                        active: false,
                        fraction: 1.0,
                        stage: "done".into(),
                        message: "Diagnostics ready".into(),
                        left_expensive: None,
                        right_expensive: None,
                    },
                );
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "explain_join_rows" => {
                let a: ExplainArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let keys = a.keys.unwrap_or_default();
                let out: ExplainJoinRowsResult = run_explain_join_rows(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    &keys,
                    a.preview_offsets.as_deref(),
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "explain_join_key" => {
                let a: ExplainKeyArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let side = parse_join_side(&a.side)?;
                let out: ExplainJoinKeyResult = run_explain_join_key(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    side,
                    &a.key_values,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "blame_unmatched_key" => {
                let a: BlameKeyArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let side = parse_join_side(&a.side)?;
                let out: BlameUnmatchedKeyResult = run_blame_unmatched_key(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    side,
                    &a.key_values,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "join_key_near_miss" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let out: JoinKeyNearMiss = run_join_key_near_miss(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "join_key_fuzzy_suggest" => {
                let a: JoinDiagArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.host_query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                )?;
                let out: JoinKeyFuzzySuggest = run_join_key_fuzzy_suggest_on(
                    &db,
                    &ws,
                    &conns,
                    &sources,
                    &a.host_query_id,
                    a.join_step_index,
                    a.key_index,
                    a.composite_indices,
                    a.composite_fuzzy_slot,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "key_map_fuzzy_suggest" => {
                let a: KeyMapFuzzyArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = dwh_engine::key_map_fuzzy_suggest(
                    &db, &a.workspace, &a.connections, &a.left, &a.right, a.options,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "sync_key_maps_from_export" => {
                let a: SyncKeyMapsArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let mut ws = a.workspace;
                let result: KeyMapSyncResult =
                    sync_key_maps_from_export(&mut ws, Path::new(&a.export_path))?;
                serde_json::to_value(SyncKeyMapsOut {
                    workspace: ws,
                    result,
                })
                .map_err(|e| RpcError::from(e.to_string()))
            }
            "push_key_map_to_export" => {
                let a: PushKeyMapArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let rel = push_key_map_to_export(Path::new(&a.export_path), &a.key_map)?;
                serde_json::to_value(serde_json::json!({ "path": rel })).map_err(|e| RpcError::from(e.to_string()))
            }
            "remove_key_map_from_export" => {
                let a: RemoveKeyMapSeedArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let removed =
                    remove_key_map_from_export(Path::new(&a.export_path), &a.map_id)?;
                serde_json::to_value(serde_json::json!({ "path": removed }))
                    .map_err(|e| RpcError::from(e.to_string()))
            }
            "write_key_map" => {
                let a: commands::keymap::KeyMapWhArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                commands::keymap::write_key_map(&db, a)
            }
            "read_key_map" => {
                let a: commands::keymap::KeyMapWhArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                commands::keymap::read_key_map(&db, a)
            }
            "preview_dbt_model" => {
                let a: PreviewDbtArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let dialect = a.target_dialect.unwrap_or_default();
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let (ws, sources) = lower_focused(
                    &a.workspace,
                    &a.query_id,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine.or(a.target_dialect),
                )?;
                let prepared = run_prepare_workspace(&db, &ws, &conns, &sources)?;
                for w in &prepared.warnings {
                    eprintln!("[dwh] prepare warning: {w}");
                }
                let out: PreviewDbtModel = preview_dbt_model_sql_with_seeds_and_sources(
                    &ws,
                    &a.query_id,
                    dialect,
                    &prepared.seeds,
                    &sources,
                    &prepared.sql_models,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "export_dbt" => {
                let a: ExportArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let target = a.dbt_target.unwrap_or(DbtTarget::V1);
                let dialect = a.target_dialect.unwrap_or_default();
                let conns = a.connections.unwrap_or_default();
                let sources = a.sources.unwrap_or_default();
                let published = a.outputs.clone().unwrap_or_default();
                let lowered = lower_for_operation(
                    &a.workspace,
                    &sources,
                    &conns,
                    a.project_file.as_deref(),
                    a.project_uid.as_deref(),
                    &a.references,
                    &a.connection_bindings,
                    a.execution_engine,
                    ResolveKind::Export {
                        published_ids: published.clone(),
                    },
                    published,
                )?;
                let prepared =
                    run_prepare_workspace(&db, &lowered.workspace, &conns, &lowered.sources)?;
                for w in &prepared.warnings {
                    eprintln!("[dwh] prepare warning: {w}");
                }
                let seeds = &prepared.seeds;
                let sql_models = &prepared.sql_models;
                let pg_schema = a
                    .destination_schema
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("public");
                let path = match (a.execution_engine, a.destination_kind) {
                    (Some(eng), Some(dest)) => {
                        use dwh_pipeline::DestinationKind;
                        let engine = ExecutionEngine::from_dialect(eng);
                        let destination = match dest {
                            WarehouseDialect::Duckdb => DestinationKind::Duckdb,
                            WarehouseDialect::Postgres => DestinationKind::Postgres,
                        };
                        DbtProducer.produce_routed_with_schema_and_sources(
                            &a.pipeline_name,
                            &lowered.workspace,
                            &a.output_dir,
                            target,
                            engine,
                            destination,
                            pg_schema,
                            &lowered.published_query_ids,
                            seeds,
                            &lowered.sources,
                            sql_models,
                            lowered.provenance_json.as_deref(),
                        )?
                    }
                    _ => {
                        if let Some(body) = lowered.provenance_json.as_deref() {
                            use dwh_pipeline::DestinationKind;
                            let has_files = lowered.workspace.queries.iter().any(|q| {
                                q.steps.iter().any(|s| {
                                    matches!(
                                        s,
                                        TransformationStep::LoadCsv { .. }
                                            | TransformationStep::LoadParquet { .. }
                                    )
                                })
                            });
                            let (engine, destination) = match (dialect, has_files) {
                                (WarehouseDialect::Postgres, true) => {
                                    (ExecutionEngine::Duckdb, DestinationKind::Postgres)
                                }
                                (WarehouseDialect::Postgres, false) => {
                                    (ExecutionEngine::Postgres, DestinationKind::Postgres)
                                }
                                (WarehouseDialect::Duckdb, _) => {
                                    (ExecutionEngine::Duckdb, DestinationKind::Duckdb)
                                }
                            };
                            let schema = match engine {
                                ExecutionEngine::Postgres => "sys",
                                ExecutionEngine::Duckdb => "public",
                            };
                            DbtProducer.produce_routed_with_schema_and_sources(
                                &a.pipeline_name,
                                &lowered.workspace,
                                &a.output_dir,
                                target,
                                engine,
                                destination,
                                schema,
                                &lowered.published_query_ids,
                                seeds,
                                &[],
                                sql_models,
                                Some(body),
                            )?
                        } else {
                            DbtProducer.produce_with_seeds(
                                &a.pipeline_name,
                                &lowered.workspace,
                                &a.output_dir,
                                target,
                                dialect,
                                seeds,
                                sql_models,
                            )?
                        }
                    }
                };
                let files = walk_export_tree(&path)?;
                let mut result = ExportResult::with_files(path.clone(), files);
                if a.skip_parse.unwrap_or(false) {
                    result.dbt_parse_ok = true;
                    result.dbt_parse_log = String::new();
                } else {
                    let candidates = dbt_bin_candidates();
                    let bin = resolve_dbt_bin(&candidates);
                    let env = dbt_env_from_connections(
                        &conns,
                        a.destination_connection_id.as_deref(),
                    );
                    let outcome = dbt_parse_with_env(&path, bin.as_deref(), &env);
                    result.dbt_parse_ok = outcome.ok;
                    result.dbt_parse_log = outcome.log;
                }
                serde_json::to_value(result).map_err(|e| RpcError::from(e.to_string()))
            }
            "parse_export" => {
                let a: PathArg = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let candidates = dbt_bin_candidates();
                let bin = resolve_dbt_bin(&candidates);
                let env = resolve_dbt_cli_env(&a);
                let outcome = dbt_parse_with_env(&a.path, bin.as_deref(), &env);
                serde_json::to_value(serde_json::json!({
                    "ok": outcome.ok,
                    "log": outcome.log,
                }))
                .map_err(|e| RpcError::from(e.to_string()))
            }
            "build_export" => {
                let a: PathArg = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let candidates = dbt_bin_candidates();
                let bin = resolve_dbt_bin(&candidates);
                let env = resolve_dbt_cli_env(&a);
                let outcome = dbt_build_with_env(&a.path, bin.as_deref(), &env);
                serde_json::to_value(serde_json::json!({
                    "ok": outcome.ok,
                    "log": outcome.log,
                }))
                .map_err(|e| RpcError::from(e.to_string()))
            }
            "list_export_tree" => {
                let a: PathArg = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = walk_export_tree(&a.path)?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "list_postgres_objects" => {
                let a: ConnStrArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out: Vec<PostgresObject> =
                    run_list_postgres_objects(&db, &a.connection_string)?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "pg_import_fingerprint" => commands::pg_import::pg_import_fingerprint(args),
            "scan_postgres_import" => commands::pg_import::scan_pg_import(&db, args),
            "diagnose_postgres_mapping" => commands::pg_import::diagnose_pg_import(&db, args),
            "commit_pg_import" => commands::pg_import::commit_pg_import_cmd(&db, args),
            "describe_postgres_object" => {
                let a: DescribeArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out: Vec<PostgresColumn> = run_describe_postgres_object(
                    &db,
                    &a.connection_string,
                    &a.schema,
                    &a.table_name,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "test_postgres_connection" => {
                let a: ConnStrArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                run_test_postgres_connection(&db, &a.connection_string)?;
                Ok(Value::Null)
            }
            "reference_statuses" => {
                drop(db);
                let a: ReferenceStatusesArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = reference_statuses(Path::new(&a.project_file), &a.references);
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "make_project_reference" => {
                drop(db);
                let a: MakeReferenceArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = make_project_reference(
                    Path::new(&a.project_file),
                    Path::new(&a.owner_file),
                    &a.alias,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "relink_reference" => {
                drop(db);
                let a: RelinkReferenceArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = relink_reference(
                    Path::new(&a.project_file),
                    &a.reference,
                    Path::new(&a.owner_file),
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "refresh_reference" => {
                drop(db);
                let a: RefreshReferenceArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let available: Vec<String> = a.connections.iter().map(|c| c.id.clone()).collect();
                let out = refresh_reference(
                    &ResolveInput {
                        root_file: Path::new(&a.project_file),
                        project_uid: &a.project_uid,
                        execution_engine: ExecutionEngine::from_dialect(
                            a.execution_engine.unwrap_or(WarehouseDialect::Duckdb),
                        ),
                        references: &a.references,
                        connection_bindings: &a.connection_bindings,
                        workspace: &a.workspace,
                        sources: &a.sources,
                        available_connections: &available,
                        kind: ResolveKind::ValidateAll,
                    },
                    &a.reference_id,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "reference_consumers" => {
                drop(db);
                let a: ReferenceConsumersArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = reference_consumers(&a.workspace, &a.reference_id);
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "copy_referenced_object" => {
                drop(db);
                let a: CopyReferencedArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let available: Vec<String> = a.connections.iter().map(|c| c.id.clone()).collect();
                let out: CopiedObject = copy_referenced_object(
                    Path::new(&a.project_file),
                    &a.references,
                    &a.connection_bindings,
                    &available,
                    ExecutionEngine::from_dialect(
                        a.execution_engine.unwrap_or(WarehouseDialect::Duckdb),
                    ),
                    &a.reference_id,
                    a.kind,
                    &a.object_id,
                    &a.new_local_id,
                    &a.new_name,
                )?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "save_project" => {
                drop(db);
                let a: commands::project::SaveProjectArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let path = a.path.clone();
                let saved = commands::project::save_project(a)?;
                remember_project_path(&path)?;
                serde_json::to_value(saved).map_err(|e| RpcError::from(e.to_string()))
            }
            "load_project" => {
                drop(db);
                let a: commands::project::LoadProjectArgs = serde_json::from_value(args)
                    .map_err(|e| HostError::validation(format!("load_project args: {e}")))?;
                let path = a.path.clone();
                let (project, remember) = commands::project::load_project(a)?;
                // Default false: reference catalogs / peeks must not steal the session path.
                if remember {
                    let _ = remember_project_path(&path);
                }
                serde_json::to_value(project).map_err(|e| e.to_string().into())
            }
            "get_last_project_path" => {
                drop(db);
                let file = session_file()?;
                if !file.is_file() {
                    return Ok(Value::Null);
                }
                let raw = fs::read_to_string(&file).map_err(|e| RpcError::from(e.to_string()))?;
                let session: AppSession = serde_json::from_str(&raw).unwrap_or_default();
                let path = session
                    .last_project_path
                    .filter(|p| PathBuf::from(p).is_file());
                serde_json::to_value(path).map_err(|e| RpcError::from(e.to_string()))
            }
            "get_app_settings" => {
                drop(db);
                let mut s = settings_io::load_settings()?;
                // Panel-width saves round-trip this object. Never send the key out.
                s.llm.api_key.clear();
                serde_json::to_value(s).map_err(|e| RpcError::from(e.to_string()))
            }
            "set_app_settings" => {
                drop(db);
                let settings_val = args.get("settings").cloned().unwrap_or(Value::Null);
                let mut settings: AppSettings =
                    serde_json::from_value(settings_val).map_err(|e| RpcError::from(e.to_string()))?;
                // Panel-width / Options / Recent saves must not clobber llm (base URL, model, key).
                if let Ok(prev) = settings_io::load_settings() {
                    settings.llm = prev.llm;
                }
                settings.normalize_for_save();
                settings_io::save_settings(&settings)?;
                Ok(Value::Null)
            }
            "dbt_setup_status" => {
                drop(db);
                let status = dbt_setup::setup_status(&dbt_bin_candidates())?;
                serde_json::to_value(status).map_err(|e| RpcError::from(e.to_string()))
            }
            "dbt_install_script" => {
                drop(db);
                let script = dbt_setup::install_script()?;
                serde_json::to_value(script).map_err(|e| RpcError::from(e.to_string()))
            }
            "install_dbt_venv" => {
                drop(db);
                let result = dbt_setup::install_dbt_venv()?;
                serde_json::to_value(result).map_err(|e| RpcError::from(e.to_string()))
            }
            "get_global_connections" => {
                drop(db);
                let conns = connections_io::load_global_connections()?;
                serde_json::to_value(conns).map_err(|e| RpcError::from(e.to_string()))
            }
            "set_global_connections" => {
                drop(db);
                let a: GlobalConnectionsArgs =
                    serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                connections_io::save_global_connections(&a.connections)?;
                Ok(Value::Null)
            }
            "load_demo_workspace" => {
                drop(db);
                let a: DemoArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
                let out = load_demo_workspace(&a.name)?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "load_sample_workspace" => {
                drop(db);
                let out = load_demo_workspace("sales")?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            "list_help_labs" => {
                drop(db);
                let fixtures = find_fixtures_dir()?;
                let out = crate::demo_help_labs::load_help_lab_catalog(&fixtures)?;
                serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
            }
            other => Err(format!("unknown command '{other}'").into()),
        }
    }
}
