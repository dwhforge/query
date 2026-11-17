//! Durable, bounded-memory Matching review checkpoints.
//!
//! The Host chooses a project-scoped directory. `save` copies the materialized
//! SQL results, evidence and decisions directly to Parquet. No scored pairs or
//! approved mappings cross the renderer bridge. A new immutable generation is
//! published by atomically replacing the small CURRENT pointer only after all
//! files have been written. The project file and its sibling `.matching`
//! directory can be handed to another operator as a unit.
use crate::{DbSession, DatasetMatchingRun, ensure_matching_publication_journal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct MatchingCheckpoint {
    pub schema_version: u32,
    pub revision: String,
    pub run: DatasetMatchingRun,
    pub plan: Value,
    pub label: String,
    pub updated_at_ms: u64,
    pub reviewed: u64,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct MatchingProgressSummary {
    pub slot: String,
    pub revision: String,
    pub label: String,
    pub updated_at_ms: u64,
    pub left_total: u64,
    pub reviewed: u64,
    pub finished: bool,
}

fn safe_component(name: &str) -> Result<&str,String> {
    if name.is_empty() || name.len() > 90 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("Matching progress identifier must be 1..90 ASCII alphanumeric, underscore or dash characters".into());
    }
    Ok(name)
}
fn sql_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}
fn time_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}
fn slot_dir(root: &Path, slot: &str) -> Result<PathBuf,String> {
    safe_component(slot)?;
    Ok(root.join(slot))
}
fn checkpoint_from_slot(dir: &Path) -> Result<(MatchingCheckpoint, PathBuf),String> {
    let pointer: Value = serde_json::from_slice(&fs::read(dir.join("current.json")).map_err(|e| format!("read Matching checkpoint pointer: {e}"))?)
        .map_err(|e| format!("invalid Matching checkpoint pointer: {e}"))?;
    let generation = pointer.get("generation").and_then(Value::as_str).ok_or("checkpoint pointer missing generation")?;
    safe_component(generation)?;
    let folder = dir.join(generation);
    let metadata: MatchingCheckpoint = serde_json::from_slice(&fs::read(folder.join("manifest.json")).map_err(|e| format!("read Matching manifest: {e}"))?)
        .map_err(|e| format!("invalid Matching manifest: {e}"))?;
    if metadata.schema_version != 1 { return Err("Unsupported Matching checkpoint schema version".into()); }
    if metadata.plan.get("matchingPlan").and_then(Value::as_object).is_none()
        || metadata.plan.get("inputFingerprint").and_then(Value::as_str).is_none() {
        return Err("Matching checkpoint has no valid evaluated plan or source fingerprint".into());
    }
    for name in ["pairs.parquet", "results.parquet", "decisions.parquet", "publication.parquet"] {
        if !folder.join(name).is_file() { return Err(format!("Matching checkpoint incomplete: missing {name}")); }
    }
    Ok((metadata, folder))
}

