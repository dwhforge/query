mod arrow_json;
mod export_e2e;
mod extensions;
mod join_diagnostics;
mod join_fuzzy;
mod join_lens;
mod join_near_miss;
mod join_prepare;
mod key_map_fuzzy;
mod key_map_write;
mod key_match;
#[cfg(test)]
mod key_match_bench;
mod load_seeds;
mod postgres_catalog;
mod preview;
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
    join_key_fuzzy_suggest, FuzzyAliasExample, FuzzyChatContext, FuzzyFieldSample, FuzzyKeySample,
    JoinKeyFuzzySuggest,
};
pub use join_near_miss::{
    join_key_near_miss, JoinKeyNearMiss, NearMissHypothesis, NearMissSide,
};
pub use join_prepare::{
    clear_join_prepare, clear_prepare_progress, ensure_join_sides_materialized,
    format_prepare_hint, get_prepare_progress, join_prepare_status, prepare_join_inputs,
    prepare_join_inputs_with_progress, preview_prepared_join_side, set_prepare_progress,
    JoinPrepareProgress, JoinPrepareResult, JoinPrepareStatus,
};
pub use key_map_fuzzy::{key_map_fuzzy_suggest, KeyMapFuzzySuggest, KeyMapMatchSource};
pub use key_match::{FuzzyPair, KeyMatchOptions};
pub use key_map_write::{
    key_map_content_hash, read_key_map, read_key_map_from_postgres, read_key_map_with_hash,
    write_key_map, write_key_map_to_postgres, write_key_map_with_expected, KeyMapReadResult,
    KeyMapWriteResult,
};
pub use load_seeds::collect_load_seeds;
pub use postgres_catalog::{
    describe_postgres_object, list_postgres_objects, test_postgres_connection,
    PostgresColumn, PostgresObject,
};
pub use preview::{
    describe_workspace, preview_pipeline, preview_workspace, ColumnMetadata, PreviewResult,
};
pub use session::{DbSession, QueryCancelHandle};
pub use session_limits::{
    map_engine_error, resolve_memory_limit, resolve_temp_directory, ENV_MEMORY, ENV_TEMP,
};
