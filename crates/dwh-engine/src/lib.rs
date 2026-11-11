mod apply_multi_output_exec;
mod arrow_json;
mod compile;
mod export_e2e;
mod extensions;
mod join_diagnostics;
mod join_fuzzy;
mod join_lens;
mod join_near_miss;
mod join_prepare;
mod key_map_delta;
mod key_map_fuzzy;
mod key_map_write;
mod key_match;
mod matching;
#[cfg(test)]
mod key_match_bench;
mod load_seeds;
mod postgres_catalog;
mod preview;
mod query_map_validate;
mod secrets;
mod session;
mod session_limits;

pub use extensions::{
    duckdb_platform, duckdb_version_tag, extensions_dir_display, parquet_available,
    path_needs_httpfs, set_extensions_dir,
};
pub use join_diagnostics::{
    join_diagnostics, join_diagnostics_with_limit, JoinDiagSample, JoinDiagnostics,
    JOIN_DIAG_SAMPLE_LIMIT,
};
pub use join_lens::{
    blame_unmatched_key, explain_join_key, explain_join_rows, fingerprint_key,
    BlameUnmatchedKeyResult, ExplainJoinKeyResult, ExplainJoinRowsResult, JoinKeySide,
    JoinKeyTuple, JoinRowExplanation, JOIN_LENS_KEY_SAMPLE_LIMIT, JOIN_LENS_MAX_KEYS,
    JOIN_LENS_MAX_MATCHES,
};
pub use join_fuzzy::{
    join_key_fuzzy_suggest, join_key_fuzzy_suggest_on, FuzzyAliasExample, FuzzyChatContext,
    FuzzyFieldSample, FuzzyKeySample,
    JoinKeyFuzzySuggest,
};
pub use join_near_miss::{
    join_key_near_miss, JoinKeyNearMiss, NearMissHypothesis, NearMissSide,
};
pub use join_prepare::{
    clear_join_prepare, clear_prepare_progress, ensure_join_sides_materialized,
    format_prepare_hint, get_prepare_progress, join_prepare_status, prepare_join_inputs,
    prepare_join_inputs_with_progress, preview_prepared_join_side,
    preview_prepared_join_side_filtered, set_prepare_progress,
    JoinPrepareProgress, JoinPrepareResult, JoinPrepareStatus,
};
pub use key_map_fuzzy::{key_map_fuzzy_suggest, KeyMapFuzzySuggest, KeyMapMatchSource};
pub use key_match::{FuzzyPair, KeyMatchOptions};
pub use matching::{
    accept_draft_decision, bulk_saveable, classify_merge, commit_blocked_reason,
    detect_proposal_conflicts, gate_commit_write_policy, map_key_token, map_row_exists,
    matching_retrieve, plan_bulk_confirm, validate_llm_intake, LlmIntakeRequest,
    MatchingAmbiguityPolicy, MatchingCandidate, MatchingDecision, MatchingDecisionKind,
    MatchingFieldRole, MatchingMapRowSnapshot, MatchingMergeItem, MatchingMergeOutcome,
    MatchingPlan, MatchingPlanComparison, MatchingProposal, MatchingProposalState,
    MatchingProvenance, MatchingRetrieveRequest, MatchingRetrieveResult, MatchingRunMetrics,
    MatchingRunMode, MatchingScopeKind, MatchingSourceRow, MatchingTargetRow,
    MatchingValidateError, MaterializedDecision, LLM_CANDIDATES_PER_KEY, LLM_RETRIES_PER_REQUEST,
    LOCAL_TARGET_UNIVERSE_ROWS, MASS_RUN_UNIQUE_KEYS, MAX_LLM_CALLS_PER_RUN,
    PARALLEL_LLM_REQUESTS, RETRIEVAL_SHORTLIST_PER_KEY, TRIAL_UNIQUE_KEYS,
};
pub use key_map_delta::{
    validate_mapping_delta, KeyMapDirtyBaseline, KeyMapDirtyDelta, ValidatedMappingDelta,
};
pub use key_map_write::{
    key_map_content_hash, read_key_map, read_key_map_from_postgres, read_key_map_paged,
    read_key_map_with_hash, write_key_map, write_key_map_delta_to_postgres,
    write_key_map_to_postgres, write_key_map_with_delta, write_key_map_with_expected,
    KeyMapReadQuery, KeyMapReadResult, KeyMapWriteResult,
};
pub use compile::{
    collect_sql_model_schemas, compile_ctes_for_execution, compile_ctes_from,
    compile_focus_sql, compile_focus_sql_for_execution, prepare_operation, prepare_workspace,
    validate_prepared, PreparedWorkspace,
};
pub use load_seeds::{collect_load_seeds, LoadSeedDiagnostic, LoadSeedsResult};
pub use postgres_catalog::{
    describe_postgres_object, diagnose_mapping_relation, list_postgres_objects,
    scan_postgres_import, test_postgres_connection, PostgresColumn, PostgresObject,
};
pub use preview::{
    describe_workspace, preview_pipeline, preview_workspace, preview_workspace_limited,
    ColumnMetadata, PreviewResult, PREVIEW_SAMPLE_LIMIT,
};
pub use session::{DbSession, QueryCancelHandle};
pub use session_limits::{
    map_engine_error, resolve_memory_limit, resolve_temp_directory, ENV_MEMORY, ENV_TEMP,
};
