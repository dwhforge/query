//! Materialize Join left/right inputs once; reuse for Lens / diagnostics / near-miss.
//!
//! Only **expensive derived** sides become session TEMP tables. Source-backed sides stay
//! live CTEs (read on demand) so a 200M parquet left is not copied into TEMP.
//!
//! Temp tables live on the session connection. Fingerprint covers workspace + sources +
//! connections + file revisions + join identity; mismatch → treat as stale.
//!
//! Prepared join SQL uses the shared Join emitter (`USING` / key alignment) so TEMP
//! shortcuts do not change result schema or key semantics.

use crate::arrow_json::{batches_to_rows, map_arrow_type};
use crate::preview::{ColumnMetadata, PreviewResult};
use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, emit_transform_step, join_left_input_is_expensive, join_right_input_is_expensive,
    ConnectionDef, GraphCompiler, JoinType, SourceDef, TransformationStep, WarehouseDialect,
    Workspace,
};
use duckdb::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

pub const PREP_LEFT: &str = "_dwh_join_prep_left";
pub const PREP_RIGHT: &str = "_dwh_join_prep_right";

const PREP_LEFT_BUILDING: &str = "_dwh_join_prep_left__building";
const PREP_RIGHT_BUILDING: &str = "_dwh_join_prep_right__building";

/// Live prepare progress (polled from UI; stored outside the DuckDB conn lock).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JoinPrepareProgress {
    pub active: bool,
    /// 0.0..=1.0
    pub fraction: f64,
    pub stage: String,
    pub message: String,
    pub left_expensive: Option<bool>,
    pub right_expensive: Option<bool>,
}

pub fn set_prepare_progress(slot: &Mutex<JoinPrepareProgress>, update: JoinPrepareProgress) {
    if let Ok(mut g) = slot.lock() {
        *g = update;
    }
}

pub fn clear_prepare_progress(slot: &Mutex<JoinPrepareProgress>) {
    if let Ok(mut g) = slot.lock() {
        *g = JoinPrepareProgress::default();
    }
}

