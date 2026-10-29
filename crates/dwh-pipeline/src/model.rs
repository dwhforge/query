use crate::connection::ConnectionDef;
use crate::derive_ops::{DeriveMode, DeriveOp, SqlDialectTag};
use crate::dialect::QueryExecution;
use serde::{Deserialize, Serialize};

fn default_pg_schema() -> String {
    "public".into()
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinType {
    Inner,
    Left,
    Right,
    Full,
}

impl JoinType {
    pub fn sql_keyword(&self) -> &'static str {
        match self {
            JoinType::Inner => "INNER JOIN",
            JoinType::Left => "LEFT JOIN",
            JoinType::Right => "RIGHT JOIN",
            JoinType::Full => "FULL OUTER JOIN",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet {
        path: String,
        /// Project Connection id (`s3`) for remote paths — ADR-0012.
        #[serde(default)]
        connection_id: Option<String>,
    },
    LoadPostgres {
        /// Preferred: Project Connection id (`postgres`).
        #[serde(default)]
        connection_id: Option<String>,
        /// Legacy / resolved DSN (filled when connection_id absent).
        #[serde(default)]
        connection_string: String,
        #[serde(default = "default_pg_schema")]
        schema: String,
        table_name: String,
    },
    /// Read a relation from an attached DuckDB database file (read-only source).
    LoadDuckdb {
        #[serde(default)]
        connection_id: Option<String>,
        /// Absolute / project-relative path to `.duckdb` when connection_id absent.
        #[serde(default)]
        path: String,
        #[serde(default = "default_pg_schema")]
        schema: String,
        table_name: String,
    },
    /// Start from another query’s output (`ref` in dbt). Must be the first step.
    FromQuery { query_id: String },
    /// Hand-written SQL as the query root (ready-made model body). Must be first.
    /// Dialect = author’s prod warehouse; DuckDB is preview-only.
    SqlModel { raw_sql: String },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    /// Derived column: ready-made op or free SQL (legacy projects = Sql + expression).
    DeriveColumn {
        name: String,
        /// Free SQL when `mode=sql` (also set when migrating legacy projects).
        #[serde(default)]
        expression: String,
        #[serde(default)]
        mode: DeriveMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<DeriveOp>,
        /// Dialect of `expression` when mode=sql; unknown if not determinable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sql_dialect: Option<SqlDialectTag>,
    },
    GroupBy {
        dimensions: Vec<String>,
        aggregates: Vec<String>,
    },
    SortBy { column: String, descending: bool },
    /// Keep first N rows after prior steps (typically after SortBy).
    Limit { n: u64 },
    Join {
        right_query_id: String,
        join_type: JoinType,
        left_on: Vec<String>,
        right_on: Vec<String>,
    },
    Append { other_query_ids: Vec<String> },
    CustomSql { raw_sql: String },
    /// Deterministic key cleanup before Join (trim/case/spaces/zeros). Overwrites in place.
    NormalizeKey {
        columns: Vec<String>,
        ops: Vec<NormalizeOp>,
    },
    /// Remap join-key values via a KeyMap (`from` → `to`). Entries are a snapshot for emit.
    ApplyKeyMap {
        column: String,
        map_id: String,
        #[serde(default)]
        entries: Vec<KeyMapEntry>,
    },
}

/// One From→To alias row. `from` must be unique within a [`KeyMapDef`].
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KeyMapEntry {
    pub from: String,
    pub to: String,
}

/// Where the From→To table lives (ADR-0020). Default = generated dbt seed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyMapStorage {
    /// Write / sync `seeds/map_*.csv` (git SoT after first export).
    #[default]
    Seed,
    /// Existing dbt model: `{{ ref('model') }}`.
    Ref {
        model: String,
    },
    /// Existing dbt source: `{{ source('name', 'table') }}`.
    Source {
        source: String,
        table: String,
        /// Optional Postgres connection for read/write-back (UI / host).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
    },
}

fn default_from_col() -> String {
    "from".into()
}
fn default_to_col() -> String {
    "to".into()
}

/// Named join-key alias table (project resource).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KeyMapDef {
    pub id: String,
    pub name: String,
    /// Row cache for editor / DuckDB preview (SoT when `storage=seed`).
    #[serde(default)]
    pub entries: Vec<KeyMapEntry>,
    /// Backend relation — seed (default), dbt ref, or dbt source.
    #[serde(default)]
    pub storage: KeyMapStorage,
    /// Column on the map relation used as From (default `from`).
    #[serde(default = "default_from_col")]
    pub from_column: String,
    /// Column on the map relation used as To (default `to`).
    #[serde(default = "default_to_col")]
    pub to_column: String,
}

