use crate::connection::ConnectionDef;
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
    /// Start from another query’s output (`ref` in dbt). Must be the first step.
    FromQuery { query_id: String },
    /// Hand-written SQL as the query root (ready-made model body). Must be first.
    /// Dialect = author’s prod warehouse; DuckDB is preview-only.
    SqlModel { raw_sql: String },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    DeriveColumn { name: String, expression: String },
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
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct QueryDef {
    pub id: String,
    pub name: String,
    pub steps: Vec<TransformationStep>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Workspace {
    pub queries: Vec<QueryDef>,
    pub focus_query_id: String,
}

impl Workspace {
    pub fn from_linear_steps(steps: Vec<TransformationStep>) -> Self {
        Self {
            queries: vec![QueryDef {
                id: "main".into(),
                name: "main".into(),
                steps,
            }],
            focus_query_id: "main".into(),
        }
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
