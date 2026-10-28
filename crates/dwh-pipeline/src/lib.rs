pub mod compiler;
pub mod connection;
pub mod dbt_cli;
pub mod dialect;
pub mod emit;
pub mod export_manifest;
pub mod export_tree;
pub mod graph;
pub mod model;
pub mod postgres_attach;
pub mod producers;
pub mod project;
pub mod schema;
pub mod secrets;
pub mod sql_escape;

pub use compiler::{GraphCompiler, PipelineCompiler};
pub use connection::{ConnectionDef, ConnectionKind, PostgresParams, S3Params};
pub use dialect::{
    sql_rename_column, sql_union_all, validate_target_execution, workspace_needs_s3_landing,
    QueryExecution, WarehouseDialect,
};
pub use emit::{
    ascii_fold_name, emit_transform_step, emit_transform_step_ex, rename_select_list,
    resolve_source_column, select_list_aligned, sql_union_all_aligned,
    substitute_query_placeholders, union_column_names, validate_unambiguous_ascii_names,
    EmitSchemaOpts,
};
pub use schema::{apply_step_schema, infer_workspace_schemas, StepSchema, WorkspaceSchemas};
pub use postgres_attach::{duckdb_postgres_relation, postgres_attach_alias};
pub use dbt_cli::{
    dbt_parse, dbt_run, default_dbt_venv_candidates, resolve_dbt_bin, DbtParseOutcome,
};
pub use export_manifest::{
    commit_export_plan, find_conflicts, hash_content, load_manifest, ExportManifest, MANIFEST_FILE,
};
pub use export_tree::{list_export_tree, ExportResult};
pub use model::{JoinType, QueryDef, TransformationStep, Workspace};
pub use producers::{
    build_export_plan, dbt_model_name, preview_dbt_model_sql, preview_dbt_model_sql_with_seeds,
    DbtProducer, DbtTarget, OutputProducer, PreviewDbtModel,
};
pub use project::{CanvasLayout, CanvasPosition, Project, SourceDef, SourceKind};
pub use secrets::{
    extract_connection_secret, merge_project_secrets, project_for_disk, strip_connection_secrets,
    ConnectionSecret, SecretsFile,
};