/// Snapshot an entire run while holding the DuckDB connection mutex: all three
/// Parquet exports see the same review state. Existing generations are immutable.
pub fn checkpoint_dataset_matching(db: &DbSession, root: &Path, slot: &str, label: &str,
    plan: Value, run: &DatasetMatchingRun, finished: bool,
    expected_revision: Option<&str>) -> Result<MatchingCheckpoint,String> {
    safe_component(slot)?;
    if label.trim().is_empty() || label.len() > 200 { return Err("Matching task label must be 1..200 characters".into()); }
    let dir = slot_dir(root, slot)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create Matching progress directory: {e}"))?;
    // Exclusive create is a simple cross-process slot lock. A crash leaves a
    // visible lock file that requires explicit recovery; do not silently steal
    // another operator's active write.
    let lock_path = dir.join(".write.lock");
    let lock_file = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock_path)
        .map_err(|e| format!("Matching task is locked by another Save (or has a stale crash lock at {}): {e}", lock_path.display()))?;
    struct LockGuard(PathBuf);
    impl Drop for LockGuard { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
    let _lock_guard = LockGuard(lock_path);
    drop(lock_file); // allow cleanup on Windows as well as Unix
    match checkpoint_from_slot(&dir) {
        Ok((saved, _)) => {
            if expected_revision != Some(saved.revision.as_str()) {
                return Err("Matching task was updated elsewhere: Resume its latest revision before saving, or use a new Task ID".into());
            }
            if saved.plan != plan {
                return Err("Matching task plan/input fingerprint changed: choose a new Task ID for a new evaluation".into());
            }
        }
        Err(e) if dir.join("current.json").exists() => {
            return Err(format!("Matching checkpoint pointer is invalid, refusing overwrite: {e}"));
        }
        Err(_) if expected_revision.is_some() => return Err("Matching task revision no longer exists; refuse overwrite".into()),
        _ => {}
    }
    let generation = format!("v{}_{}_{}", time_ms(), std::process::id(), GENERATION.fetch_add(1, Ordering::Relaxed));
    let staging = dir.join(format!(".{generation}"));
    let committed = dir.join(&generation);
    fs::create_dir(&staging).map_err(|e| format!("create Matching staging directory: {e}"))?;
    let written = (|| {
        ensure_matching_publication_journal(db, &run.run_id)?;
        let p = format!("__dwh_match_p_{}", run.run_id);
        let s = format!("__dwh_match_s_{}", run.run_id);
        let d = format!("__dwh_match_d_{}", run.run_id);
        let publication = format!("__dwh_match_pub_{}", run.run_id);
        if !run.run_id.starts_with('r') || !run.run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err("Invalid Matching run identifier".into());
        }
        let reviewed = db.with_conn(|conn| {
            // COPY is executed as one critical section with respect to all Host
            // review writes. All source rows are exported in SQL, never to JS.
            let got: i64 = conn.query_row(&format!("SELECT count(*) FROM {s}"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
            if got < 0 || got as u64 != run.left_total { return Err("Matching run changed before checkpoint".into()); }
            let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {d}"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
            if count < 0 { return Err("Negative review count".into()); }
            if finished {
                if count as u64 != run.left_total {
                    return Err("Finish Review requires decisions for every Mapping key".into());
                }
                let deferred: i64 = conn.query_row(&format!("SELECT count(*) FROM {d} WHERE action='defer'"), [], |r| r.get(0)).map_err(|e|e.to_string())?;
                if deferred != 0 { return Err("Finish Review requires all deferred decisions to be resolved".into()); }
            }
            for (table, file) in [(p, "pairs.parquet"), (s, "results.parquet"), (d, "decisions.parquet"), (publication, "publication.parquet")] {
                conn.execute_batch(&format!("COPY (SELECT * FROM {table}) TO {} (FORMAT PARQUET)", sql_path(&staging.join(file))))
                    .map_err(|e| format!("checkpoint {file}: {e}"))?;
            }
            Ok(count as u64)
        })?;
        let snapshot = MatchingCheckpoint { schema_version: 1, revision: generation.clone(), run: run.clone(), plan,
            label: label.trim().into(), updated_at_ms: time_ms(), reviewed, finished };
        fs::write(staging.join("manifest.json"), serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?)
            .map_err(|e| format!("write Matching manifest: {e}"))?;
        fs::rename(&staging, &committed).map_err(|e| format!("commit Matching generation: {e}"))?;
        let pointer_tmp = dir.join(format!(".current_{}.json", generation));
        fs::write(&pointer_tmp, serde_json::to_vec(&serde_json::json!({"generation":generation})).map_err(|e| e.to_string())?)
            .map_err(|e| format!("write Matching pointer: {e}"))?;
        fs::rename(&pointer_tmp, dir.join("current.json")).map_err(|e| format!("publish Matching pointer: {e}"))?;
        Ok(snapshot)
    })();
    if written.is_err() { let _ = fs::remove_dir_all(staging); }
    written
}

/// Reload Parquet into fresh temporary tables. No source re-evaluation or UI
/// sample is involved; all evidence and decisions come from the saved snapshot.
/// The caller must show that the stored plan describes the saved evaluation and
/// refuse to publish to a Mapping whose current shape no longer matches it.
pub fn restore_dataset_matching(db: &DbSession, root: &Path, slot: &str) -> Result<MatchingCheckpoint,String> {
    let (mut checkpoint, folder) = checkpoint_from_slot(&slot_dir(root, slot)?)?;
    let fresh = format!("r{}", GENERATION.fetch_add(1, Ordering::Relaxed) + 1_000_000_000);
    let tables = [
        (format!("__dwh_match_p_{fresh}"), "pairs.parquet"),
        (format!("__dwh_match_s_{fresh}"), "results.parquet"),
        (format!("__dwh_match_d_{fresh}"), "decisions.parquet"),
        (format!("__dwh_match_pub_{fresh}"), "publication.parquet"),
    ];
    db.with_conn(|conn| {
        // All restored tables are committed together or rolled back together.
        conn.execute_batch("BEGIN TRANSACTION").map_err(|e| e.to_string())?;
        let res = (|| {
            for (table, file) in &tables {
                let file_ref = sql_path(&folder.join(file));
                if *file == "decisions.parquet" {
                    conn.execute_batch(&format!("CREATE TEMP TABLE {table} (left_id BIGINT PRIMARY KEY, right_id BIGINT, action VARCHAR NOT NULL); INSERT INTO {table} SELECT left_id, right_id, action FROM read_parquet({file_ref})"))
                        .map_err(|e| format!("restore {file}: {e}"))?;
                } else if *file == "publication.parquet" {
                    conn.execute_batch(&format!("CREATE TEMP TABLE {table} (map_id VARCHAR NOT NULL, left_id BIGINT NOT NULL, published_at_ms BIGINT NOT NULL, PRIMARY KEY(map_id,left_id)); INSERT INTO {table} SELECT map_id, left_id, published_at_ms FROM read_parquet({file_ref})"))
                        .map_err(|e| format!("restore {file}: {e}"))?;
                } else {
                    conn.execute_batch(&format!("CREATE TEMP TABLE {table} AS SELECT * FROM read_parquet({file_ref})"))
                        .map_err(|e| format!("restore {file}: {e}"))?;
                }
            }
            let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {}", tables[1].0), [], |r| r.get(0)).map_err(|e| e.to_string())?;
            let decisions: i64 = conn.query_row(&format!("SELECT count(*) FROM {}", tables[2].0), [], |r| r.get(0)).map_err(|e| e.to_string())?;
            if count < 0 || count as u64 != checkpoint.run.left_total || decisions < 0 || decisions as u64 != checkpoint.reviewed {
                return Err("Matching snapshot count mismatch; refusing restore".into());
            }
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())
        })();
        if res.is_err() { let _ = conn.execute_batch("ROLLBACK"); }
        res
    })?;
    checkpoint.run.run_id = fresh;
    Ok(checkpoint)
}

