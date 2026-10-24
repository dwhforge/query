use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet { path: String },
    LoadPostgres {
        connection_string: String,
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
    CustomSql { raw_sql: String },
}
