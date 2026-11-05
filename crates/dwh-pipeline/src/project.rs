//! Durable Project document (`project.json`) — ADR-0009 / ADR-0012 / engine×destination.
//! Document versioning: [ADR-0030](../../../docs/adr/0030-project-format-version.md).

use crate::connection::ConnectionDef;
use crate::destination::{Destination, ExecutionEngine, Materialization};
use crate::dialect::WarehouseDialect;
use crate::mapping_check::{CheckRun, MappingCheck};
use crate::model::Workspace;
use crate::producers::DbtTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// On-disk project document version (ADR-0030). Independent of IPC protocol version.
pub const PROJECT_FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Csv,
    Parquet,
    Postgres,
    Duckdb,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SourceDef {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table_name: Option<String>,
    /// Hive-style `key=value` partition folders → columns (Parquet sources only).
    #[serde(default)]
    pub hive_partitioning: bool,
}

/// Look up source-specific Hive partitioning for a LoadParquet path.
pub fn parquet_hive_partitioning(
    sources: &[SourceDef],
    path: &str,
    connection_id: Option<&str>,
) -> bool {
    let path = path.trim();
    sources.iter().any(|s| {
        s.kind == SourceKind::Parquet
            && s.hive_partitioning
            && s.path.as_deref().map(str::trim) == Some(path)
            && s.connection_id.as_deref() == connection_id
    })
}

/// Saved React Flow node positions (query id → canvas coords).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct CanvasLayout {
    #[serde(default)]
    pub positions: std::collections::BTreeMap<String, CanvasPosition>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CanvasPosition {
    pub x: f64,
    pub y: f64,
}

/// A dependency on another saved DWHQuery project ([ADR-0025](../../../docs/adr/0025-project-references.md)).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ProjectReference {
    /// Stable within the declaring project. Not derived from `alias`.
    pub id: String,
    /// Display and search label. Not object identity.
    pub alias: String,
    /// Project-file path, relative to the declaring project file.
    pub locator: String,
    pub expected_project_uid: String,
    /// Semantic definition fingerprint of the owner.
    pub locked_revision: String,
}

/// Remap of an owner connection requirement onto a global connection id.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConnectionBinding {
    pub owner_project_uid: String,
    pub owner_connection_id: String,
    pub local_connection_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
    /// Document schema version ([ADR-0030](../../../docs/adr/0030-project-format-version.md)).
    /// Missing on disk → treated as 0 at load; always written as [`PROJECT_FORMAT_VERSION`] on save.
    #[serde(default)]
    pub format_version: u32,
    pub id: String,
    pub name: String,
    /// Immutable global identity ([ADR-0025](../../../docs/adr/0025-project-references.md)).
    /// Empty until the owner saves. Not a substitute for query/source/mapping ids.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_uid: String,
    /// Other saved projects this file uses. Empty for a local-only project.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<ProjectReference>,
    /// Owner connection id → global connection id. No secrets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connection_bindings: Vec<ConnectionBinding>,
    /// Absolute path of the open project file — **runtime only**, never written to disk
    /// (derived from Open/Save path). Old files may still contain it; load ignores it.
    #[serde(default, skip_serializing)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub connections: Vec<ConnectionDef>,
    #[serde(default)]
    pub sources: Vec<SourceDef>,
    pub workspace: Workspace,
    /// dbt Core major line (v1/v2). Wire name stays `dbt_target` (alias `dbt_runtime`).
    #[serde(default, alias = "dbt_runtime")]
    pub dbt_target: DbtTarget,
    /// SQL emit / free-SQL dialect owner.
    #[serde(default)]
    pub execution_engine: ExecutionEngine,
    /// Where published outputs materialize.
    #[serde(default)]
    pub destination: Destination,
    /// Query ids published as marts (empty → focus_query_id only, legacy behavior).
    #[serde(default)]
    pub outputs: Vec<String>,
    /// Default materialization for published outputs.
    #[serde(default)]
    pub materialization: Materialization,
    /// Legacy mirror of `execution_engine` — kept for older readers; prefer engine.
    #[serde(default)]
    pub target_dialect: WarehouseDialect,
    /// Legacy: postgres connection when dialect was postgres (folded into destination).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_connection_id: Option<String>,
    #[serde(default)]
    pub last_dbt_export_path: Option<String>,
    /// Visual pipeline editor layout (ADR-0007).
    #[serde(default)]
    pub canvas: Option<CanvasLayout>,
    /// Durable mapping quality checks ([ADR-0027](../../../docs/adr/0027-mapping-quality-checks.md);
    /// typed IR [ADR-0029](../../../docs/adr/0029-typed-wire-contract.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mapping_checks: Vec<MappingCheck>,
    /// CheckRun results ([ADR-0027](../../../docs/adr/0027-mapping-quality-checks.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mapping_check_runs: Vec<CheckRun>,
}

