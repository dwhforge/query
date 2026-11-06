//! KeyMap warehouse read/write commands (ADR-0022 / ADR-0032 / ADR-0029).

use crate::error::{HostError, RpcError};
use dwh_engine::{
    read_key_map_paged as run_read_key_map_paged,
    write_key_map_with_delta as run_write_key_map_with_delta, DbSession, KeyMapDirtyDelta,
    KeyMapReadQuery, KeyMapReadResult, KeyMapWriteResult,
};
use dwh_pipeline::pg_import::import_write_refusal;
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
    /// Exact From-tuple equality lookup (Confirm baselines). Not a prefix page.
    #[serde(default)]
    #[ts(optional)]
    pub from_exact: Option<Vec<Vec<String>>>,
    /// Import registry from the current project. Write refuses when this map is read-only or broken.
    #[serde(default)]
    #[ts(optional, type = "import(\"../../lib/pgImport\").PgImportRegistry")]
    pub import_registry: Option<dwh_pipeline::PgImportRegistry>,
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
    if let Some(reason) = import_write_refusal(args.import_registry.as_ref(), &args.key_map.id) {
        return Err(HostError::validation(reason).into());
    }
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
        from_exact: args.from_exact,
    };
    let out: KeyMapReadResult =
        run_read_key_map_paged(db, &args.key_map, &args.connection_string, &q)
            .map_err(map_keymap_engine_err)?;
    let dto = KeyMapReadResultDto::from(out);
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_engine::DbSession;
    use dwh_pipeline::{KeyMapEntry, KeyMapStorage, PgImportRegistry};
    use serde_json::json;
    use std::process::Command;

    fn registry(write_back: bool, status: &str) -> PgImportRegistry {
        serde_json::from_value(json!({
            "prefixes": [],
            "relations": [{
                "id": "imp1",
                "connection_id": "conn",
                "schema": "dwh_import_gate",
                "name": "ro_map",
                "kind": "table",
                "schema_fingerprint": "fp",
                "source_id": "src",
                "query_id": "q",
                "keymap_id": "km_ro",
                "mapping_decision": "force",
                "binding_status": status,
                "write_back": write_back
            }]
        }))
        .unwrap()
    }

    fn map() -> dwh_pipeline::KeyMapDef {
        let mut map = dwh_pipeline::KeyMapDef::new("km_ro", "ro_map");
        map.storage = KeyMapStorage::Source {
            source: "dwh_import_gate".into(),
            table: "ro_map".into(),
            connection_id: Some("conn".into()),
            db_schema: Some("dwh_import_gate".into()),
        };
        map.from_columns = vec!["supplier_id".into()];
        map.from_column = "supplier_id".into();
        map.output_columns = vec!["product_id".into()];
        map.to_column = "product_id".into();
        map
    }

    fn args(dsn: &str, reg: PgImportRegistry) -> KeyMapWhArgs {
        KeyMapWhArgs {
            key_map: map(),
            connection_string: dsn.into(),
            expected_content_hash: None,
            delta: Some(dwh_engine::KeyMapDirtyDelta {
                upserts: vec![KeyMapEntry::pair("s1", "p9")],
                ..Default::default()
            }),
            limit: None,
            offset: None,
            from_prefix: None,
            from_exact: None,
            import_registry: Some(reg),
        }
    }

    #[test]
    fn readonly_and_broken_imports_refuse_before_the_warehouse() {
        let db = DbSession::new().expect("duckdb");
        let ro = write_key_map(
            &db,
            args("postgresql://refused.invalid/db", registry(false, "confirmed")),
        )
        .expect_err("read-only");
        assert!(
            ro.message().contains("write-back is not allowed"),
            "{}",
            ro.message()
        );
        let broken = write_key_map(
            &db,
            args("postgresql://refused.invalid/db", registry(true, "broken")),
        )
        .expect_err("broken");
        assert!(broken.message().contains("broken import binding"), "{}", broken.message());
    }

    #[test]
    fn readonly_import_does_not_change_a_writable_table() {
        let Some(dsn) = std::env::var("DWH_PG_DSN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            eprintln!("SKIP readonly import write: DWH_PG_DSN unset");
            return;
        };
        let sql = "\
CREATE SCHEMA IF NOT EXISTS dwh_import_gate; \
CREATE TABLE IF NOT EXISTS dwh_import_gate.ro_map ( \
  supplier_id text PRIMARY KEY, product_id text \
); \
INSERT INTO dwh_import_gate.ro_map (supplier_id, product_id) VALUES ('s1', 'p1') \
ON CONFLICT (supplier_id) DO UPDATE SET product_id = 'p1';";
        let run = Command::new("psql")
            .arg(&dsn)
            .arg("-v")
            .arg("ON_ERROR_STOP=1")
            .arg("-c")
            .arg(sql)
            .output()
            .expect("psql");
        assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));
        let db = DbSession::new().expect("duckdb");
        let err = write_key_map(&db, args(&dsn, registry(false, "confirmed"))).expect_err("gate");
        assert!(err.message().contains("write-back is not allowed"), "{}", err.message());
        let check = Command::new("psql")
            .arg(&dsn)
            .arg("-tA")
            .arg("-c")
            .arg("SELECT product_id FROM dwh_import_gate.ro_map WHERE supplier_id = 's1'")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&check.stdout).trim(), "p1");
    }
}
