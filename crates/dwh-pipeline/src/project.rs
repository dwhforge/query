//! Durable Project document (`project.json`) — ADR-0009 / ADR-0012 / engine×destination.

use crate::connection::ConnectionDef;
use crate::destination::{Destination, ExecutionEngine, Materialization};
use crate::dialect::WarehouseDialect;
use crate::model::Workspace;
use crate::producers::DbtTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
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
}

impl Project {
    pub fn to_json_pretty(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let mut v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        migrate_project_value(&mut v);
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// Dialect used for SQL emit (= execution engine).
    pub fn emit_dialect(&self) -> WarehouseDialect {
        self.execution_engine.dialect()
    }
}

/// Soft-migrate legacy `target_dialect` / `target_connection_id` into engine + destination.
pub fn migrate_project_value(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };

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
            id: "proj_1".into(),
            name: "demo".into(),
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
