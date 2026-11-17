//! Bounded-memory, resumable Source Mapping publication.
//!
//! The Host calls this in its heavy worker after resolving the same permissions
//! and connection binding as `write_key_map`. Approved rows are pulled from
//! DuckDB in pages of at most 200. PostgreSQL upserts use the existing guarded
//! delta writer and row baselines. Only successful batches are journaled in
//! DuckDB; retries compare existing outputs to make a write-before-journal crash
//! safe. No renderer callback or unbounded Vec of confirmed keys is needed.
use crate::{DbSession, KeyMapDirtyDelta, KeyMapDirtyBaseline, KeyMapReadQuery,
    read_key_map_paged, write_key_map_with_delta};
use dwh_pipeline::{KeyMapDef, KeyMapEntry, KeyMapStorage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

const BATCH: u64 = 200;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct MatchingPublicationReceipt {
    pub map_id: String,
    pub eligible: u64,
    pub newly_published: u64,
    pub previously_published: u64,
    pub rows_written: u64,
    pub complete: bool,
    pub destination: String,
}

fn safe_id(s:&str)->Result<(),String> {
    if s.is_empty() || s.len()>90 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("invalid matching run identifier".into());
    }
    Ok(())
}
fn decode(value: &str, n: usize) -> Result<Vec<String>,String> {
    let decoded: Vec<String> = serde_json::from_str(value).map_err(|_| "invalid approved Matching value")?;
    if decoded.len()!=n || decoded.iter().any(|s| s.trim().is_empty()) { return Err("approved Mapping tuple has missing/NULL values".into()); }
    Ok(decoded)
}
fn row(from: Vec<String>, to: Vec<String>) -> KeyMapEntry {
    KeyMapEntry::parts_multi(from, to)
}
fn journal_table(run_id: &str) -> String { format!("__dwh_match_pub_{run_id}") }

/// Creates the journal before publishing. A checkpoint includes this table.
pub fn ensure_matching_publication_journal(db: &DbSession, run_id: &str) -> Result<(),String> {
    safe_id(run_id)?;
    db.with_conn(|conn| conn.execute_batch(&format!(
        "CREATE TEMP TABLE IF NOT EXISTS {} (map_id VARCHAR NOT NULL, left_id BIGINT NOT NULL, published_at_ms BIGINT NOT NULL, PRIMARY KEY(map_id,left_id))",
        journal_table(run_id))).map_err(|e|e.to_string()))
}