impl Project {
    pub fn to_json_pretty(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let mut v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        migrate_project_document(&mut v)?;
        let mut p: Self = serde_json::from_value(v).map_err(|e| e.to_string())?;
        p.format_version = PROJECT_FORMAT_VERSION;
        // ADR-0035: singular left_attr ↔ left_attrs[] soft-migrate.
        for check in &mut p.mapping_checks {
            check.projection = check.projection.clone().normalize_attrs();
        }
        Ok(p)
    }

    /// Dialect used for SQL emit (= execution engine).
    pub fn emit_dialect(&self) -> WarehouseDialect {
        self.execution_engine.dialect()
    }
}

/// Peek on-disk `format_version` without full migrate (default 0). Used for `.bak` on save.
/// Malformed values are treated as 0 so bak still runs; load path validates strictly.
pub fn peek_format_version(raw: &str) -> u32 {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_object().and_then(|o| read_format_version(o).ok()))
        .unwrap_or(0)
}

/// Only absence → v0. Wrong type / non-integer / out of u32 range → error (ADR-0030).
fn read_format_version(obj: &serde_json::Map<String, Value>) -> Result<u32, String> {
    match obj.get("format_version") {
        None => Ok(0),
        Some(Value::Number(n)) => {
            let Some(u) = n.as_u64() else {
                return Err(
                    "format_version must be a non-negative integer (not float/negative)".into(),
                );
            };
            if u > u32::MAX as u64 {
                return Err(format!("format_version {u} out of range for u32"));
            }
            Ok(u as u32)
        }
        Some(_) => Err("format_version must be a JSON number".into()),
    }
}

/// Ordered document migrations + stamp [`PROJECT_FORMAT_VERSION`] (ADR-0030).
pub fn migrate_project_document(v: &mut Value) -> Result<(), String> {
    let Some(obj) = v.as_object_mut() else {
        return Err("project root must be a JSON object".into());
    };
    let mut ver = read_format_version(obj)?;
    if ver > PROJECT_FORMAT_VERSION {
        return Err(format!(
            "Unsupported project format_version {ver} (this app supports ≤ {PROJECT_FORMAT_VERSION})"
        ));
    }
    while ver < PROJECT_FORMAT_VERSION {
        match ver {
            0 => migrate_v0_to_v1(obj),
            other => {
                return Err(format!(
                    "missing migration from format_version {other} → {}",
                    other + 1
                ));
            }
        }
        ver += 1;
    }
    // ADR-0033: always strip warehouse KeyMap row bodies from the document (idempotent).
    strip_source_keymap_entries(obj);
    obj.insert(
        "format_version".into(),
        Value::Number(PROJECT_FORMAT_VERSION.into()),
    );
    Ok(())
}

