//! Durable Project document (`project.json`) — ADR-0009 / ADR-0012.

use crate::connection::ConnectionDef;
use crate::dialect::WarehouseDialect;
use crate::model::Workspace;
use crate::producers::DbtTarget;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Csv,
    Parquet,
    Postgres,
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
    /// dbt Core major line (v1/v2) — not warehouse dialect.
    #[serde(default)]
    pub dbt_target: DbtTarget,
    /// Warehouse dialect for export emit + `execution=target` preview (ADR-0014).
    #[serde(default)]
    pub target_dialect: WarehouseDialect,
    /// Postgres Connection id when `target_dialect=postgres`.
    #[serde(default)]
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
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams};
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
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: Some(CanvasLayout {
                positions: [(
                    "q1".into(),
                    CanvasPosition { x: 12.0, y: 34.0 },
                )]
                .into_iter()
                .collect(),
            }),
        };
        let json = p.to_json_pretty().unwrap();
        let back = Project::from_json(&json).unwrap();
        assert_eq!(back.name, "demo");
        assert_eq!(back.connections.len(), 1);
        assert_eq!(back.workspace.focus_query_id, "q1");
        assert_eq!(
            back.canvas
                .as_ref()
                .unwrap()
                .positions
                .get("q1")
                .unwrap()
                .x,
            12.0
        );
    }
}