/// Publish some or all confirmed keys with a bounded in-memory batch. The
/// receipt reports partial success on subsequent invocations; it never claims
/// multi-batch atomicity. On an error the already acknowledged batches remain
/// published, and a retry skips them safely.
pub fn publish_confirmed_source(db: &DbSession, run_id: &str, map: &KeyMapDef,
    dsn: &str, max_batches: u64) -> Result<MatchingPublicationReceipt,String> {
    safe_id(run_id)?;
    if max_batches == 0 || max_batches > 10_000 { return Err("max_batches must be 1..10000".into()); }
    if !matches!(&map.storage, KeyMapStorage::Source{..}) { return Err("source publication requires a source-backed Mapping".into()); }
    if map.time_mode != dwh_pipeline::KeyMapTimeMode::None { return Err("range-SCD publication requires its dedicated editor".into()); }
    let from_cols = map.from_columns_eff();
    let out_cols = map.output_columns_eff();
    if from_cols.is_empty() || out_cols.is_empty() { return Err("Mapping has no From/To shape".into()); }
    let journal = journal_table(run_id);
    ensure_matching_publication_journal(db, run_id)?;
    let d = format!("__dwh_match_d_{run_id}");
    let p = format!("__dwh_match_p_{run_id}");
    let s = format!("__dwh_match_s_{run_id}");
    let eligible = db.with_conn(|conn| conn.query_row(&format!("SELECT count(*) FROM {d} WHERE action='confirm'"), [], |r|r.get::<_,i64>(0)).map_err(|e|e.to_string()))? as u64;
    let old_count = db.with_conn(|conn| conn.query_row(&format!("SELECT count(*) FROM {journal} WHERE map_id=?1"), duckdb::params![map.id], |r|r.get::<_,i64>(0)).map_err(|e|e.to_string()))? as u64;
    let mut acknowledged = 0u64;
    let mut written = 0u64;
    for _ in 0..max_batches {
        // Stable keyset pagination: acknowledged rows are excluded, no OFFSET.
        let batch: Vec<(i64,String,String)> = db.with_conn(|conn| {
            let sql = format!("SELECT d.left_id,s.map_key,p.outputs FROM {d} d \
                JOIN {p} p ON p.left_id=d.left_id AND p.right_id=d.right_id \
                JOIN {s} s ON s.left_id=d.left_id \
                LEFT JOIN {journal} j ON j.left_id=d.left_id AND j.map_id=?1 \
                WHERE d.action='confirm' AND j.left_id IS NULL \
                ORDER BY d.left_id LIMIT {BATCH}");
            let mut statement=conn.prepare(&sql).map_err(|e|e.to_string())?;
            let rows=statement.query_map(duckdb::params![map.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
            rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
        })?;
        if batch.is_empty() { break; }
        let mut keys: Vec<Vec<String>> = Vec::with_capacity(batch.len());
        let mut targets: HashMap<String,Vec<String>> = HashMap::new();
        for (_, left, right) in &batch {
            let key=decode(left,from_cols.len())?;
            let output=decode(right,out_cols.len())?;
            let token=serde_json::to_string(&key).map_err(|e|e.to_string())?;
            if targets.insert(token,output).is_some() { return Err("duplicate approved Mapping key in batch".into()); }
            keys.push(key);
        }
        let existing=read_key_map_paged(db, map, dsn, &KeyMapReadQuery { from_exact:Some(keys.clone()), ..Default::default() })?;
        let mut found: HashMap<String,KeyMapEntry> = HashMap::new();
        for entry in existing.entries {
            let token=serde_json::to_string(&entry.from_parts_eff()).map_err(|e|e.to_string())?;
            if !targets.contains_key(&token) || found.insert(token.clone(),entry).is_some() {
                return Err(format!("unexpected or duplicate source Mapping key {token}"));
            }
        }
        let mut delta=KeyMapDirtyDelta::default();
        for key in &keys {
            let token=serde_json::to_string(key).map_err(|e|e.to_string())?;
            let desired=targets.get(&token).ok_or("approved key vanished")?;
            if let Some(current)=found.get(&token) {
                let old=current.output_values_eff();
                if old == *desired { continue; } // retry after a write-before-journal crash
                if old.iter().any(|v|!v.trim().is_empty()) {
                    return Err(format!("refused to overwrite populated Mapping key {token}"));
                }
            }
            let current=found.get(&token);
            let existing=current.map(|e|e.output_values_eff()).unwrap_or_default();
            delta.baselines.push(KeyMapDirtyBaseline {
                from_parts:key.clone(), existed:current.is_some(),
                to:existing.first().cloned().unwrap_or_default(),
                outputs:out_cols.iter().enumerate().map(|(i,c)|(c.clone(),existing.get(i).cloned().unwrap_or_default())).collect::<BTreeMap<_,_>>(),
                attrs:current.map(|e|e.attrs.iter().map(|(k,v)|(k.clone(),Some(v.clone()))).collect()).unwrap_or_default(),
            });
            let mut entry=row(key.clone(),desired.clone());
            if let Some(before)=current {entry.attrs=before.attrs.clone();}
            delta.upserts.push(entry);
        }
        if !delta.upserts.is_empty() {
            // One PostgreSQL transaction per bounded batch with row-level
            // baselines. The existing writer enforces advisory locking.
            let outcome=write_key_map_with_delta(db,map,dsn,Some(&delta),None)?;
            written += outcome.rows_written as u64;
        }
        // Journal only AFTER the guarded write succeeded. A crash here is
        // idempotent because next run re-reads the same outputs before writing.
        db.with_conn(|conn| {
            conn.execute_batch("BEGIN TRANSACTION").map_err(|e|e.to_string())?;
            let result=(|| {
                let mut statement=conn.prepare(&format!(
                    "INSERT INTO {journal}(map_id,left_id,published_at_ms) VALUES (?1,?2,epoch_ms(current_timestamp)) ON CONFLICT DO NOTHING"
                )).map_err(|e|e.to_string())?;
                for (left_id,_,_) in &batch {
                    statement.execute(duckdb::params![map.id,*left_id]).map_err(|e|e.to_string())?;
                }
                conn.execute_batch("COMMIT").map_err(|e|e.to_string())
            })();
            if result.is_err(){let _=conn.execute_batch("ROLLBACK");}
            result
        })?;
        acknowledged+=batch.len() as u64;
    }
    let published = db.with_conn(|conn| conn.query_row(&format!("SELECT count(*) FROM {journal} WHERE map_id=?1"),duckdb::params![map.id],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string()))? as u64;
    Ok(MatchingPublicationReceipt {map_id:map.id.clone(),eligible,newly_published:acknowledged,
        previously_published:old_count,rows_written:written,complete:published==eligible,destination:"source table".into()})
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct MatchingPublicationHistoryRow {
    pub map_id: String,
    pub published_keys: u64,
    pub first_published_ms: i64,
    pub last_published_ms: i64,
}

pub fn matching_publication_history(db: &DbSession, run_id: &str) -> Result<Vec<MatchingPublicationHistoryRow>,String> {
    safe_id(run_id)?;
    ensure_matching_publication_journal(db,run_id)?;
    db.with_conn(|conn| {
        let sql=format!("SELECT map_id,count(*),min(published_at_ms),max(published_at_ms) FROM {} GROUP BY map_id ORDER BY map_id",journal_table(run_id));
        let mut stmt=conn.prepare(&sql).map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok(MatchingPublicationHistoryRow{
            map_id:r.get(0)?,published_keys:r.get::<_,i64>(1)? as u64,
            first_published_ms:r.get(2)?,last_published_ms:r.get(3)?
        })).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
    })
}
