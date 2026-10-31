//! Materialize Join left/right inputs once; reuse for Lens / diagnostics / near-miss.
//!
//! Only **expensive derived** sides become session TEMP tables. Source-backed sides stay
//! live CTEs (read on demand) so a 200M parquet left is not copied into TEMP.
//!
//! Temp tables live on the session connection. Fingerprint covers workspace + sources +
//! join identity; mismatch → treat as stale (caller re-prepares).

use crate::arrow_json::{batches_to_rows, map_arrow_type};
use crate::preview::{ColumnMetadata, PreviewResult};
use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, join_left_input_is_expensive, join_right_input_is_expensive, quote_ident,
    ConnectionDef, GraphCompiler, JoinType, SourceDef, TransformationStep, Workspace,
};
use duckdb::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

pub const PREP_LEFT: &str = "_dwh_join_prep_left";
pub const PREP_RIGHT: &str = "_dwh_join_prep_right";

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

pub fn join_prepare_fingerprint(
    workspace: &Workspace,
    sources: &[SourceDef],
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
    )
}

/// Same as [`prepare_join_inputs`], updating `progress_slot` for UI polling.
pub fn prepare_join_inputs_with_progress(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    progress_slot: Option<&Mutex<JoinPrepareProgress>>,
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
    )
}

