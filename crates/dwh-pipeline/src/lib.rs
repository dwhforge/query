pub mod compiler;
pub mod connection;
pub mod dbt_cli;
pub mod dialect;
pub mod emit;
pub mod export_tree;
pub mod graph;
pub mod model;
pub mod postgres_attach;
pub mod producers;
pub mod project;
pub mod secrets;
pub mod sql_escape;

pub use compiler::{GraphCompiler, PipelineCompiler};
pub use connection::{ConnectionDef, ConnectionKind, PostgresParams, S3Params};
pub use dialect::{
    sql_rename_column, sql_union_all, validate_target_execution, workspace_needs_s3_landing,
    QueryExecution, WarehouseDialect,
};
pub use emit::{
    emit_transform_step, emit_transform_step_ex, resolve_source_column, select_list_aligned,
    sql_union_all_aligned, substitute_query_placeholders, union_column_names,
};
pub use postgres_attach::{duckdb_postgres_relation, postgres_attach_alias};
pub use dbt_cli::{dbt_parse, default_dbt_venv_candidates, resolve_dbt_bin, DbtParseOutcome};
pub use export_tree::{list_export_tree, ExportResult};
pub use model::{JoinType, QueryDef, TransformationStep, Workspace};
pub use producers::{
    preview_dbt_model_sql, DbtProducer, DbtTarget, OutputProducer, PreviewDbtModel,
};
pub use project::{CanvasLayout, CanvasPosition, Project, SourceDef, SourceKind};
pub use secrets::{
    extract_connection_secret, merge_project_secrets, project_for_disk, strip_connection_secrets,
    ConnectionSecret, SecretsFile,
};
