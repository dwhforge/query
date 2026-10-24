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
    LoadParquet { path: String },
    LoadPostgres {
        connection_string: String,
        /// Database schema (e.g. `public`). Defaults for older payloads.
        #[serde(default = "default_pg_schema")]
        schema: String,
        table_name: String,
    },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    DeriveColumn { name: String, expression: String },
    GroupBy {
        dimensions: Vec<String>,
        aggregates: Vec<String>,
    },
    SortBy { column: String, descending: bool },
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

    /// True if any step is LoadPostgres (requires DuckDB postgres extension).
    pub fn uses_postgres(&self) -> bool {
        self.queries.iter().any(|q| {
            q.steps
                .iter()
                .any(|s| matches!(s, TransformationStep::LoadPostgres { .. }))
        })
    }
}
