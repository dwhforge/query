pub mod compiler;
pub mod connection;
pub mod dbt_cli;
pub mod destination;
pub mod derive_ops;
pub mod dialect;
pub mod emit;
pub mod export_manifest;
pub mod export_tree;
pub mod file_path;
pub mod graph;
pub mod key_map_sync;
pub mod keymap_query;
pub mod mapping_check;
pub mod model;
pub mod parquet_scan;
pub mod pg_import;
pub mod postgres_attach;
pub mod producers;
pub mod project;
pub mod references;
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
    key_map_seed_csv_cols, key_map_seed_csv_full, key_map_seed_csv_named, key_map_seed_csv_outputs,
    key_map_seed_name, normalize_column_expr, normalize_key_column_expr, parse_key_map_seed_csv,
    parse_key_map_seed_csv_cols, parse_key_map_seed_csv_full, parse_key_map_seed_csv_mode,
    parse_key_map_seed_csv_outputs, parse_key_map_seed_csv_outputs_ex,
    rename_select_list, resolve_source_column, select_list_aligned,
    sql_union_all_aligned, substitute_query_placeholders, union_column_names,
    validate_unambiguous_ascii_names, ApplyEmitSpec, EmitSchemaOpts, KeyMapCsvMode,
    SeedCsvHeaderPolicy,
};
pub use key_map_sync::{
    push_key_map_to_export, remove_key_map_from_export, sync_key_maps_from_export,
    KeyMapSyncResult, KEYMAP_CONFLICT_DIR,
};
pub use keymap_query::{
    assert_no_query_map_cycle, direct_deps_with_maps, query_backed_query_id,
    query_map_full_set_check_sql, query_maps_applied_from, validate_query_map_binding,
    validate_query_map_rows, validate_query_map_rows_ex,
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
    apply_keymap_columns, apply_keymap_output_bindings, ApplyKeyMapOutputBinding, JoinType,
    KeyMapAuthoringContext, KeyMapDef, KeyMapEntry, KeyMapStorage, KeyMapTimeMode, NormalizeOp,
    ObjectKind, ObjectTarget, QueryDef, TransformationStep, Workspace,
};
pub use project::{ConnectionBinding, ProjectReference};
pub use references::{
    copy_referenced_object, ensure_project_uid, fork_project_identity, make_project_reference,
    project_revision, reference_consumers, reference_statuses, refresh_reference, relink_reference,
    resolve_operation, CopiedObject, LoweredOperation, ProvenanceRecord, ReferenceState,
    ReferenceStatus, ResolveInput, ResolveKind,
};
pub use producers::{
    build_export_plan, build_export_plan_routed, dbt_model_name, dbt_model_names_published,
    preview_dbt_model_sql, preview_dbt_model_sql_with_seeds,
    preview_dbt_model_sql_with_seeds_and_sources, DbtProducer, DbtTarget, OutputProducer,
    PreviewDbtModel,
};
pub use mapping_check::{
    CheckAggregateCell, CheckComparability, CheckDeltaAttribution, CheckInputRevision, CheckRun,
    MappingAllowDecision, MappingCheck, MappingCheckProjection,
};
pub use pg_import::{
    adopt_fresh_write_metadata, commit_pg_import, diagnosis_notes, import_fingerprint,
    import_write_refusal, metadata_matches, assert_read_only_catalog_sql,
    columns_catalog_sql, constraints_catalog_sql, diagnose_mapping_sql, foreign_keys_catalog_sql,
    relations_catalog_sql, viewdef_catalog_sql, ConfirmedBinding, ImportColumn, MappingDecision,
    MappingKeyDiagnosis,
    PgImportOutcome, PgImportPlan, PgImportRegistry, PgRelationSnapshot, PlannedRelation,
};
pub use file_path::{
    looks_absolute_cross_platform, portable_relative, relativize_project_file_paths,
    resolve_for_engine, resolve_workspace_file_paths, try_relativize, FilePathKind,
};
pub use project::{
    migrate_project_document, parquet_hive_partitioning, peek_format_version, CanvasLayout,
    CanvasPosition, Project, SourceDef, SourceKind, PROJECT_FORMAT_VERSION,
};
pub use secrets::{
    connections_for_disk, extract_connection_secret, merge_connection_list_secrets,
    merge_project_secrets, migrate_legacy_project_secrets, project_for_disk,
    strip_connection_secrets, upsert_global_secrets, ConnectionSecret, SecretsFile,
};