/// Materialize both sides (even source-backed) before diagnostics / near-miss.
/// Anti-joins over a live 200M parquet are multi-minute; TEMP once is cheaper.
pub fn ensure_join_sides_materialized(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
    progress_slot: Option<&Mutex<JoinPrepareProgress>>,
) -> Result<(), String> {
    let fp = join_prepare_fingerprint(workspace, sources, host_query_id, join_step_index);
    if let Some(h) = db.join_prep_get() {
        if h.fingerprint == fp && h.left_materialized && h.right_materialized {
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
) -> Result<JoinPrepareResult, String> {
    let fp = join_prepare_fingerprint(workspace, sources, host_query_id, join_step_index);
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
        .compile_ctes_from(host_query_id)?;

    let left_sql = compiled.wrap_select(&format!("SELECT * FROM {left_cte}"));
    let right_sql = compiled.wrap_select(&format!("SELECT * FROM {right_cte}"));

    let left_materialized = force_both || left_expensive;
    let right_materialized = force_both || right_expensive;

    // Fraction budget for materialize phases.
    let (left_lo, left_hi, right_lo, right_hi) = match (left_materialized, right_materialized) {
        (true, true) => (0.10, 0.50, 0.50, 0.95),
        (true, false) => (0.10, 0.95, 0.95, 0.95),
        (false, true) => (0.10, 0.10, 0.10, 0.95),
        (false, false) => (0.10, 0.10, 0.10, 0.10),
    };

    let result = (|| {
        let (left_rows, right_rows) = db.with_conn(|conn| {
            let _ = conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {PREP_LEFT};\nDROP TABLE IF EXISTS {PREP_RIGHT};"
            ));

            let mut left_rows = 0u64;
            let mut right_rows = 0u64;

            if left_materialized {
                progress(
                    progress_slot,
                    left_lo,
                    "left",
                    "Materializing left (derived)…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                conn.execute_batch(&format!("CREATE TEMP TABLE {PREP_LEFT} AS ({left_sql});"))
                    .map_err(|e| e.to_string())?;
                progress(
                    progress_slot,
                    (left_lo + left_hi) * 0.5,
                    "left",
                    "Counting left…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                left_rows = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {PREP_LEFT}"), [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .map_err(|e| e.to_string())? as u64;
                progress(
                    progress_slot,
                    left_hi,
                    "left",
                    &format!("Left temp · {} rows", left_rows),
                    Some(left_expensive),
                    Some(right_expensive),
                );
            }
            if right_materialized {
                progress(
                    progress_slot,
                    right_lo,
                    "right",
                    "Materializing right (derived)…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                conn.execute_batch(&format!(
                    "CREATE TEMP TABLE {PREP_RIGHT} AS ({right_sql});"
                ))
                .map_err(|e| e.to_string())?;
                progress(
                    progress_slot,
                    (right_lo + right_hi) * 0.5,
                    "right",
                    "Counting right…",
                    Some(left_expensive),
                    Some(right_expensive),
                );
                right_rows = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {PREP_RIGHT}"), [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .map_err(|e| e.to_string())? as u64;
                progress(
                    progress_slot,
                    right_hi,
                    "right",
                    &format!("Right temp · {} rows", right_rows),
                    Some(left_expensive),
                    Some(right_expensive),
                );
            }
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
            if let Some(slot) = progress_slot {
                clear_prepare_progress(slot);
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
    host_query_id: &str,
    join_step_index: usize,
) -> JoinPrepareStatus {
    let want = join_prepare_fingerprint(workspace, sources, host_query_id, join_step_index);
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
            "DROP TABLE IF EXISTS {PREP_LEFT};\nDROP TABLE IF EXISTS {PREP_RIGHT};"
        ));
        Ok(())
    })?;
    db.join_prep_set(None);
    Ok(())
}

fn prep_join_defs(h: &JoinPrepareHandle, left_from: &str, right_from: &str) -> String {
    let left = "prep_left";
    let right = "prep_right";
    let join = "prep_join";
    let on = h
        .left_on
        .iter()
        .zip(h.right_on.iter())
        .map(|(l, r)| format!("l.{} = r.{}", quote_ident(l), quote_ident(r)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let jkw = h.join_type.sql_keyword();
    format!(
        "  {left} AS (SELECT * FROM {left_from}),\n\
           {right} AS (SELECT * FROM {right_from}),\n\
           {join} AS (\n\
             SELECT * FROM {left} l {jkw} {right} r ON {on}\n\
           )"
    )
}

/// WITH left/right from prep TEMP and/or live CTEs + join CTE.
/// Returns None if fingerprint mismatch, or when nothing was materialized (callers
/// fall back to a full graph compile — both sides are cheap).
pub fn prepared_join_with(
    db: &DbSession,
    workspace: &Workspace,
    sources: &[SourceDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Option<(JoinPrepareHandle, String)> {
    let want = join_prepare_fingerprint(workspace, sources, host_query_id, join_step_index);
    let h = db.join_prep_get()?;
    if h.fingerprint != want {
        return None;
    }
    // Both live → no TEMP shortcut; let callers compile normally.
    if !h.left_materialized && !h.right_materialized {
        return None;
    }

    if h.left_materialized && h.right_materialized {
        let defs = prep_join_defs(&h, PREP_LEFT, PREP_RIGHT);
        return Some((h, defs));
    }

    // Mixed: compile only the live side's subgraph, bind the other to TEMP.
    if h.left_materialized && !h.right_materialized {
        let right_compiled = GraphCompiler::new(workspace)
            .with_sources(sources)
            .compile_ctes_from(&h.right_query_id)
            .ok()?;
        let rq = workspace.query(&h.right_query_id)?;
        let right_cte = cte_name(&h.right_query_id, rq.steps.len().saturating_sub(1));
        let overlay = prep_join_defs(&h, PREP_LEFT, &right_cte);
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
        .compile_ctes_from(host_query_id)
        .ok()?;
    let left_cte = cte_name(host_query_id, join_step_index.saturating_sub(1));
    let overlay = prep_join_defs(&h, &left_cte, PREP_RIGHT);
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
    use std::path::PathBuf;

    #[test]
    fn prepare_both_cheap_no_temp_reuse() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        let ws = Workspace {
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
                            join_type: JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let db = DbSession::new().unwrap();
        let r1 = prepare_join_inputs(&db, &ws, &[], &[], "fact", 1).unwrap();
        assert!(!r1.reused);
        assert!(!r1.left_expensive);
        assert!(!r1.right_expensive);
        assert!(!r1.left_materialized);
        assert!(!r1.right_materialized);
        assert!(prepared_join_with(&db, &ws, &[], "fact", 1).is_none());
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
        let (h, defs) = prepared_join_with(&db, &ws, &[], "fact", 1).unwrap();
        assert!(h.right_materialized);
        assert!(defs.contains(PREP_RIGHT));
        assert!(!defs.contains(PREP_LEFT));
        let diag = crate::join_diagnostics::join_diagnostics(&db, &ws, &[], &[], "fact", 1)
            .unwrap();
        assert_eq!(diag.right_count, r.right_rows);
    }
}