pub fn get_prepare_progress(slot: &Mutex<JoinPrepareProgress>) -> JoinPrepareProgress {
    slot.lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinPrepareResult {
    pub fingerprint: String,
    pub host_query_id: String,
    pub join_step_index: usize,
    pub right_query_id: String,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub left_rows: u64,
    pub right_rows: u64,
    /// True when existing prep matched the fingerprint (no rescan).
    pub reused: bool,
    /// Left input is derived-expensive (GroupBy/Join/Append/Sql/Derive…).
    pub left_expensive: bool,
    pub right_expensive: bool,
    /// Left was written to a session TEMP table.
    pub left_materialized: bool,
    pub right_materialized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinPrepareStatus {
    pub prepared: bool,
    pub fingerprint: Option<String>,
    pub host_query_id: Option<String>,
    pub join_step_index: Option<usize>,
    pub left_rows: Option<u64>,
    pub right_rows: Option<u64>,
    pub left_expensive: Option<bool>,
    pub right_expensive: Option<bool>,
    pub left_materialized: Option<bool>,
    pub right_materialized: Option<bool>,
    /// True when session has prep but fingerprint ≠ current join.
    pub stale: bool,
}

#[derive(Debug, Clone)]
pub struct JoinPrepareHandle {
    pub fingerprint: String,
    pub host_query_id: String,
    pub join_step_index: usize,
    pub right_query_id: String,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub join_type: JoinType,
    pub left_rows: u64,
    pub right_rows: u64,
    pub left_expensive: bool,
    pub right_expensive: bool,
    pub left_materialized: bool,
    pub right_materialized: bool,
    /// Full `SELECT …` for live (non-TEMP) preview; None when that side is TEMP.
    pub left_live_sql: Option<String>,
    pub right_live_sql: Option<String>,
}

fn hash_file_revision(path: &str, hasher: &mut DefaultHasher) {
    path.hash(hasher);
    let p = Path::new(path);
    match std::fs::metadata(p) {
        Ok(meta) => {
            meta.len().hash(hasher);
            if let Ok(modified) = meta.modified() {
                if let Ok(dur) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                    dur.as_nanos().hash(hasher);
                }
            }
        }
        Err(_) => {
            // Missing path still participates so delete→recreate invalidates.
            0u8.hash(hasher);
        }
    }
}

fn collect_workspace_paths(workspace: &Workspace, sources: &[SourceDef]) -> Vec<String> {
    let mut paths = Vec::new();
    for q in &workspace.queries {
        for step in &q.steps {
            match step {
                TransformationStep::LoadCsv { path }
                | TransformationStep::LoadParquet { path, .. } => {
                    if !path.trim().is_empty() {
                        paths.push(path.clone());
                    }
                }
                TransformationStep::LoadDuckdb { path, .. } => {
                    if !path.trim().is_empty() {
                        paths.push(path.clone());
                    }
                }
                _ => {}
            }
        }
    }
    for s in sources {
        if let Some(path) = s.path.as_deref() {
            if !path.trim().is_empty() {
                paths.push(path.to_string());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

pub fn join_prepare_fingerprint(
    workspace: &Workspace,
    sources: &[SourceDef],
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
) -> String {
    let mut h = DefaultHasher::new();
    if let Ok(bytes) = serde_json::to_vec(workspace) {
        bytes.hash(&mut h);
    }
    if let Ok(bytes) = serde_json::to_vec(sources) {
        bytes.hash(&mut h);
    }
    if let Ok(bytes) = serde_json::to_vec(connections) {
        bytes.hash(&mut h);
    }
    for path in collect_workspace_paths(workspace, sources) {
        hash_file_revision(&path, &mut h);
    }
    host_query_id.hash(&mut h);
    join_step_index.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn result_from_handle(h: &JoinPrepareHandle, reused: bool) -> JoinPrepareResult {
    JoinPrepareResult {
        fingerprint: h.fingerprint.clone(),
        host_query_id: h.host_query_id.clone(),
        join_step_index: h.join_step_index,
        right_query_id: h.right_query_id.clone(),
        left_on: h.left_on.clone(),
        right_on: h.right_on.clone(),
        left_rows: h.left_rows,
        right_rows: h.right_rows,
        reused,
        left_expensive: h.left_expensive,
        right_expensive: h.right_expensive,
        left_materialized: h.left_materialized,
        right_materialized: h.right_materialized,
    }
}

/// Workspace with host truncated to steps before Join — deps of right Join are dropped.
fn left_prefix_workspace(
    workspace: &Workspace,
    host_query_id: &str,
    join_step_index: usize,
) -> Result<Workspace, String> {
    let mut ws = workspace.clone();
    let host = ws
        .queries
        .iter_mut()
        .find(|q| q.id == host_query_id)
        .ok_or_else(|| format!("missing host query '{host_query_id}'"))?;
    if join_step_index > host.steps.len() {
        return Err(format!(
            "join_step_index {join_step_index} out of range for '{host_query_id}'"
        ));
    }
    host.steps.truncate(join_step_index);
    ws.focus_query_id = host_query_id.to_string();
    Ok(ws)
}

fn progress(
    slot: Option<&Mutex<JoinPrepareProgress>>,
    fraction: f64,
    stage: &str,
    message: &str,
    left_expensive: Option<bool>,
    right_expensive: Option<bool>,
) {
    let Some(slot) = slot else { return };
    set_prepare_progress(
        slot,
        JoinPrepareProgress {
            active: true,
            fraction: fraction.clamp(0.0, 1.0),
            stage: stage.into(),
            message: message.into(),
            left_expensive,
            right_expensive,
        },
    );
}

fn drop_building(conn: &duckdb::Connection) {
    let _ = conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {PREP_LEFT_BUILDING};\n\
         DROP TABLE IF EXISTS {PREP_RIGHT_BUILDING};"
    ));
}

fn create_temp_as(conn: &duckdb::Connection, name: &str, select_sql: &str) -> Result<(), String> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {name};\n\
         CREATE TEMP TABLE {name} AS ({select_sql});"
    ))
    .map_err(|e| e.to_string())
}

fn count_temp(conn: &duckdb::Connection, name: &str) -> Result<u64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {name}"), [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n as u64)
    .map_err(|e| e.to_string())
}

/// Atomically replace `final_name` with `building` (DROP + RENAME).
fn swap_building_into(
    conn: &duckdb::Connection,
    building: &str,
    final_name: &str,
) -> Result<(), String> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS {final_name};\n\
         ALTER TABLE {building} RENAME TO {final_name};"
    ))
    .map_err(|e| e.to_string())
}

