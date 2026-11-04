//! KeyMap warehouse read/write commands (ADR-0022 / ADR-0032 / ADR-0029).

use crate::error::{HostError, RpcError};
use dwh_engine::{
    read_key_map_paged as run_read_key_map_paged,
    write_key_map_with_delta as run_write_key_map_with_delta, DbSession, KeyMapDirtyDelta,
    KeyMapReadQuery, KeyMapReadResult, KeyMapWriteResult,
};
use dwh_pipeline::KeyMapDef;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// IPC args for `read_key_map` / `write_key_map` (ADR-0029 wire DTO).
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapWhArgs {
    #[ts(type = "import(\"../pipeline\").KeyMapDef")]
    pub key_map: KeyMapDef,
    pub connection_string: String,
    /// Optimistic concurrency token from the prior read (checked under lock in TX).
    #[serde(default)]
    #[ts(optional)]
    pub expected_content_hash: Option<String>,
    /// ADR-0022 dirty delta; when set, only these upserts/deletes are applied.
    #[serde(default)]
    #[ts(optional, type = "import(\"../../lib/bridge\").KeyMapDirtyDelta")]
    pub delta: Option<KeyMapDirtyDelta>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<u64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub offset: Option<u64>,
    #[serde(default)]
    #[ts(optional)]
    pub from_prefix: Option<String>,
}

/// Wire response for `write_key_map` (ADR-0029).
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
pub struct KeyMapWriteResultDto {
    pub schema: String,
    pub table: String,
    #[ts(type = "number")]
    pub rows_written: u64,
    pub created_table: bool,
    pub content_hash: String,
}

impl From<KeyMapWriteResult> for KeyMapWriteResultDto {
    fn from(r: KeyMapWriteResult) -> Self {
        Self {
            schema: r.schema,
            table: r.table,
            rows_written: r.rows_written as u64,
            created_table: r.created_table,
            content_hash: r.content_hash,
        }
    }
}

/// Wire response for `read_key_map` (ADR-0029). Entries stay pipeline-shaped.
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
pub struct KeyMapReadResultDto {
    #[ts(type = "import(\"../pipeline\").KeyMapEntry[]")]
    pub entries: Vec<dwh_pipeline::KeyMapEntry>,
    pub content_hash: String,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub total_count: Option<u64>,
}

impl From<KeyMapReadResult> for KeyMapReadResultDto {
    fn from(r: KeyMapReadResult) -> Self {
        Self {
            entries: r.entries,
            content_hash: r.content_hash,
            total_count: r.total_count,
        }
    }
}

fn map_keymap_engine_err(e: String) -> RpcError {
    if e.contains("refused:") || e.contains("concurrently") || e.contains("hash mismatch") {
        HostError::conflict(e).into()
    } else if e.contains("invalid") || e.contains("missing") {
        HostError::validation(e).into()
    } else {
        RpcError::from(e)
    }
}

pub fn write_key_map(db: &DbSession, args: KeyMapWhArgs) -> Result<Value, RpcError> {
    let out: KeyMapWriteResult = run_write_key_map_with_delta(
        db,
        &args.key_map,
        &args.connection_string,
        args.delta.as_ref(),
        args.expected_content_hash.as_deref(),
    )
    .map_err(map_keymap_engine_err)?;
    let dto = KeyMapWriteResultDto::from(out);
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}

pub fn read_key_map(db: &DbSession, args: KeyMapWhArgs) -> Result<Value, RpcError> {
    let q = KeyMapReadQuery {
        limit: args.limit,
        offset: args.offset,
        from_prefix: args.from_prefix,
    };
    let out: KeyMapReadResult =
        run_read_key_map_paged(db, &args.key_map, &args.connection_string, &q)
            .map_err(map_keymap_engine_err)?;
    let dto = KeyMapReadResultDto::from(out);
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}