/// ADR-0033 — `storage.kind=source` must not keep dictionary rows in project JSON.
fn strip_source_keymap_entries(obj: &mut serde_json::Map<String, Value>) {
    let Some(ws) = obj.get_mut("workspace").and_then(|w| w.as_object_mut()) else {
        return;
    };
    let mut source_ids = std::collections::HashSet::new();
    if let Some(maps) = ws.get_mut("key_maps").and_then(|m| m.as_array_mut()) {
        for map in maps {
            let Some(m) = map.as_object_mut() else {
                continue;
            };
            let is_source = m
                .get("storage")
                .and_then(|s| s.as_object())
                .and_then(|s| s.get("kind"))
                .and_then(|k| k.as_str())
                == Some("source");
            if is_source {
                if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                    source_ids.insert(id.to_string());
                }
                m.insert("entries".into(), Value::Array(vec![]));
            }
        }
    }
    // Also clear embedded ApplyKeyMap snapshots for source maps.
    let Some(queries) = ws.get_mut("queries").and_then(|q| q.as_array_mut()) else {
        return;
    };
    for query in queries {
        let Some(steps) = query
            .as_object_mut()
            .and_then(|q| q.get_mut("steps"))
            .and_then(|s| s.as_array_mut())
        else {
            continue;
        };
        for step in steps {
            let Some(s) = step.as_object_mut() else {
                continue;
            };
            if s.get("type").and_then(|t| t.as_str()) != Some("ApplyKeyMap") {
                continue;
            }
            let map_id = s
                .get("map_id")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    s.get("payload")
                        .and_then(|p| p.as_object())
                        .and_then(|p| p.get("map_id"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                });
            let Some(mid) = map_id else { continue };
            if !source_ids.contains(&mid) {
                continue;
            }
            if let Some(payload) = s.get_mut("payload").and_then(|p| p.as_object_mut()) {
                payload.insert("entries".into(), Value::Array(vec![]));
            } else {
                s.insert("entries".into(), Value::Array(vec![]));
            }
        }
    }
}

/// Soft-migrate legacy fields (engine/destination). Prefer [`migrate_project_document`].
pub fn migrate_project_value(v: &mut Value) {
    let _ = migrate_project_document(v);
}