impl KeyMapDef {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            entries: vec![],
            storage: KeyMapStorage::Seed,
            from_column: default_from_col(),
            to_column: default_to_col(),
        }
    }

    /// Reject empty / duplicate `from` (after trim) and empty `to` for seed-backed maps.
    pub fn validate(&self) -> Result<(), String> {
        match &self.storage {
            KeyMapStorage::Ref { model } => {
                if model.trim().is_empty() {
                    return Err(format!("KeyMap '{}': ref model is empty", self.id));
                }
            }
            KeyMapStorage::Source { source, table, .. } => {
                if source.trim().is_empty() || table.trim().is_empty() {
                    return Err(format!(
                        "KeyMap '{}': source name and table are required",
                        self.id
                    ));
                }
            }
            KeyMapStorage::Seed => {}
        }
        if self.from_column.trim().is_empty() || self.to_column.trim().is_empty() {
            return Err(format!(
                "KeyMap '{}': from_column/to_column must be non-empty",
                self.id
            ));
        }
        // External relations may have empty local entries (SoT is the table).
        if matches!(self.storage, KeyMapStorage::Seed) || !self.entries.is_empty() {
            let mut seen = std::collections::HashSet::new();
            for e in &self.entries {
                let from = e.from.trim();
                if from.is_empty() {
                    return Err(format!("KeyMap '{}': empty from", self.id));
                }
                if e.to.is_empty() {
                    return Err(format!("KeyMap '{}': empty to for from '{from}'", self.id));
                }
                if !seen.insert(from.to_string()) {
                    return Err(format!(
                        "KeyMap '{}': duplicate from '{from}'",
                        self.id
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn is_seed_backed(&self) -> bool {
        matches!(self.storage, KeyMapStorage::Seed)
    }
}

/// Deterministic normalize ops (near-miss Apply → NormalizeKey). Order = nest order.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NormalizeOp {
    Trim,
    Lower,
    Upper,
    CollapseSpace,
    LtrimZeros,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct QueryDef {
    pub id: String,
    pub name: String,
    pub steps: Vec<TransformationStep>,
    /// Preview engine for this node only (ADR-0014). Default `local` (DuckDB).
    #[serde(default)]
    pub execution: QueryExecution,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Workspace {
    pub queries: Vec<QueryDef>,
    pub focus_query_id: String,
    /// Join-key alias maps (ADR-0020). Source of truth in project JSON; seeds on export.
    #[serde(default)]
    pub key_maps: Vec<KeyMapDef>,
}

impl Workspace {
    pub fn from_linear_steps(steps: Vec<TransformationStep>) -> Self {
        Self {
            queries: vec![QueryDef {
                id: "main".into(),
                name: "main".into(),
                steps,
                execution: QueryExecution::default(),
            }],
            focus_query_id: "main".into(),
            key_maps: vec![],
        }
    }

    pub fn key_map(&self, id: &str) -> Option<&KeyMapDef> {
        self.key_maps.iter().find(|m| m.id == id)
    }

    pub fn query(&self, id: &str) -> Option<&QueryDef> {
        self.queries.iter().find(|q| q.id == id)
    }

    pub fn uses_postgres(&self) -> bool {
        self.queries.iter().any(|q| {
            q.steps
                .iter()
                .any(|s| matches!(s, TransformationStep::LoadPostgres { .. }))
        })
    }

    /// Collect connection ids referenced by Load* steps.
    pub fn referenced_connection_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for q in &self.queries {
            for s in &q.steps {
                match s {
                    TransformationStep::LoadParquet {
                        connection_id: Some(id),
                        ..
                    }
                    | TransformationStep::LoadPostgres {
                        connection_id: Some(id),
                        ..
                    } => {
                        if !ids.contains(id) {
                            ids.push(id.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        ids
    }

    /// Resolve `connection_id` → inline DSN for compile/runtime (does not strip ids).
    pub fn resolve_postgres_dsns(&self, connections: &[ConnectionDef]) -> Result<Workspace, String> {
        let mut out = self.clone();
        for q in &mut out.queries {
            for step in &mut q.steps {
                if let TransformationStep::LoadPostgres {
                    connection_id,
                    connection_string,
                    ..
                } = step
                {
                    if let Some(cid) = connection_id {
                        let c = connections
                            .iter()
                            .find(|c| &c.id == cid)
                            .ok_or_else(|| format!("Unknown connection_id '{cid}'"))?;
                        let dsn = c.postgres_dsn().ok_or_else(|| {
                            format!("Connection '{cid}' is not a postgres connection with DSN")
                        })?;
                        *connection_string = dsn.to_string();
                    } else if connection_string.trim().is_empty() {
                        return Err(
                            "LoadPostgres requires connection_id or connection_string".into()
                        );
                    }
                }
            }
        }
        Ok(out)
    }
}