/// Materialize expensive sides only; cheap sides stay live.
pub fn prepare_join_inputs(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinPrepareResult, String> {
    prepare_join_inputs_with_progress(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        None,
        false,
    )
}

/// Same as [`prepare_join_inputs`], updating `progress_slot` for UI polling.
/// `force_refresh` skips fingerprint reuse (Reload sides).
pub fn prepare_join_inputs_with_progress(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    progress_slot: Option<&Mutex<JoinPrepareProgress>>,
    force_refresh: bool,
) -> Result<JoinPrepareResult, String> {
    prepare_join_inputs_ex(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        progress_slot,
        false,
        force_refresh,
    )
}

/// Materialize both sides (even source-backed) before diagnostics / near-miss.
/// Only builds sides that are not already TEMP for this fingerprint.
pub fn ensure_join_sides_materialized(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    progress_slot: Option<&Mutex<JoinPrepareProgress>>,
) -> Result<(), String> {
    let fp = join_prepare_fingerprint(
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    if let Some(h) = db.join_prep_get() {
        if h.fingerprint == fp && h.left_materialized && h.right_materialized {
            return Ok(());
        }
        if h.fingerprint == fp && (h.left_materialized || h.right_materialized) {
            progress(
                progress_slot,
                0.05,
                "ensure",
                "Materializing missing join side for diagnostics…",
                Some(h.left_expensive),
                Some(h.right_expensive),
            );
            prepare_join_inputs_ex(
                db,
                workspace,
                connections,
                sources,
                host_query_id,
                join_step_index,
                progress_slot,
                true,
                false,
            )?;
            return Ok(());
        }
    }
    progress(
        progress_slot,
        0.05,
        "ensure",
        "Materializing both join sides for diagnostics…",
        None,
        None,
    );
    prepare_join_inputs_ex(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        progress_slot,
        true,
        false,
    )?;
    Ok(())
}

fn prepare_join_inputs_ex(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    progress_slot: Option<&Mutex<JoinPrepareProgress>>,
    force_both: bool,
    force_refresh: bool,
) -> Result<JoinPrepareResult, String> {
    let fp = join_prepare_fingerprint(
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    if !force_refresh {
        if let Some(existing) = db.join_prep_get() {
            if existing.fingerprint == fp
                && (!force_both || (existing.left_materialized && existing.right_materialized))
            {
                if let Some(slot) = progress_slot {
                    set_prepare_progress(
                        slot,
                        JoinPrepareProgress {
                            active: false,
                            fraction: 1.0,
                            stage: "reused".into(),
                            message: "Reused prepared inputs".into(),
                            left_expensive: Some(existing.left_expensive),
                            right_expensive: Some(existing.right_expensive),
                        },
                    );
                }
                return Ok(result_from_handle(&existing, true));
            }
        }
    }

    progress(
        progress_slot,
        0.02,
        "compile",
        "Compiling join inputs…",
        None,
        None,
    );

    let resolved = db.prepare_workspace(workspace, connections)?;
    let host = resolved
        .query(host_query_id)
        .ok_or_else(|| format!("missing host query '{host_query_id}'"))?;
    if join_step_index >= host.steps.len() {
        return Err(format!(
            "join_step_index {join_step_index} out of range for query '{host_query_id}'"
        ));
    }
    let TransformationStep::Join {
        right_query_id,
        left_on,
        right_on,
        join_type,
        ..
    } = &host.steps[join_step_index]
    else {
        return Err(format!(
            "step {join_step_index} of '{host_query_id}' is not a Join"
        ));
    };
    if left_on.is_empty() || left_on.len() != right_on.len() {
        return Err("Join: left_on/right_on must be non-empty and same length".into());
    }
    if join_step_index == 0 {
        return Err("Join cannot be the first step (no left input)".into());
    }

    let left_expensive = join_left_input_is_expensive(workspace, host_query_id, join_step_index)?;
    let right_expensive = join_right_input_is_expensive(workspace, right_query_id)?;
    progress(
        progress_slot,
        0.08,
        "classify",
        &format!(
            "Left {} · right {}",
            if left_expensive {
                "derived (temp)"
            } else {
                "source (live)"
            },
            if right_expensive {
                "derived (temp)"
            } else {
                "source (live)"
            },
        ),
        Some(left_expensive),
        Some(right_expensive),
    );

    let left_cte = cte_name(host_query_id, join_step_index - 1);
    let right_cte = {
        let rq = resolved
            .query(right_query_id)
            .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
        if rq.steps.is_empty() {
            return Err(format!("right query '{right_query_id}' has no steps"));
        }
        cte_name(right_query_id, rq.steps.len() - 1)
    };

    let compiled = GraphCompiler::new(&resolved)
        .with_sources(sources)
        .with_connections(connections)
        .compile_ctes_from(host_query_id)?;

    let left_sql = compiled.wrap_select(&format!("SELECT * FROM {left_cte}"));
    let right_sql = compiled.wrap_select(&format!("SELECT * FROM {right_cte}"));

    let existing = db.join_prep_get();
    let can_upgrade = !force_refresh
        && existing
            .as_ref()
            .is_some_and(|h| h.fingerprint == fp && (h.left_materialized || h.right_materialized));

    let want_left = force_both || left_expensive;
    let want_right = force_both || right_expensive;

    // Keep already-TEMP sides when upgrading the same fingerprint.
    let keep_left = can_upgrade && existing.as_ref().is_some_and(|h| h.left_materialized);
    let keep_right = can_upgrade && existing.as_ref().is_some_and(|h| h.right_materialized);

    let left_materialized = want_left;
    let right_materialized = want_right;

    let (left_lo, left_hi, right_lo, right_hi) = match (
        left_materialized && !keep_left,
        right_materialized && !keep_right,
    ) {
        (true, true) => (0.10, 0.50, 0.50, 0.95),
        (true, false) => (0.10, 0.95, 0.95, 0.95),
        (false, true) => (0.10, 0.10, 0.10, 0.95),
        (false, false) => (0.10, 0.10, 0.10, 0.10),
    };

    let result = (|| {
        let (left_rows, right_rows) = db.with_conn(|conn| {
            drop_building(conn);

            let mut left_rows = if keep_left {
                existing.as_ref().map(|h| h.left_rows).unwrap_or(0)
            } else {
                0
            };
            let mut right_rows = if keep_right {
                existing.as_ref().map(|h| h.right_rows).unwrap_or(0)
            } else {
                0
            };

            let mut built_left = false;
            let mut built_right = false;

            if left_materialized && !keep_left {
                progress(
                    progress_slot,
                    left_lo,
                    "left",
                    "Materializing left…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                create_temp_as(conn, PREP_LEFT_BUILDING, &left_sql)?;
                progress(
                    progress_slot,
                    (left_lo + left_hi) * 0.5,
                    "left",
                    "Counting left…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                left_rows = count_temp(conn, PREP_LEFT_BUILDING)?;
                built_left = true;
                progress(
                    progress_slot,
                    left_hi,
                    "left",
                    &format!("Left temp · {} rows", left_rows),
                    Some(left_expensive),
                    Some(right_expensive),
                );
            }
            if right_materialized && !keep_right {
                progress(
                    progress_slot,
                    right_lo,
                    "right",
                    "Materializing right…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                create_temp_as(conn, PREP_RIGHT_BUILDING, &right_sql)?;
                progress(
                    progress_slot,
                    (right_lo + right_hi) * 0.5,
                    "right",
                    "Counting right…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                right_rows = count_temp(conn, PREP_RIGHT_BUILDING)?;
                built_right = true;
                progress(
                    progress_slot,
                    right_hi,
                    "right",
                    &format!("Right temp · {} rows", right_rows),
                    Some(left_expensive),
                    Some(right_expensive),
                );
            }

            // Commit both swaps in one transaction so a mid-swap failure
            // cannot leave one TEMP updated and the handle pointing at the other.
            conn.execute_batch("BEGIN;")
                .map_err(|e| e.to_string())?;
            let commit = (|| {
                if built_left {
                    swap_building_into(conn, PREP_LEFT_BUILDING, PREP_LEFT)?;
                } else if !keep_left {
                    let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {PREP_LEFT};"));
                }
                if built_right {
                    swap_building_into(conn, PREP_RIGHT_BUILDING, PREP_RIGHT)?;
                } else if !keep_right {
                    let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {PREP_RIGHT};"));
                }
                Ok(())
            })();
            match commit {
                Ok(()) => {
                    conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    return Err(e);
                }
            }
            drop_building(conn);
            Ok((left_rows, right_rows))
        })?;

        let handle = JoinPrepareHandle {
            fingerprint: fp.clone(),
            host_query_id: host_query_id.to_string(),
            join_step_index,
            right_query_id: right_query_id.clone(),
            left_on: left_on.clone(),
            right_on: right_on.clone(),
            join_type: join_type.clone(),
            left_rows,
            right_rows,
            left_expensive,
            right_expensive,
            left_materialized,
            right_materialized,
            left_live_sql: if left_materialized {
                None
            } else {
                Some(left_sql)
            },
            right_live_sql: if right_materialized {
                None
            } else {
                Some(right_sql)
            },
        };
        db.join_prep_set(Some(handle.clone()));
        Ok(result_from_handle(&handle, false))
    })();

    match &result {
        Ok(r) => {
            if let Some(slot) = progress_slot {
                set_prepare_progress(
                    slot,
                    JoinPrepareProgress {
                        active: false,
                        fraction: 1.0,
                        stage: "done".into(),
                        message: format_prepare_hint(r),
                        left_expensive: Some(r.left_expensive),
                        right_expensive: Some(r.right_expensive),
                    },
                );
            }
        }
        Err(_) => {
            // Drop partial building tables; leave any previous handle + TEMPs intact.
            let _ = db.with_conn(|conn| {
                drop_building(conn);
                Ok(())
            });
            if let Some(slot) = progress_slot {
                clear_prepare_progress(slot);
            }
            // If there was no prior successful handle, ensure we are not advertising ready.
            if db.join_prep_get().is_none() {
                let _ = clear_join_prepare(db);
            }
        }
    }
    result
}

pub fn format_prepare_hint(r: &JoinPrepareResult) -> String {
    fn side(expensive: bool, materialized: bool, rows: u64) -> String {
        if materialized {
            format!("{} temp", rows)
        } else if expensive {
            "derived".into()
        } else {
            "live".into()
        }
    }
    format!(
        "{} · {} / {}",
        if r.reused { "Reused" } else { "Prepared" },
        side(r.left_expensive, r.left_materialized, r.left_rows),
        side(r.right_expensive, r.right_materialized, r.right_rows),
    )
}

pub fn join_prepare_status(
    db: &DbSession,
    workspace: &Workspace,
    sources: &[SourceDef],
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
) -> JoinPrepareStatus {
    let want = join_prepare_fingerprint(
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    match db.join_prep_get() {
        Some(h) if h.fingerprint == want => JoinPrepareStatus {
            prepared: true,
            fingerprint: Some(h.fingerprint),
            host_query_id: Some(h.host_query_id),
            join_step_index: Some(h.join_step_index),
            left_rows: Some(h.left_rows),
            right_rows: Some(h.right_rows),
            left_expensive: Some(h.left_expensive),
            right_expensive: Some(h.right_expensive),
            left_materialized: Some(h.left_materialized),
            right_materialized: Some(h.right_materialized),
            stale: false,
        },
        Some(h) => JoinPrepareStatus {
            prepared: false,
            fingerprint: Some(h.fingerprint),
            host_query_id: Some(h.host_query_id),
            join_step_index: Some(h.join_step_index),
            left_rows: Some(h.left_rows),
            right_rows: Some(h.right_rows),
            left_expensive: Some(h.left_expensive),
            right_expensive: Some(h.right_expensive),
            left_materialized: Some(h.left_materialized),
            right_materialized: Some(h.right_materialized),
            stale: true,
        },
        None => JoinPrepareStatus {
            prepared: false,
            fingerprint: None,
            host_query_id: None,
            join_step_index: None,
            left_rows: None,
            right_rows: None,
            left_expensive: None,
            right_expensive: None,
            left_materialized: None,
            right_materialized: None,
            stale: false,
        },
    }
}

pub fn clear_join_prepare(db: &DbSession) -> Result<(), String> {
    db.with_conn(|conn| {
        let _ = conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS {PREP_LEFT};\n\
             DROP TABLE IF EXISTS {PREP_RIGHT};\n\
             DROP TABLE IF EXISTS {PREP_LEFT_BUILDING};\n\
             DROP TABLE IF EXISTS {PREP_RIGHT_BUILDING};"
        ));
        Ok(())
    })?;
    db.join_prep_set(None);
    Ok(())
}

/// Build prep CTE defs using the shared Join emitter (USING / key rename), not raw ON.
fn prep_join_defs(h: &JoinPrepareHandle, left_from: &str, right_from: &str) -> Result<String, String> {
    let left = "prep_left";
    let right = "prep_right";
    let join = "prep_join";
    let step = TransformationStep::Join {
        right_query_id: "__prep_right__".into(),
        join_type: h.join_type.clone(),
        left_on: h.left_on.clone(),
        right_on: h.right_on.clone(),
    };
    let mut rel = HashMap::new();
    rel.insert("__prep_right__".into(), right.to_string());
    let join_sql = emit_transform_step(&step, left, &rel, WarehouseDialect::Duckdb)?;
    Ok(format!(
        "  {left} AS (SELECT * FROM {left_from}),\n\
           {right} AS (SELECT * FROM {right_from}),\n\
           {join} AS (\n\
             {join_sql}\n\
           )"
    ))
}

/// WITH left/right from prep TEMP and/or live CTEs + join CTE.
/// Returns None if fingerprint mismatch, or when nothing was materialized (callers
/// fall back to a full graph compile — both sides are cheap).
pub fn prepared_join_with(
    db: &DbSession,
    workspace: &Workspace,
    sources: &[SourceDef],
    connections: &[ConnectionDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Option<(JoinPrepareHandle, String)> {
    let want = join_prepare_fingerprint(
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    let h = db.join_prep_get()?;
    if h.fingerprint != want {
        return None;
    }
    // Both live → no TEMP shortcut; let callers compile normally.
    if !h.left_materialized && !h.right_materialized {
        return None;
    }

    if h.left_materialized && h.right_materialized {
        let defs = prep_join_defs(&h, PREP_LEFT, PREP_RIGHT).ok()?;
        return Some((h, defs));
    }

    // Mixed: compile only the live side's subgraph, bind the other to TEMP.
    if h.left_materialized && !h.right_materialized {
        let right_compiled = GraphCompiler::new(workspace)
            .with_sources(sources)
            .with_connections(connections)
            .compile_ctes_from(&h.right_query_id)
            .ok()?;
        let rq = workspace.query(&h.right_query_id)?;
        let right_cte = cte_name(&h.right_query_id, rq.steps.len().saturating_sub(1));
        let overlay = prep_join_defs(&h, PREP_LEFT, &right_cte).ok()?;
        let defs = if right_compiled.definitions.is_empty() {
            overlay
        } else {
            format!("{},\n{overlay}", right_compiled.definitions)
        };
        return Some((h, defs));
    }

    // Right TEMP, left live (typical: allocations ⋈ batch_cost).
    let left_ws = left_prefix_workspace(workspace, host_query_id, join_step_index).ok()?;
    let left_compiled = GraphCompiler::new(&left_ws)
        .with_sources(sources)
        .with_connections(connections)
        .compile_ctes_from(host_query_id)
        .ok()?;
    let left_cte = cte_name(host_query_id, join_step_index.saturating_sub(1));
    let overlay = prep_join_defs(&h, &left_cte, PREP_RIGHT).ok()?;
    let defs = if left_compiled.definitions.is_empty() {
        overlay
    } else {
        format!("{},\n{overlay}", left_compiled.definitions)
    };
    Some((h, defs))
}

pub fn prepared_cte_names() -> (&'static str, &'static str, &'static str) {
    ("prep_left", "prep_right", "prep_join")
}

/// Sample rows from a prepared side (LIMIT). TEMP or stored live SQL.
pub fn preview_prepared_join_side(
    db: &DbSession,
    side: &str,
    limit: u64,
) -> Result<PreviewResult, String> {
    let h = db
        .join_prep_get()
        .ok_or_else(|| "Join inputs not prepared — run Prepare first".to_string())?;
    let side = side.trim().to_ascii_lowercase();
    let sql = match side.as_str() {
        "left" => {
            if h.left_materialized {
                format!("SELECT * FROM {PREP_LEFT} LIMIT {limit};")
            } else {
                let base = h
                    .left_live_sql
                    .as_deref()
                    .ok_or("left side has no live SQL")?;
                wrap_limit(base, limit)
            }
        }
        "right" => {
            if h.right_materialized {
                format!("SELECT * FROM {PREP_RIGHT} LIMIT {limit};")
            } else {
                let base = h
                    .right_live_sql
                    .as_deref()
                    .ok_or("right side has no live SQL")?;
                wrap_limit(base, limit)
            }
        }
        other => return Err(format!("side must be left|right (got '{other}')")),
    };
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
        let schema = arrow.get_schema();
        let batches: Vec<RecordBatch> = arrow.collect();
        let columns = schema
            .fields()
            .iter()
            .map(|f| ColumnMetadata {
                name: f.name().clone(),
                col_type: map_arrow_type(f.data_type()),
            })
            .collect();
        Ok(PreviewResult {
            columns,
            rows: batches_to_rows(&batches),
            sql,
        })
    })
}

fn wrap_limit(select_sql: &str, limit: u64) -> String {
    let trimmed = select_sql.trim().trim_end_matches(';');
    format!("SELECT * FROM ({trimmed}) AS _dwh_prep_sample LIMIT {limit};")
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::{JoinType, QueryDef, TransformationStep, Workspace};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn fixture_ws(sample: &Path, dim: &Path, join_type: JoinType) -> Workspace {
        Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        }
    }

    #[test]
    fn prepare_both_cheap_no_temp_reuse() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let ws = fixture_ws(&sample, &dim, JoinType::Inner);
        let db = DbSession::new().unwrap();
        let r1 = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(!r1.reused);
        assert!(!r1.left_expensive);
        assert!(!r1.right_expensive);
        assert!(!r1.left_materialized);
        assert!(!r1.right_materialized);
        assert!(prepared_join_with(&db, &ws, &[], &[], "fact", 1).is_none());
        let r2 = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(r2.reused);
        let side = preview_prepared_join_side(&db, "left", 10).unwrap();
        assert!(!side.columns.is_empty());
        let diag = crate::join_diagnostics::join_diagnostics(&db, &ws, &[], &[], "fact", 1)
            .unwrap();
        assert!(diag.left_count > 0);
    }

    #[test]
    fn prepare_expensive_right_only() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: dim.to_string_lossy().into(),
                        },
                        TransformationStep::DeriveColumn {
                            name: "region_key".into(),
                            expression: "region".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region_key".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let r = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(!r.left_expensive);
        assert!(r.right_expensive);
        assert!(!r.left_materialized);
        assert!(r.right_materialized);
        assert!(r.right_rows > 0);
        let (h, defs) = prepared_join_with(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(h.right_materialized);
        assert!(defs.contains(PREP_RIGHT));
        assert!(!defs.contains(PREP_LEFT));
        assert!(defs.contains("USING"), "prepared join must use USING emitter");
        let diag = crate::join_diagnostics::join_diagnostics(&db, &ws, &[], &[], "fact", 1)
            .unwrap();
        assert_eq!(diag.right_count, r.right_rows);
    }

    #[test]
    fn prepared_full_join_matches_using_schema() {
        let dir = std::env::temp_dir().join(format!(
            "dwh_prep_full_join_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let left_path = dir.join("left.csv");
        let right_path = dir.join("right.csv");
        std::fs::write(&left_path, "id,v\n1,a\n").unwrap();
        std::fs::write(&right_path, "id,w\n2,b\n").unwrap();
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "right".into(),
                    name: "right".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: right_path.to_string_lossy().into(),
                        },
                        TransformationStep::DeriveColumn {
                            name: "marker".into(),
                            expression: "w".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "host".into(),
                    name: "host".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: left_path.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "right".into(),
                            join_type: JoinType::Full,
                            left_on: vec!["id".into()],
                            right_on: vec!["id".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "host".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        // Baseline: full graph compile.
        let resolved = db.prepare_workspace(&ws, &[]).unwrap();
        let compiled = GraphCompiler::new(&resolved)
            .compile_ctes_from("host")
            .unwrap();
        let join_cte = cte_name("host", 1);
        let baseline_sql = compiled.wrap_select(&format!("SELECT * FROM {join_cte}"));
        let baseline = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(&baseline_sql).map_err(|e| e.to_string())?;
                let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
                let schema = arrow.get_schema();
                let cols: Vec<_> = schema.fields().iter().map(|f| f.name().clone()).collect();
                let batches: Vec<RecordBatch> = arrow.collect();
                let n = batches.iter().map(|b| b.num_rows()).sum::<usize>();
                Ok((cols, n))
            })
            .unwrap();

        ensure_join_sides_materialized(&db, &ws, &[], &[], "host", 1, None).unwrap();
        let (_h, defs) = prepared_join_with(&db, &ws, &[], &[], "host", 1).unwrap();
        assert!(defs.contains("USING"), "got: {defs}");
        assert!(!defs.contains(" ON "), "must not use raw ON join: {defs}");
        let prep_sql = format!("WITH \n{defs}\nSELECT * FROM prep_join");
        let prepared = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(&prep_sql).map_err(|e| e.to_string())?;
                let arrow = stmt.query_arrow([]).map_err(|e| e.to_string())?;
                let schema = arrow.get_schema();
                let cols: Vec<_> = schema.fields().iter().map(|f| f.name().clone()).collect();
                let batches: Vec<RecordBatch> = arrow.collect();
                let n = batches.iter().map(|b| b.num_rows()).sum::<usize>();
                Ok((cols, n))
            })
            .unwrap();
        assert_eq!(prepared.0, baseline.0, "schema must match USING join");
        assert_eq!(prepared.1, baseline.1, "row count must match");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_prepare_keeps_prior_cache() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let good = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: dim.to_string_lossy().into(),
                        },
                        TransformationStep::DeriveColumn {
                            name: "region_key".into(),
                            expression: "region".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region_key".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let r1 = prepare_join_inputs(&db, &good, &[], &[], "fact", 1).unwrap();
        assert!(r1.right_materialized);
        let rows_before = preview_prepared_join_side(&db, "right", 50)
            .unwrap()
            .rows
            .len();
        assert!(rows_before > 0);

        let bad = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: dim.to_string_lossy().into(),
                        },
                        TransformationStep::DeriveColumn {
                            name: "region_key".into(),
                            expression: "totally_missing_column".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region_key".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let err = prepare_join_inputs(&db, &bad, &[], &[], "fact", 1);
        assert!(err.is_err(), "bad prepare must fail");

        // Prior good cache must still be readable (not reused=true against missing TEMP).
        let side = preview_prepared_join_side(&db, "right", 50).unwrap();
        assert_eq!(side.rows.len(), rows_before);

        let r2 = prepare_join_inputs(&db, &good, &[], &[], "fact", 1).unwrap();
        assert!(r2.reused);
        let side2 = preview_prepared_join_side(&db, "right", 50).unwrap();
        assert_eq!(side2.rows.len(), rows_before);
    }

    #[test]
    fn file_content_change_invalidates_fingerprint() {
        let dir = std::env::temp_dir().join(format!(
            "dwh_prep_file_rev_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let left_path = dir.join("left.csv");
        let right_path = dir.join("right.csv");
        std::fs::write(&left_path, "region,x\nnorth,1\n").unwrap();
        std::fs::write(&right_path, "region,y\nnorth,2\n").unwrap();
        let ws = fixture_ws(&left_path, &right_path, JoinType::Inner);
        let db = DbSession::new().unwrap();
        ensure_join_sides_materialized(&db, &ws, &[], &[], "fact", 1, None).unwrap();
        let r1 = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(r1.reused);

        // Change file content (mtime + bytes).
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&left_path)
            .unwrap();
        writeln!(f, "region,x\nsouth,9").unwrap();
        drop(f);

        let r2 = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(
            !r2.reused,
            "content change must invalidate fingerprint reuse"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn force_refresh_rebuilds_same_fingerprint() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let ws = fixture_ws(&sample, &dim, JoinType::Inner);
        let db = DbSession::new().unwrap();
        ensure_join_sides_materialized(&db, &ws, &[], &[], "fact", 1, None).unwrap();
        let reused = prepare_join_inputs_with_progress(
            &db, &ws, &[], &[], "fact", 1, None, false,
        )
        .unwrap();
        assert!(reused.reused);
        let forced = prepare_join_inputs_with_progress(
            &db, &ws, &[], &[], "fact", 1, None, true,
        )
        .unwrap();
        assert!(!forced.reused);
    }

    #[test]
    fn ensure_upgrades_only_missing_side() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: dim.to_string_lossy().into(),
                        },
                        TransformationStep::DeriveColumn {
                            name: "region_key".into(),
                            expression: "region".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sample.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region_key".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let r = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(r.right_materialized && !r.left_materialized);
        let right_rows = r.right_rows;
        ensure_join_sides_materialized(&db, &ws, &[], &[], "fact", 1, None).unwrap();
        let h = db.join_prep_get().unwrap();
        assert!(h.left_materialized && h.right_materialized);
        assert_eq!(h.right_rows, right_rows);
        // Right TEMP still readable (was not dropped/rebuilt from scratch unnecessarily).
        assert!(!preview_prepared_join_side(&db, "right", 10)
            .unwrap()
            .rows
            .is_empty());
    }
}
