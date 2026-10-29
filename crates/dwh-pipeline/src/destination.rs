//! Execution engine vs materialization destination (amends ADR-0014 / ADR-0015).

use crate::dialect::WarehouseDialect;
use serde::{Deserialize, Serialize};

/// Where transform SQL is authored and what dbt adapter runs the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionEngine {
    #[default]
    Duckdb,
    Postgres,
}

impl ExecutionEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionEngine::Duckdb => "duckdb",
            ExecutionEngine::Postgres => "postgres",
        }
    }

    /// SQL dialect for emit / free SQL (not where tables land).
    pub fn dialect(self) -> WarehouseDialect {
        match self {
            ExecutionEngine::Duckdb => WarehouseDialect::Duckdb,
            ExecutionEngine::Postgres => WarehouseDialect::Postgres,
        }
    }

    pub fn from_dialect(d: WarehouseDialect) -> Self {
        match d {
            WarehouseDialect::Duckdb => ExecutionEngine::Duckdb,
            WarehouseDialect::Postgres => ExecutionEngine::Postgres,
        }
    }
}

/// Where dbt materializes published outputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DestinationKind {
    #[default]
    Duckdb,
    Postgres,
}

impl DestinationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DestinationKind::Duckdb => "duckdb",
            DestinationKind::Postgres => "postgres",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Destination {
    pub kind: DestinationKind,
    /// Postgres connection when `kind=postgres`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Path for persistent DuckDB when `kind=duckdb` (default `local.duckdb` in export).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duckdb_path: Option<String>,
    /// Postgres schema for published marts (duckdb→pg ATTACH and pure postgres engine).
    /// Default `public` when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

impl Default for Destination {
    fn default() -> Self {
        Self {
            kind: DestinationKind::Duckdb,
            connection_id: None,
            duckdb_path: Some("local.duckdb".into()),
            schema: None,
        }
    }
}

impl Destination {
    pub fn duckdb(path: impl Into<String>) -> Self {
        Self {
            kind: DestinationKind::Duckdb,
            connection_id: None,
            duckdb_path: Some(path.into()),
            schema: None,
        }
    }

    pub fn postgres(connection_id: Option<String>) -> Self {
        Self {
            kind: DestinationKind::Postgres,
            connection_id,
            duckdb_path: None,
            schema: Some("public".into()),
        }
    }

    /// Schema where published marts land in Postgres (`public` if unset).
    pub fn postgres_schema(&self) -> &str {
        self.schema
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("public")
    }
}

/// Default dbt materialization for published outputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Materialization {
    View,
    #[default]
    Table,
}

impl Materialization {
    pub fn as_str(self) -> &'static str {
        match self {
            Materialization::View => "view",
            Materialization::Table => "table",
        }
    }
}

/// Four product routes = engine × destination (+ allowed sources).
pub fn route_allows_file_sources(engine: ExecutionEngine) -> bool {
    // Files/S3 are read by DuckDB; postgres engine still needs landing.
    matches!(engine, ExecutionEngine::Duckdb)
}

/// True when export uses dbt-duckdb with Postgres as writable catalog.
pub fn is_duckdb_to_postgres(engine: ExecutionEngine, dest: DestinationKind) -> bool {
    matches!(
        (engine, dest),
        (ExecutionEngine::Duckdb, DestinationKind::Postgres)
    )
}
