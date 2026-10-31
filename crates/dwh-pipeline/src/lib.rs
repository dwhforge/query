pub mod compiler;
pub mod connection;
pub mod dbt_cli;
pub mod destination;
pub mod derive_ops;
pub mod dialect;
pub mod emit;
pub mod export_manifest;
pub mod export_tree;
pub mod graph;
pub mod key_map_sync;
pub mod model;
pub mod parquet_scan;
pub mod postgres_attach;
pub mod producers;
pub mod project;
pub mod schema;
pub mod secrets;
pub mod sql_escape;

pub use compiler::{CompiledCtes, GraphCompiler, PipelineCompiler};
pub use graph::{
    cte_name, join_left_input_is_expensive, join_right_input_is_expensive,
    query_closure_is_expensive, step_is_derived_expensive, steps_are_derived_expensive,
    topo_queries, topo_queries_from,
};
pub use parquet_scan::{read_parquet_call, read_parquet_call_opts};
pub use sql_escape::{escape_sql_string, quote_ident};
pub use connection::{ConnectionDef, ConnectionKind, DuckdbParams, PostgresParams, S3Params};
pub use destination::{
    is_duckdb_to_postgres, route_allows_file_sources, Destination, DestinationKind,
    ExecutionEngine, Materialization,
};
pub use derive_ops::{
    derive_op_result_type, emit_derive_op, resolve_derive_expression, DeriveMode, DeriveOp,
    DeriveOpId, DeriveResultType, SqlDialectTag, TrimCaseMode,
};
pub use dialect::{
    sql_rename_column, sql_union_all, validate_engine_execution, validate_target_execution,
    workspace_needs_s3_landing, QueryExecution, WarehouseDialect,
};
pub use emit::{
    ascii_fold_name, emit_transform_step, emit_transform_step_ex, key_map_seed_csv,
    key_map_seed_csv_cols, key_map_seed_csv_named, key_map_seed_name, normalize_column_expr,
    normalize_key_column_expr, parse_key_map_seed_csv, parse_key_map_seed_csv_cols,
    parse_key_map_seed_csv_mode, rename_select_list, resolve_source_column, select_list_aligned,
    sql_union_all_aligned, substitute_query_placeholders, union_column_names,
    validate_unambiguous_ascii_names, EmitSchemaOpts, KeyMapCsvMode,
};
pub use key_map_sync::{
    push_key_map_to_export, remove_key_map_from_export, sync_key_maps_from_export,
    KeyMapSyncResult, KEYMAP_CONFLICT_DIR,
};
pub use schema::{
    apply_step_schema, infer_workspace_schemas, infer_workspace_schemas_ex, StepSchema,
    WorkspaceSchemas,
};
pub use postgres_attach::{
    duckdb_file_attach_alias, duckdb_postgres_relation, postgres_attach_alias,
};
pub use dbt_cli::{
    dbt_build, dbt_build_with_env, dbt_env_from_connections, dbt_parse, dbt_parse_with_env,
    dbt_run, dbt_run_with_env, default_dbt_venv_candidates, resolve_dbt_bin, DbtParseOutcome,
};
pub use export_manifest::{
    commit_export_plan, find_conflicts, hash_content, load_manifest, ExportManifest, MANIFEST_FILE,
};
pub use export_tree::{list_export_tree, ExportResult};
pub use model::{
    apply_keymap_columns, JoinType, KeyMapDef, KeyMapEntry, KeyMapStorage, NormalizeOp, QueryDef,
    TransformationStep, Workspace,
};
pub use producers::{
    build_export_plan, build_export_plan_routed, dbt_model_name, dbt_model_names_published,
    preview_dbt_model_sql, preview_dbt_model_sql_with_seeds,
    preview_dbt_model_sql_with_seeds_and_sources, DbtProducer, DbtTarget, OutputProducer,
    PreviewDbtModel,
};
pub use project::{
    parquet_hive_partitioning, CanvasLayout, CanvasPosition, Project, SourceDef, SourceKind,
};
pub use secrets::{
    connections_for_disk, extract_connection_secret, merge_connection_list_secrets,
    merge_project_secrets, migrate_legacy_project_secrets, project_for_disk,
    strip_connection_secrets, upsert_global_secrets, ConnectionSecret, SecretsFile,
};