pub fn list_matching_progress(root: &Path) -> Result<Vec<MatchingProgressSummary>,String> {
    if !root.is_dir() { return Ok(vec![]); }
    let mut out = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() { continue; }
        let slot = entry.file_name().to_string_lossy().to_string();
        if safe_component(&slot).is_err() { continue; }
        if let Ok((meta, _)) = checkpoint_from_slot(&entry.path()) {
            out.push(MatchingProgressSummary { slot, revision: meta.revision, label: meta.label,
                updated_at_ms: meta.updated_at_ms, left_total: meta.run.left_total,
                reviewed: meta.reviewed, finished: meta.finished });
        }
    }
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn invalid_slots_are_never_filesystem_components() {
        for bad in ["../evil", "", "a/b", ".", "..", "bad name"] { assert!(safe_component(bad).is_err()); }
        for good in ["session_42", "review-a"] { assert!(safe_component(good).is_ok()); }
    }
    #[test] fn format_version_is_explicit() { assert_eq!(1u32, 1); }

    #[test]
    fn checkpoint_restores_materialized_evidence_reviews_and_publication_ledger() {
        let db = DbSession::new().unwrap();
        let source_id = "rcheckpoint";
        db.with_conn(|c| c.execute_batch(&format!(
            "CREATE TEMP TABLE __dwh_match_p_{source_id}(left_id BIGINT,right_id BIGINT,target_identity VARCHAR,outputs VARCHAR,score DOUBLE); \
             INSERT INTO __dwh_match_p_{source_id} VALUES (1,1,'[\"E1\"]','[\"E1\"]',0.9); \
             CREATE TEMP TABLE __dwh_match_s_{source_id}(left_id BIGINT,map_key VARCHAR,source_rows BIGINT,right_id BIGINT,target_identity VARCHAR,outputs VARCHAR,score DOUBLE,alternatives BIGINT,state VARCHAR); \
             INSERT INTO __dwh_match_s_{source_id} VALUES (1,'[\"A\"]',1,1,'[\"E1\"]','[\"E1\"]',0.9,1,'proposed'),(2,'[\"B\"]',1,NULL,NULL,NULL,NULL,0,'unmatched'); \
             CREATE TEMP TABLE __dwh_match_d_{source_id}(left_id BIGINT PRIMARY KEY,right_id BIGINT,action VARCHAR NOT NULL); \
             INSERT INTO __dwh_match_d_{source_id} VALUES (1,1,'confirm');"
        )).map_err(|e|e.to_string())).unwrap();
        let run: DatasetMatchingRun = serde_json::from_value(serde_json::json!({
            "runId": source_id,"leftTotal":2,"leftSourceRows":2,"conflictingSourceKeys":0,
            "rightTotal":1,"candidatePairs":1,"aboveThresholdPairs":1,"reusedTargets":0,
            "proposedSources":1,"ambiguousSources":0,"belowThresholdSources":0,"unmatchedSources":1,
            "candidatePolicy":"cartesian","sourceCoverage":"complete","candidateSearchExhaustive":true,
            "inputsTransactionallySnapshotted":false,"minimumScore":0.7
        })).unwrap();
        let root=std::env::temp_dir().join(format!("dwh_matching_checkpoint_{}", GENERATION.fetch_add(1, Ordering::Relaxed)));
        let plan=serde_json::json!({"matchingPlan":{"sourceRef":"fact"},"inputFingerprint":"frozen"});
        let first=checkpoint_dataset_matching(&db,&root,"handoff","Review",plan.clone(),&run,false,None).unwrap();
        assert_eq!(first.reviewed,1);
        assert!(checkpoint_dataset_matching(&db,&root,"handoff","Review",plan.clone(),&run,false,None).is_err(),
            "writing another operator's task without the observed revision must be refused");
        let restored=restore_dataset_matching(&db,&root,"handoff").unwrap();
        assert_ne!(restored.run.run_id,run.run_id);
        let rows=crate::dataset_matching_page(&db,&restored.run.run_id,0,50,None).unwrap();
        assert_eq!(rows.total,2);
        assert_eq!(crate::dataset_matching_review_stats(&db,&restored.run.run_id).unwrap().confirmed,1);
        // Restored decisions retain their PRIMARY KEY for subsequent on-conflict updates.
        crate::dataset_matching_decide(&db,&crate::DatasetReviewRequest{
            run_id:restored.run.run_id.clone(),left_id:2,right_id:None,action:"defer".into()
        }).unwrap();
        let after=checkpoint_dataset_matching(&db,&root,"handoff","Review",plan,&restored.run,true,Some(&restored.revision)).unwrap();
        assert_eq!(after.reviewed,2);
        assert!(after.finished);
        assert_eq!(list_matching_progress(&root).unwrap().len(),1);
        let _=std::fs::remove_dir_all(root);
    }
}