fn migrate_v0_to_v1(obj: &mut serde_json::Map<String, Value>) {
    let legacy_dialect = obj
        .get("target_dialect")
        .and_then(|x| x.as_str())
        .unwrap_or("duckdb")
        .to_string();

    if !obj.contains_key("execution_engine") {
        obj.insert(
            "execution_engine".into(),
            Value::String(legacy_dialect.clone()),
        );
    }

    let engine = obj
        .get("execution_engine")
        .and_then(|x| x.as_str())
        .unwrap_or(legacy_dialect.as_str())
        .to_string();

    if !obj.contains_key("destination") {
        let conn = obj
            .get("target_connection_id")
            .cloned()
            .filter(|c| !c.is_null());
        let dest = if engine == "postgres" || legacy_dialect == "postgres" {
            let mut d = serde_json::Map::new();
            d.insert("kind".into(), Value::String("postgres".into()));
            if let Some(c) = conn {
                d.insert("connection_id".into(), c);
            }
            Value::Object(d)
        } else {
            serde_json::json!({
                "kind": "duckdb",
                "duckdb_path": "local.duckdb"
            })
        };
        obj.insert("destination".into(), dest);
    }

    // Keep target_dialect in sync with engine for older tooling.
    if let Some(eng) = obj.get("execution_engine").cloned() {
        obj.insert("target_dialect".into(), eng);
    }

    // Fold connection into destination if missing there.
    let fold_conn = obj.get("target_connection_id").cloned();
    if let Some(dest) = obj.get_mut("destination").and_then(|d| d.as_object_mut()) {
        if dest.get("kind").and_then(|k| k.as_str()) == Some("postgres")
            && dest.get("connection_id").is_none()
        {
            if let Some(c) = fold_conn {
                if !c.is_null() {
                    dest.insert("connection_id".into(), c);
                }
            }
        }
    }

    if !obj.contains_key("outputs") {
        obj.insert("outputs".into(), Value::Array(vec![]));
    }
    if !obj.contains_key("materialization") {
        obj.insert("materialization".into(), Value::String("table".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams};
    use crate::destination::DestinationKind;
    use crate::model::{QueryDef, TransformationStep, Workspace};

    #[test]
    fn project_json_roundtrip() {
        let p = Project {
            format_version: PROJECT_FORMAT_VERSION,
            id: "proj_1".into(),
            name: "demo".into(),
            project_uid: String::new(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![ConnectionDef {
                id: "conn_pg".into(),
                name: "local".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://u:p@localhost/db".into(),
                }),
                s3: None,
                duckdb: None,
            }],
            sources: vec![],
            workspace: Workspace {
                queries: vec![QueryDef {
                    id: "q1".into(),
                    name: "q1".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "/tmp/a.csv".into(),
                    }],
                    execution: Default::default(),
                }],
                focus_query_id: "q1".into(),
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
            canvas: Some(CanvasLayout {
                positions: [("q1".into(), CanvasPosition { x: 12.0, y: 34.0 })]
                    .into_iter()
                    .collect(),
            }),
            mapping_checks: vec![],
            mapping_check_runs: vec![],
        };
        let json = p.to_json_pretty().unwrap();
        let back = Project::from_json(&json).unwrap();
        assert_eq!(back.name, "demo");
        assert_eq!(back.execution_engine, ExecutionEngine::Duckdb);
        assert_eq!(back.destination.kind, DestinationKind::Duckdb);
    }

    #[test]
    fn legacy_postgres_target_migrates_without_sql_change() {
        let legacy = r#"{
            "id": "p",
            "name": "pg_only",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [{
                    "id": "q1",
                    "name": "q1",
                    "steps": [{
                        "type": "LoadPostgres",
                        "payload": {
                            "connection_string": "postgresql://u:p@localhost/db",
                            "schema": "public",
                            "table_name": "t"
                        }
                    }],
                    "execution": "local"
                }],
                "focus_query_id": "q1",
                "key_maps": []
            },
            "dbt_target": "v1",
            "target_dialect": "postgres",
            "target_connection_id": "conn_pg"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.execution_engine, ExecutionEngine::Postgres);
        assert_eq!(p.destination.kind, DestinationKind::Postgres);
        assert_eq!(p.destination.connection_id.as_deref(), Some("conn_pg"));
        assert_eq!(p.emit_dialect(), WarehouseDialect::Postgres);
        // Remains readable as postgres target for old helpers.
        assert_eq!(p.target_dialect, WarehouseDialect::Postgres);
    }

    #[test]
    fn mapping_check_ir_round_trips_on_project() {
        use crate::mapping_check::{
            CheckComparability, CheckRun, MappingCheck, MappingCheckProjection,
        };
        let mut p = Project {
            format_version: PROJECT_FORMAT_VERSION,
            id: "p".into(),
            name: "checks".into(),
            project_uid: String::new(),
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
            mapping_checks: vec![MappingCheck {
                id: "check_lab_quality".into(),
                name: "Lab".into(),
                map_id: "map_lab".into(),
                input_refs: vec!["q1".into()],
                group_attributes: vec![],
                cohort_predicate: String::new(),
                projection: MappingCheckProjection::LabV1,
                allow_decisions: vec![],
            }],
            mapping_check_runs: vec![CheckRun {
                id: "run_1".into(),
                check_id: "check_lab_quality".into(),
                ran_at: "2026-11-03T00:00:00Z".into(),
                map_revision: "abc".into(),
                input_revisions: vec![],
                check_definition_revision: "def".into(),
                total_positions: 1,
                cells: vec![],
                comparability: CheckComparability::Full,
                cells_incomplete: false,
                group_count: None,
                covered_positions: None,
                unmapped_positions: None,
            }],
        };
        let json = p.to_json_pretty().unwrap();
        assert!(json.contains("\"kind\": \"lab_v1\""));
        let back = Project::from_json(&json).unwrap();
        assert_eq!(back.mapping_checks.len(), 1);
        assert_eq!(back.mapping_check_runs[0].comparability, CheckComparability::Full);
        p.mapping_checks[0].projection = MappingCheckProjection::Attrs {
            host_query_id: "q1".into(),
            left_attr: "a".into(),
            right_attr: "b".into(),
            sample_column: "id".into(),
            left_attrs: vec!["a".into()],
            right_attrs: vec!["b".into()],
            sample_columns: vec!["id".into()],
        };
        let back2 = Project::from_json(&p.to_json_pretty().unwrap()).unwrap();
        assert!(matches!(
            back2.mapping_checks[0].projection,
            MappingCheckProjection::Attrs { .. }
        ));
    }

    #[test]
    fn mapping_check_malformed_rejected() {
        let bad = r#"{
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "mapping_checks": [{ "id": "c1", "name": "x" }]
        }"#;
        assert!(Project::from_json(bad).is_err());
    }

    #[test]
    fn format_version_stamped_on_legacy_load() {
        let legacy = r#"{
            "id": "p",
            "name": "legacy",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "target_dialect": "duckdb"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.format_version, PROJECT_FORMAT_VERSION);
        assert!(p.to_json_pretty().unwrap().contains("\"format_version\": 1"));
    }

    #[test]
    fn newer_format_version_refused() {
        let future = format!(
            r#"{{
            "format_version": {},
            "id": "p",
            "name": "future",
            "connections": [],
            "sources": [],
            "workspace": {{ "queries": [], "focus_query_id": "", "key_maps": [] }},
            "dbt_target": "v1"
        }}"#,
            PROJECT_FORMAT_VERSION + 1
        );
        let err = Project::from_json(&future).unwrap_err();
        assert!(
            err.contains("Unsupported project format_version"),
            "err={err}"
        );
    }

    #[test]
    fn peek_format_version_defaults_to_zero() {
        assert_eq!(peek_format_version(r#"{"id":"p"}"#), 0);
        assert_eq!(peek_format_version(r#"{"format_version":1}"#), 1);
    }

    #[test]
    fn format_version_string_refused() {
        let raw = r#"{
            "format_version": "2",
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1"
        }"#;
        let err = Project::from_json(raw).unwrap_err();
        assert!(
            err.contains("format_version must be a JSON number"),
            "err={err}"
        );
    }

    #[test]
    fn format_version_out_of_u32_refused() {
        let raw = r#"{
            "format_version": 4294967297,
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1"
        }"#;
        let err = Project::from_json(raw).unwrap_err();
        assert!(err.contains("out of range"), "err={err}");
    }

    #[test]
    fn source_keymap_entries_stripped_on_load() {
        let raw = r#"{
            "format_version": 1,
            "id": "p",
            "name": "src_map",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [],
                "focus_query_id": "",
                "key_maps": [{
                    "id": "map_wh",
                    "name": "WH",
                    "from_column": "from",
                    "to_column": "to",
                    "entries": [{"from": "a", "to": "1"}],
                    "storage": {
                        "kind": "source",
                        "connection_id": "c1",
                        "source": "public",
                        "table": "aliases"
                    }
                }]
            },
            "dbt_target": "v1"
        }"#;
        let p = Project::from_json(raw).unwrap();
        assert!(p.workspace.key_maps[0].entries.is_empty());
    }

    #[test]
    fn legacy_duckdb_target_migrates() {
        let legacy = r#"{
            "id": "p",
            "name": "files",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "target_dialect": "duckdb"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.execution_engine, ExecutionEngine::Duckdb);
        assert_eq!(p.destination.kind, DestinationKind::Duckdb);
    }
}
