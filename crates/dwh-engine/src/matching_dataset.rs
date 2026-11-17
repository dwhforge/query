//! Dataset-to-dataset Matching. No JOIN, preview, fixture or renderer pagination dependency.
//! A completed run covers every selected LEFT and RIGHT row. Blocking is explicit;
//! candidate search is not described as exhaustive when hard predicates are used.
use crate::{compile_ctes_for_execution, DbSession, MatchingFieldRole, MatchingPlan};
use dwh_pipeline::{cte_name, quote_ident, ConnectionDef, SourceDef, Workspace};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
const DEFAULT_BUDGET: u64 = 2_000_000;
const MAX_PAGE_SIZE: u64 = 200;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetMatchingRequest {
    pub plan: MatchingPlan,
    #[serde(default = "sample_default")]
    pub sample_percent: u8,
    /// RIGHT fraction used only by Estimate; Evaluate always reads 100%.
    #[serde(default = "right_sample_default")]
    pub right_sample_percent: u8,
    #[serde(default = "budget_default")]
    pub max_candidate_pairs: u64,
    #[serde(default = "score_default")]
    pub minimum_score: f64,
}
fn sample_default() -> u8 { 5 }
fn right_sample_default() -> u8 { 100 }
fn budget_default() -> u64 { DEFAULT_BUDGET }
fn score_default() -> f64 { 0.70 }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMatchingEstimate {
    pub sample_percent: u8,
    pub right_sample_percent: u8,
    pub sampled_left: u64,
    pub sampled_right: u64,
    pub left_total: u64,
    pub right_total: u64,
    pub sampled_candidate_pairs: u64,
    pub estimated_candidate_pairs: u64,
    pub candidate_policy: String,
    pub complete: bool,
    pub warning: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMatchingRun {
    pub run_id: String,
    /// Number of distinct LEFT Mapping keys actually evaluated.
    pub left_total: u64,
    /// Total physical LEFT rows represented by those keys.
    pub left_source_rows: u64,
    /// Keys whose source comparison attributes disagree across physical rows.
    pub conflicting_source_keys: u64,
    pub right_total: u64,
    pub candidate_pairs: u64,
    /// Number of evaluated pairs reaching the configured suggestion threshold.
    /// Not the number of distinct LEFT suggestions or approvals.
    pub above_threshold_pairs: u64,
    pub reused_targets: u64,
    pub proposed_sources: u64,
    pub ambiguous_sources: u64,
    pub below_threshold_sources: u64,
    pub unmatched_sources: u64,
    pub candidate_policy: String,
    pub source_coverage: String,
    pub candidate_search_exhaustive: bool,
    pub inputs_transactionally_snapshotted: bool,
    pub minimum_score: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMatchRow {
    pub left_id: i64,
    pub map_key: String,
    pub source_rows: u64,
    pub right_id: Option<i64>,
    pub target_identity: Option<String>,
    pub outputs: Option<String>,
    pub score: Option<f64>,
    pub alternatives: u64,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMatchingPage {
    pub rows: Vec<DatasetMatchRow>,
    pub page: u64,
    pub page_size: u64,
    pub total: u64,
}

fn scalar(db: &DbSession, sql: &str) -> Result<u64, String> {
    db.with_conn(|c| {
        let value: i64 = c.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
        u64::try_from(value).map_err(|_| "negative matching count".to_string())
    })
}
fn safe_run_id(run_id: &str) -> Result<(), String> {
    if run_id.len() > 32 || run_id.is_empty() || !run_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return Err("invalid matching run identifier".into());
    }
    Ok(())
}
fn validate(req: &DatasetMatchingRequest) -> Result<(), String> {
    let p = &req.plan;
    if !(1..=100).contains(&req.sample_percent) { return Err("LEFT Estimate sample must be 1..100%".into()); }
    if !(1..=100).contains(&req.right_sample_percent) { return Err("RIGHT Estimate sample must be 1..100%".into()); }
    if req.max_candidate_pairs == 0 || req.max_candidate_pairs > 100_000_000 { return Err("invalid candidate budget".into()); }
    if !req.minimum_score.is_finite() || !(0.0..=1.0).contains(&req.minimum_score) { return Err("minimum score must be 0..1".into()); }
    if p.source_ref.is_empty() || p.target_ref.is_empty() || p.semantic_revision == 0 ||
       p.map_key_fields.is_empty() || p.target_identity_fields.is_empty() || p.outputs.is_empty() ||
       p.comparisons.is_empty() { return Err("incomplete universal Matching plan".into()); }
    if p.scope != crate::MatchingScopeKind::Full {
        return Err("dataset Matching currently supports only explicit full scope".into());
    }
    if p.comparisons.iter().all(|c| c.role == MatchingFieldRole::ReferenceContext) {
        return Err("at least one scoring or hard constraint comparison is required".into());
    }
    for n in &p.normalization {
        if !matches!(n.as_str(), "trim" | "lower" | "upper" | "casefold" | "collapse_space" | "ltrim_zeros") {
            return Err(format!("unsupported Matching normalization: {n}"));
        }
    }
    Ok(())
}
fn fields(req: &DatasetMatchingRequest, left: bool) -> Vec<String> {
    let p = &req.plan;
    let mut out = if left { p.map_key_fields.clone() } else {
        p.target_identity_fields.iter().chain(p.outputs.iter()).cloned().collect()
    };
    for c in &p.comparisons {
        let f = if left { &c.source_field } else { &c.target_field };
        if !out.contains(f) { out.push(f.clone()); }
    }
    out
}
fn json_values(alias: &str, cols: &[String]) -> String {
    let items = cols.iter().map(|c| format!("CAST({alias}.{} AS VARCHAR)", quote_ident(c))).collect::<Vec<_>>().join(", ");
    format!("CAST(to_json(list_value({items})) AS VARCHAR)")
}
fn norm(alias: &str, field: &str, plan: &MatchingPlan) -> String {
    let mut sql = format!("CAST({alias}.{} AS VARCHAR)", quote_ident(field));
    for op in &plan.normalization {
        sql = match op.as_str() {
            "trim" => format!("trim({sql})"),
            "lower" | "casefold" => format!("lower({sql})"),
            "upper" => format!("upper({sql})"),
            "collapse_space" => format!("regexp_replace({sql}, '\\s+', ' ', 'g')"),
            "ltrim_zeros" => format!("ltrim({sql}, '0')"),
            _ => unreachable!("validated normalization"),
        }
    }
    sql
}
fn hard_predicate(req: &DatasetMatchingRequest) -> String {
    let hard = req.plan.comparisons.iter().filter(|c| c.role == MatchingFieldRole::HardConstraint)
        .map(|c| format!("({} = {} AND {} <> '')", norm("l", &c.source_field, &req.plan), norm("r", &c.target_field, &req.plan), norm("l", &c.source_field, &req.plan)))
        .collect::<Vec<_>>();
    if hard.is_empty() { "TRUE".into() } else { hard.join(" AND ") }
}
fn score_expression(req: &DatasetMatchingRequest) -> String {
    let soft = req.plan.comparisons.iter().filter(|c| c.role == MatchingFieldRole::SoftSignal)
        .map(|c| {
            let l = norm("l", &c.source_field, &req.plan);
            let r = norm("r", &c.target_field, &req.plan);
            format!("CASE WHEN {l} IS NULL OR {r} IS NULL OR trim({l}) = '' OR trim({r}) = '' THEN 0.0 ELSE jaro_winkler_similarity({l}, {r}) END")
        })
        .collect::<Vec<_>>();
    if soft.is_empty() { "1.0".into() } else { format!("({}) / {}", soft.join(" + "), soft.len()) }
}
fn stage(db: &DbSession, workspace: &Workspace, connections: &[ConnectionDef], sources: &[SourceDef], req: &DatasetMatchingRequest, suffix: &str) -> Result<(String, String), String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let left = resolved.query(&req.plan.source_ref).ok_or("source query missing")?;
    let right = resolved.query(&req.plan.target_ref).ok_or("target query missing")?;
    if left.steps.is_empty() || right.steps.is_empty() { return Err("empty query cannot be evaluated".into()); }
    let lcte = compile_ctes_for_execution(db, &resolved, connections, sources, &req.plan.source_ref)?;
    let rcte = compile_ctes_for_execution(db, &resolved, connections, sources, &req.plan.target_ref)?;
    let lsql = format!("WITH {} SELECT * FROM {}", lcte.definitions, cte_name(&req.plan.source_ref, left.steps.len() - 1));
    let rsql = format!("WITH {} SELECT * FROM {}", rcte.definitions, cte_name(&req.plan.target_ref, right.steps.len() - 1));
    let lt = format!("__dwh_match_l_{suffix}");
    let rt = format!("__dwh_match_r_{suffix}");
    let lfields = fields(req, true);
    let rfields = fields(req, false);
    let select = |cols: &[String]| cols.iter().map(|s| quote_ident(s)).collect::<Vec<_>>().join(", ");
    // The unit of Mapping is a complete LEFT key, not a fact row. Retain the
    // number of physical rows and explicitly detect disagreement in attributes
    // used for matching. Never choose an arbitrary row and call it authoritative.
    let key_json = json_values("l", &req.plan.map_key_fields);
    let evidence_fields = req.plan.comparisons.iter()
        .filter(|c| c.role != MatchingFieldRole::ReferenceContext)
        .map(|c| norm("l", &c.source_field, &req.plan))
        .collect::<Vec<_>>().join(", ");
    let evidence_json = format!("CAST(to_json(list_value({evidence_fields})) AS VARCHAR)");
    let run = || db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE {lt} AS WITH raw AS (SELECT {} FROM ({lsql}) src), keyed AS (
               SELECT l.*, row_number() OVER (PARTITION BY {key_json} ORDER BY {key_json}) AS __key_rank,
                 count(*) OVER (PARTITION BY {key_json}) AS __source_rows,
                 min({evidence_json}) OVER (PARTITION BY {key_json}) AS __evidence_min,
                 max({evidence_json}) OVER (PARTITION BY {key_json}) AS __evidence_max
               FROM raw l
             ) SELECT row_number() OVER () AS __matching_row_id, {}, __source_rows,
               (__evidence_min IS DISTINCT FROM __evidence_max) AS __source_conflict
               FROM keyed WHERE __key_rank = 1;",
            select(&lfields), select(&lfields)
        )).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("CREATE TEMP TABLE {rt} AS SELECT row_number() OVER () AS __matching_row_id, {} FROM ({rsql}) AS src;", select(&rfields))).map_err(|e| e.to_string())?;
        Ok(())
    });
    if let Err(e) = run() {
        let _ = db.with_conn(|c| c.execute_batch(&format!("DROP TABLE IF EXISTS {lt}; DROP TABLE IF EXISTS {rt}" )).map_err(|e| e.to_string()));
        return Err(e);
    }
    // Map identity and outputs must never be silently coerced to empty strings.
    for (table, cols) in [(&lt, &req.plan.map_key_fields), (&rt, &req.plan.target_identity_fields), (&rt, &req.plan.outputs)] {
        let predicate = cols.iter().map(|f| format!("{} IS NULL", quote_ident(f))).collect::<Vec<_>>().join(" OR ");
        if scalar(db, &format!("SELECT count(*) FROM {table} WHERE {predicate}"))? != 0 {
            let _ = db.with_conn(|c| c.execute_batch(&format!("DROP TABLE IF EXISTS {lt}; DROP TABLE IF EXISTS {rt}")).map_err(|e| e.to_string()));
            return Err("refused: NULL in Matching identity / output field".into());
        }
    }
    Ok((lt, rt))
}
fn drop_staging(db: &DbSession, lt: &str, rt: &str) {
    let _ = db.with_conn(|c| c.execute_batch(&format!("DROP TABLE IF EXISTS {lt}; DROP TABLE IF EXISTS {rt}")).map_err(|e| e.to_string()));
}
/// Exact nonempty sample size; never silently produce zero rows from a tiny
/// but nonempty dataset when the user requests 1..100%.
fn sample_size(total: u64, percentage: u8) -> u64 {
    if total == 0 { 0 } else {
        (((total as u128 * percentage as u128) + 99) / 100) as u64
    }
}

fn count_candidate_pairs(db: &DbSession, lt: &str, rt: &str, req: &DatasetMatchingRequest, sample_sizes: Option<(u64, u64)>) -> Result<u64, String> {
    // ORDER BY identity hash makes sampling independent of renderer pages and
    // query row order. The row id is only the deterministic tie-breaker inside
    // an already materialized input. At 100% no sorting is performed.
    let left = if let Some((size, _)) = sample_sizes {
        if req.sample_percent == 100 { format!("{lt} l") } else {
            let key = json_values("l", &req.plan.map_key_fields);
            format!("(SELECT * FROM {lt} l ORDER BY hash({key}), l.__matching_row_id LIMIT {size}) l")
        }
    } else { format!("{lt} l") };
    let right = if let Some((_, size)) = sample_sizes {
        if req.right_sample_percent == 100 { format!("{rt} r") } else {
            let key = json_values("r", &req.plan.target_identity_fields);
            format!("(SELECT * FROM {rt} r ORDER BY hash({key}), r.__matching_row_id LIMIT {size}) r")
        }
    } else { format!("{rt} r") };
    let join = hard_predicate(req);
    // LIMIT stops the count early on broad Cartesian products: no silent truncation.
    // Exclude contradictory source-key groups just as Evaluate does; otherwise
    // the preflight budget can refuse work that will never be scored.
    scalar(db, &format!("SELECT count(*) FROM (SELECT 1 FROM {left} JOIN {right} ON ({join}) AND NOT l.__source_conflict LIMIT {}) counted", req.max_candidate_pairs + 1))
}

pub fn estimate_dataset_matching(db: &DbSession, workspace: &Workspace, connections: &[ConnectionDef], sources: &[SourceDef], req: &DatasetMatchingRequest) -> Result<DatasetMatchingEstimate, String> {
    validate(req)?;
    let suffix = format!("e{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed));
    let (lt, rt) = stage(db, workspace, connections, sources, req, &suffix)?;
    let result = (|| {
        let left_total = scalar(db, &format!("SELECT count(*) FROM {lt}"))?;
        let right_total = scalar(db, &format!("SELECT count(*) FROM {rt}"))?;
        let sampled_left = sample_size(left_total, req.sample_percent);
        let sampled_right = sample_size(right_total, req.right_sample_percent);
        let candidates = count_candidate_pairs(db, &lt, &rt, req, Some((sampled_left, sampled_right)))?;
        if candidates > req.max_candidate_pairs { return Err("Estimate refused: sampled candidate set exceeds budget".into()); }
        let estimate = if sampled_left == 0 || sampled_right == 0 { 0 } else {
            ((candidates as u128 * left_total as u128 * right_total as u128)
             / (sampled_left as u128 * sampled_right as u128)).min(u64::MAX as u128) as u64
        };
        Ok(DatasetMatchingEstimate { sample_percent: req.sample_percent,
            right_sample_percent: req.right_sample_percent,
            sampled_left, sampled_right, left_total, right_total,
            sampled_candidate_pairs: candidates, estimated_candidate_pairs: estimate,
            candidate_policy: if req.plan.comparisons.iter().any(|c| c.role == MatchingFieldRole::HardConstraint) { "hard_constraints" } else { "cartesian" }.into(),
            complete: false, warning: "Cost estimate only, not Matching coverage or recall. Sampling RIGHT may omit true matches; a zero observed count does not prove zero candidates.".into() })
    })();
    drop_staging(db, &lt, &rt);
    result
}

pub fn evaluate_dataset_matching(db: &DbSession, workspace: &Workspace, connections: &[ConnectionDef], sources: &[SourceDef], req: &DatasetMatchingRequest) -> Result<DatasetMatchingRun, String> {
    validate(req)?;
    let suffix = format!("r{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed));
    let (lt, rt) = stage(db, workspace, connections, sources, req, &suffix)?;
    let pairs = format!("__dwh_match_p_{suffix}");
    let results = format!("__dwh_match_s_{suffix}");
    let response = (|| {
        let left_total = scalar(db, &format!("SELECT count(*) FROM {lt}"))?;
        let left_source_rows = scalar(db, &format!("SELECT coalesce(sum(__source_rows),0) FROM {lt}"))?;
        let conflicting_source_keys = scalar(db, &format!("SELECT count(*) FROM {lt} WHERE __source_conflict"))?;
        let right_total = scalar(db, &format!("SELECT count(*) FROM {rt}"))?;
        let comparisons = count_candidate_pairs(db, &lt, &rt, req, None)?;
        if comparisons > req.max_candidate_pairs { return Err(format!("Evaluate refused: {comparisons}+ candidate pairs exceeds budget {}; use stronger hard constraints or increase explicit budget", req.max_candidate_pairs)); }
        let join = hard_predicate(req);
        let score = score_expression(req);
        let targets = json_values("r", &req.plan.target_identity_fields);
        let outputs = json_values("r", &req.plan.outputs);
        let source_key = json_values("l", &req.plan.map_key_fields);
        db.with_conn(|conn| conn.execute_batch(&format!(
            "CREATE TEMP TABLE {pairs} AS SELECT l.__matching_row_id AS left_id, r.__matching_row_id AS right_id, {targets} AS target_identity, {outputs} AS outputs, CAST({score} AS DOUBLE) AS score FROM {lt} l JOIN {rt} r ON {join} WHERE NOT l.__source_conflict;"
        )).map_err(|e| e.to_string()))?;
        db.with_conn(|conn| conn.execute_batch(&format!(
            "CREATE TEMP TABLE {results} AS WITH ranked AS (SELECT *, row_number() OVER (PARTITION BY left_id ORDER BY score DESC, right_id ASC) AS rn, lead(score) OVER (PARTITION BY left_id ORDER BY score DESC, right_id ASC) AS second_score, count(*) OVER (PARTITION BY left_id) AS alternatives FROM {pairs}), winners AS (SELECT * FROM ranked WHERE rn = 1) SELECT l.__matching_row_id AS left_id, {source_key} AS map_key, l.__source_rows AS source_rows, w.right_id, w.target_identity, w.outputs, w.score, coalesce(w.alternatives, 0) AS alternatives, CASE WHEN l.__source_conflict THEN 'source_conflict' WHEN w.right_id IS NULL THEN 'unmatched' WHEN w.score < {} THEN 'below_threshold' WHEN w.second_score >= {} AND w.score - w.second_score < 0.03 THEN 'ambiguous' ELSE 'proposed' END AS state FROM {lt} l LEFT JOIN winners w ON l.__matching_row_id = w.left_id;",
            req.minimum_score, req.minimum_score
        )).map_err(|e| e.to_string()))?;
        db.with_conn(|conn| conn.execute_batch(&format!(
            "CREATE TEMP TABLE __dwh_match_d_{suffix} (left_id BIGINT PRIMARY KEY, right_id BIGINT, action VARCHAR NOT NULL);"
        )).map_err(|e| e.to_string()))?;
        crate::ensure_matching_publication_journal(db, &suffix)?;
        let candidate_pairs = scalar(db, &format!("SELECT count(*) FROM {pairs}"))?;
        let above_threshold_pairs = scalar(db, &format!("SELECT count(*) FROM {pairs} WHERE score >= {}", req.minimum_score))?;
        if above_threshold_pairs > candidate_pairs { return Err("matching candidate score invariant violated".into()); }
        let reused_targets = scalar(db, &format!("SELECT count(*) FROM (SELECT target_identity FROM {results} WHERE state IN ('proposed', 'ambiguous') GROUP BY target_identity HAVING count(*) > 1) reused"))?;
        let proposed_sources = scalar(db, &format!("SELECT count(*) FROM {results} WHERE state = 'proposed'"))?;
        let ambiguous_sources = scalar(db, &format!("SELECT count(*) FROM {results} WHERE state = 'ambiguous'"))?;
        let below_threshold_sources = scalar(db, &format!("SELECT count(*) FROM {results} WHERE state = 'below_threshold'"))?;
        let unmatched_sources = scalar(db, &format!("SELECT count(*) FROM {results} WHERE state = 'unmatched'"))?;
        let conflicting_results = scalar(db, &format!("SELECT count(*) FROM {results} WHERE state = 'source_conflict'"))?;
        if conflicting_results != conflicting_source_keys || proposed_sources + ambiguous_sources + below_threshold_sources + unmatched_sources + conflicting_results != left_total || left_source_rows < left_total {
            return Err("matching logical-key/physical-row coverage invariant violated".into());
        }
        Ok(DatasetMatchingRun { run_id: suffix.clone(), left_total, left_source_rows, conflicting_source_keys, right_total, candidate_pairs, above_threshold_pairs, reused_targets, proposed_sources, ambiguous_sources, below_threshold_sources, unmatched_sources,
            candidate_policy: if req.plan.comparisons.iter().any(|c| c.role == MatchingFieldRole::HardConstraint) { "hard_constraints" } else { "cartesian" }.into(),
            source_coverage: "complete".into(), candidate_search_exhaustive:
                !req.plan.comparisons.iter().any(|c| c.role == MatchingFieldRole::HardConstraint),
            inputs_transactionally_snapshotted: false, minimum_score: req.minimum_score })
    })();
    if response.is_err() {
        let _ = db.with_conn(|c| c.execute_batch(&format!("DROP TABLE IF EXISTS {pairs}; DROP TABLE IF EXISTS {results}; DROP TABLE IF EXISTS __dwh_match_d_{suffix}; DROP TABLE IF EXISTS __dwh_match_pub_{suffix}")).map_err(|e| e.to_string()));
        drop_staging(db, &lt, &rt);
    } else {
        // The materialized relationships carry the display and review evidence.
        drop_staging(db, &lt, &rt);
    }
    response
}

pub fn dataset_matching_page(db: &DbSession, run_id: &str, page: u64, page_size: u64, filter: Option<&str>) -> Result<DatasetMatchingPage, String> {
    safe_run_id(run_id)?;
    if page_size == 0 || page_size > MAX_PAGE_SIZE { return Err("page size must be 1..200".into()); }
    let offset = page.checked_mul(page_size).ok_or("page overflow")?;
    let table = format!("__dwh_match_s_{run_id}");
    let decisions = format!("__dwh_match_d_{run_id}");
    let where_clause = match filter.unwrap_or("all") {
        "all" => String::new(),
        // Includes below-threshold and no-candidate cases, but excludes keys
        // blocked by unresolved source attribute conflicts.
        "needs_review" => "WHERE d.left_id IS NULL AND s.state <> 'source_conflict'".to_string(),
        "proposed" | "ambiguous" | "below_threshold" | "unmatched" | "source_conflict" | "confirm" | "reject" | "defer" | "no_target" =>
            format!("WHERE coalesce(d.action, s.state) = '{}'", filter.unwrap_or("all")),
        _ => return Err("invalid matching result filter".into()),
    };
    let from = format!("FROM {table} s LEFT JOIN {decisions} d ON d.left_id=s.left_id {where_clause}");
    // Only the visible rows need the chosen candidate. Keep the count query
    // independent of the potentially very large scored-pairs relation.
    let from_with_choice = format!("FROM {table} s LEFT JOIN {decisions} d ON d.left_id=s.left_id LEFT JOIN __dwh_match_p_{run_id} chosen ON d.action='confirm' AND chosen.left_id=d.left_id AND chosen.right_id=d.right_id {where_clause}");
    let total = scalar(db, &format!("SELECT count(*) {from}"))?;
    let rows = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!("SELECT s.left_id, s.map_key, s.source_rows, CASE WHEN d.action='confirm' THEN chosen.right_id ELSE s.right_id END, CASE WHEN d.action='confirm' THEN chosen.target_identity ELSE s.target_identity END, CASE WHEN d.action='confirm' THEN chosen.outputs ELSE s.outputs END, CASE WHEN d.action='confirm' THEN chosen.score ELSE s.score END, s.alternatives, coalesce(d.action, s.state) AS state {from_with_choice} ORDER BY s.left_id LIMIT {page_size} OFFSET {offset}")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(DatasetMatchRow { left_id: r.get(0)?, map_key: r.get(1)?, source_rows: r.get::<_, i64>(2)? as u64, right_id: r.get(3)?, target_identity: r.get(4)?, outputs: r.get(5)?, score: r.get(6)?, alternatives: r.get::<_, i64>(7)? as u64, state: r.get(8)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })?;
    Ok(DatasetMatchingPage { rows, page, page_size, total })
}

pub fn dataset_matching_candidates(db: &DbSession, run_id: &str, left_id: i64, page: u64, page_size: u64) -> Result<DatasetMatchingPage, String> {
    safe_run_id(run_id)?;
    if page_size == 0 || page_size > MAX_PAGE_SIZE { return Err("page size must be 1..200".into()); }
    let offset = page.checked_mul(page_size).ok_or("page overflow")?;
    let pairs = format!("__dwh_match_p_{run_id}");
    let source = format!("__dwh_match_s_{run_id}");
    let total = scalar(db, &format!("SELECT count(*) FROM {pairs} WHERE left_id = {left_id}"))?;
    let rows = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!("SELECT p.left_id, s.map_key, s.source_rows, p.right_id, p.target_identity, p.outputs, p.score, s.alternatives, s.state FROM {pairs} p JOIN {source} s ON s.left_id = p.left_id WHERE p.left_id = {left_id} ORDER BY p.score DESC, p.right_id LIMIT {page_size} OFFSET {offset}")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(DatasetMatchRow { left_id: r.get(0)?, map_key: r.get(1)?, source_rows: r.get::<_, i64>(2)? as u64, right_id: r.get(3)?, target_identity: r.get(4)?, outputs: r.get(5)?, score: r.get(6)?, alternatives: r.get::<_, i64>(7)? as u64, state: r.get(8)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })?;
    Ok(DatasetMatchingPage { rows, page, page_size, total })
}

pub fn drop_dataset_matching_run(db: &DbSession, run_id: &str) -> Result<(), String> {
    safe_run_id(run_id)?;
    db.with_conn(|conn| conn.execute_batch(&format!("DROP TABLE IF EXISTS __dwh_match_p_{run_id}; DROP TABLE IF EXISTS __dwh_match_s_{run_id}; DROP TABLE IF EXISTS __dwh_match_d_{run_id}; DROP TABLE IF EXISTS __dwh_match_pub_{run_id}")).map_err(|e| e.to_string()))
}

/// Review decisions are stored with the materialized run, never in the preview page.
/// Confirm requires exact candidate membership in the scored set; no renderer-provided
/// outputs or identity are trusted. Mapping writes remain a separate guarded operation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetReviewRequest {
    pub run_id: String,
    pub left_id: i64,
    pub right_id: Option<i64>,
    pub action: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetReviewStats { pub reviewed: u64, pub confirmed: u64, pub deferred: u64, pub rejected: u64 }

pub fn dataset_matching_decide(db: &DbSession, request: &DatasetReviewRequest) -> Result<DatasetReviewStats, String> {
    safe_run_id(&request.run_id)?;
    if !matches!(request.action.as_str(), "confirm" | "reject" | "defer" | "no_target") {
        return Err("invalid review action".into());
    }
    let d = format!("__dwh_match_d_{}", request.run_id);
    let s = format!("__dwh_match_s_{}", request.run_id);
    let p = format!("__dwh_match_p_{}", request.run_id);
    crate::ensure_matching_publication_journal(db, &request.run_id)?;
    // Published decisions are immutable: changing their target or withdrawing
    // approval cannot silently rewrite a source table already committed.
    if scalar(db, &format!("SELECT count(*) FROM __dwh_match_pub_{} WHERE left_id = {}", request.run_id, request.left_id))? > 0 {
        return Err("This Matching key has already been published; create a new reviewed revision before changing its decision".into());
    }
    if scalar(db, &format!("SELECT count(*) FROM {s} WHERE left_id = {}", request.left_id))? != 1 {
        return Err("stale review: LEFT row is not in run".into());
    }
    if request.action == "confirm" {
        if scalar(db, &format!("SELECT count(*) FROM {s} WHERE left_id = {} AND state = 'source_conflict'", request.left_id))? != 0 {
            return Err("conflicting LEFT matching attributes for this Mapping key; resolve source data before confirming".into());
        }
        let target = request.right_id.ok_or("confirm needs exact rightId")?;
        if scalar(db, &format!("SELECT count(*) FROM {p} WHERE left_id = {} AND right_id = {target}", request.left_id))? != 1 {
            return Err("candidate is not present in evaluated evidence".into());
        }
    } else if request.right_id.is_some() {
        return Err("non-confirm review must not set rightId".into());
    }
    db.with_conn(|conn| conn.execute(
        &format!("INSERT INTO {d} (left_id, right_id, action) VALUES (?1, ?2, ?3) ON CONFLICT (left_id) DO UPDATE SET right_id = EXCLUDED.right_id, action = EXCLUDED.action"),
        duckdb::params![request.left_id, request.right_id, request.action],
    ).map(|_| ()).map_err(|e| e.to_string()))?;
    dataset_matching_review_stats(db, &request.run_id)
}

pub fn dataset_matching_confirm_unambiguous(db: &DbSession, run_id: &str) -> Result<DatasetReviewStats, String> {
    safe_run_id(run_id)?;
    let d = format!("__dwh_match_d_{run_id}");
    let s = format!("__dwh_match_s_{run_id}");
    db.with_conn(|conn| conn.execute_batch(&format!(
        "INSERT INTO {d}(left_id,right_id,action) SELECT left_id,right_id,'confirm' FROM {s} WHERE state='proposed' AND left_id NOT IN (SELECT left_id FROM {d})"
    )).map_err(|e| e.to_string()))?;
    dataset_matching_review_stats(db, run_id)
}

pub fn dataset_matching_review_stats(db: &DbSession, run_id: &str) -> Result<DatasetReviewStats, String> {
    safe_run_id(run_id)?;
    let d = format!("__dwh_match_d_{run_id}");
    let count = |condition: &str| scalar(db, &format!("SELECT count(*) FROM {d} WHERE {condition}"));
    Ok(DatasetReviewStats { reviewed: count("true")?, confirmed: count("action='confirm'")?, deferred: count("action='defer'")?, rejected: count("action IN ('reject','no_target')")? })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetApprovedMappingPage {
    pub rows: Vec<DatasetApprovedMappingRow>,
    pub page: u64,
    pub page_size: u64,
    pub total: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetApprovedMappingRow { pub map_key: String, pub outputs: String, pub target_identity: String }

/// Read confirmed mappings for explicit downstream mapping staging. The caller must
/// still run the existing mapping field-shape, baseline-conflict and write checks.
pub fn dataset_matching_approved_page(db: &DbSession, run_id: &str, page: u64, page_size: u64) -> Result<DatasetApprovedMappingPage, String> {
    safe_run_id(run_id)?;
    if page_size == 0 || page_size > MAX_PAGE_SIZE { return Err("page size must be 1..200".into()); }
    let offset = page.checked_mul(page_size).ok_or("page overflow")?;
    let d = format!("__dwh_match_d_{run_id}");
    let p = format!("__dwh_match_p_{run_id}");
    let s = format!("__dwh_match_s_{run_id}");
    let joined = format!("{d} d JOIN {p} p ON d.left_id=p.left_id AND d.right_id=p.right_id JOIN {s} s ON s.left_id=d.left_id");
    let total = scalar(db, &format!("SELECT count(*) FROM {joined} WHERE d.action='confirm'"))?;
    let rows = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!("SELECT s.map_key,p.outputs,p.target_identity FROM {joined} WHERE d.action='confirm' ORDER BY d.left_id LIMIT {page_size} OFFSET {offset}")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(DatasetApprovedMappingRow { map_key: r.get(0)?, outputs: r.get(1)?, target_identity: r.get(2)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })?;
    Ok(DatasetApprovedMappingPage { rows, page, page_size, total })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMatchingComparison {
    pub first_run: String,
    pub second_run: String,
    pub common_keys: u64,
    pub changed_target: u64,
    pub changed_score: u64,
    pub changed_status: u64,
    pub changed_candidate_count: u64,
    pub changed_source_rows: u64,
    pub became_matched: u64,
    pub became_unmatched: u64,
    pub first_only: u64,
    pub second_only: u64,
    pub snapshot_verified: bool,
}

/// Comparing set results is meaningful only with unique Mapping keys. Input
/// snapshots are not provably identical: report an *indicative* difference,
/// never a verified A/B improvement claim.
pub fn compare_dataset_matching(db: &DbSession, first: &str, second: &str) -> Result<DatasetMatchingComparison, String> {
    safe_run_id(first)?;
    safe_run_id(second)?;
    let a = format!("__dwh_match_s_{first}");
    let b = format!("__dwh_match_s_{second}");
    for table in [&a, &b] {
        if scalar(db, &format!("SELECT count(*) FROM (SELECT map_key FROM {table} GROUP BY map_key HAVING count(*) > 1) collisions"))? > 0 {
            return Err("A/B requires unique source Mapping keys; duplicate key occurrence is not a stable comparison identity".into());
        }
    }
    let joined = format!("FROM {a} a FULL OUTER JOIN {b} b ON a.map_key = b.map_key");
    let count = |predicate: &str| scalar(db, &format!("SELECT count(*) {joined} WHERE {predicate}"));
    Ok(DatasetMatchingComparison {
        first_run: first.into(), second_run: second.into(),
        common_keys: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL")?,
        changed_target: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND (a.outputs IS DISTINCT FROM b.outputs OR a.target_identity IS DISTINCT FROM b.target_identity)")?,
        changed_score: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.score IS DISTINCT FROM b.score")?,
        changed_status: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.state IS DISTINCT FROM b.state")?,
        changed_candidate_count: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.alternatives IS DISTINCT FROM b.alternatives")?,
        changed_source_rows: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.source_rows IS DISTINCT FROM b.source_rows")?,
        became_matched: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.right_id IS NULL AND b.right_id IS NOT NULL")?,
        became_unmatched: count("a.left_id IS NOT NULL AND b.left_id IS NOT NULL AND a.right_id IS NOT NULL AND b.right_id IS NULL")?,
        first_only: count("a.left_id IS NOT NULL AND b.left_id IS NULL")?,
        second_only: count("a.left_id IS NULL AND b.left_id IS NOT NULL")?,
        snapshot_verified: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn run_identifier_never_enters_sql_unsanitized() { assert!(safe_run_id("r123_abc").is_ok()); assert!(safe_run_id("r1;DROP TABLE x").is_err()); }
    #[test] fn default_estimate_percentage_is_five() { assert_eq!(sample_default(), 5); assert_eq!(right_sample_default(), 100); assert_eq!(sample_size(6, 5), 1); assert_eq!(sample_size(0, 5), 0); assert_eq!(sample_size(500, 20), 100); }
    #[test] fn page_limit_is_bounded() { assert_eq!(MAX_PAGE_SIZE, 200); }

    #[test]
    fn ab_comparison_reports_score_status_and_coverage_changes() {
        let db = DbSession::new().unwrap();
        db.with_conn(|conn| conn.execute_batch(
            "CREATE TEMP TABLE __dwh_match_s_r901 (left_id BIGINT, map_key VARCHAR, outputs VARCHAR, target_identity VARCHAR, right_id BIGINT, score DOUBLE, state VARCHAR, alternatives BIGINT, source_rows BIGINT); \
             INSERT INTO __dwh_match_s_r901 VALUES (1, '[\"A\"]', '[\"X\"]', '[\"X\"]', 1, 0.8, 'proposed', 2, 3); \
             CREATE TEMP TABLE __dwh_match_s_r902 AS SELECT * FROM __dwh_match_s_r901; \
             UPDATE __dwh_match_s_r902 SET score=0.9, state='ambiguous', alternatives=3, source_rows=4;"
        ).map_err(|e| e.to_string())).unwrap();
        let result = compare_dataset_matching(&db, "r901", "r902").unwrap();
        assert_eq!(result.common_keys, 1);
        assert_eq!(result.changed_target, 0);
        assert_eq!(result.changed_score, 1);
        assert_eq!(result.changed_status, 1);
        assert_eq!(result.changed_candidate_count, 1);
        assert_eq!(result.changed_source_rows, 1);
    }


    #[test]
    fn dataset_evaluate_covers_more_than_old_trial_and_mass_caps() {
        use dwh_pipeline::{QueryDef, TransformationStep};
        let base = std::env::temp_dir().join(format!("dwh_matching_contract_{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&base).unwrap();
        let left_path = base.join("left.csv");
        let right_path = base.join("right.csv");
        let mut l = "code,name\n".to_string();
        let mut r = "id,code,name\n".to_string();
        for i in 0..500 {
            l.push_str(&format!("C{i:04},Item{i:04}\n"));
            r.push_str(&format!("R{i:04},C{i:04},Item{i:04}\n"));
        }
        std::fs::write(&left_path, l).unwrap();
        std::fs::write(&right_path, r).unwrap();
        let ws = Workspace { queries: vec![
            QueryDef { id: "left".into(), name: "left".into(), steps: vec![TransformationStep::LoadCsv { path: left_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
            QueryDef { id: "right".into(), name: "right".into(), steps: vec![TransformationStep::LoadCsv { path: right_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
        ], focus_query_id: "left".into(), key_maps: vec![] };
        let req = DatasetMatchingRequest {
            plan: MatchingPlan {
                source_ref: "left".into(), target_ref: "right".into(),
                map_key_fields: vec!["code".into()], target_identity_fields: vec!["id".into()],
                outputs: vec!["id".into()],
                comparisons: vec![
                    crate::MatchingPlanComparison { source_field: "code".into(), target_field: "code".into(), role: MatchingFieldRole::HardConstraint },
                    crate::MatchingPlanComparison { source_field: "name".into(), target_field: "name".into(), role: MatchingFieldRole::SoftSignal },
                ], normalization: vec!["trim".into(), "casefold".into()],
                ambiguity: crate::MatchingAmbiguityPolicy::LeaveForManual,
                scope: crate::MatchingScopeKind::Full, semantic_revision: 1, ui_revision: 0,
            }, sample_percent: 5, right_sample_percent: 100, max_candidate_pairs: 1000, minimum_score: 0.7,
        };
        let db = DbSession::new().unwrap();
        let mut invalid_right_sample = req.clone();
        invalid_right_sample.right_sample_percent = 0;
        assert!(validate(&invalid_right_sample).unwrap_err().contains("RIGHT Estimate"));
        invalid_right_sample.right_sample_percent = 101;
        assert!(validate(&invalid_right_sample).unwrap_err().contains("RIGHT Estimate"));
        let mut small_budget = req.clone();
        small_budget.max_candidate_pairs = 100;
        let refusal = evaluate_dataset_matching(&db, &ws, &[], &[], &small_budget).unwrap_err();
        assert!(refusal.contains("budget"), "{refusal}");
        let estimate = estimate_dataset_matching(&db, &ws, &[], &[], &req).unwrap();
        assert_eq!(estimate.sample_percent, 5);
        assert_eq!(estimate.right_sample_percent, 100);
        assert_eq!(estimate.sampled_right, 500);
        let mut both_sampled = req.clone();
        both_sampled.right_sample_percent = 20;
        let cost = estimate_dataset_matching(&db, &ws, &[], &[], &both_sampled).unwrap();
        assert_eq!(cost.sampled_left, 25);
        assert_eq!(cost.sampled_right, 100);
        assert_eq!(cost.right_sample_percent, 20);
        assert!(!estimate.complete);
        let run = evaluate_dataset_matching(&db, &ws, &[], &[], &req).unwrap();
        assert_eq!(run.left_total, 500);
        assert_eq!(run.right_total, 500);
        assert_eq!(run.proposed_sources, 500);
        assert_eq!(run.unmatched_sources, 0);
        assert_eq!(run.below_threshold_sources, 0);
        assert_eq!(run.candidate_pairs, 500);
        assert_eq!(run.above_threshold_pairs, 500);
        // Full Evaluate ignores BOTH Estimate fractions. Changing sampling cannot
        // alter completed relationship or pair statistics.
        let mut different_samples = req.clone();
        different_samples.sample_percent = 100;
        different_samples.right_sample_percent = 1;
        let another = evaluate_dataset_matching(&db, &ws, &[], &[], &different_samples).unwrap();
        assert_eq!(another.left_total, run.left_total);
        assert_eq!(another.right_total, run.right_total);
        assert_eq!(another.candidate_pairs, run.candidate_pairs);
        assert_eq!(another.proposed_sources, run.proposed_sources);
        drop_dataset_matching_run(&db, &another.run_id).unwrap();
        let p0 = dataset_matching_page(&db, &run.run_id, 0, 50, None).unwrap();
        let p9 = dataset_matching_page(&db, &run.run_id, 9, 50, None).unwrap();
        assert_eq!(p0.total, 500);
        assert_eq!(p0.rows.len(), 50);
        assert_eq!(p9.rows.len(), 50);
        let first = &p0.rows[0];
        assert!(dataset_matching_decide(&db, &DatasetReviewRequest {
            run_id: run.run_id.clone(), left_id: first.left_id, right_id: Some(9_999_999),
            action: "confirm".into(),
        }).is_err());
        let comparison = compare_dataset_matching(&db, &run.run_id, &run.run_id).unwrap();
        assert_eq!(comparison.common_keys, 500);
        assert_eq!(comparison.changed_target, 0);
        assert!(!comparison.snapshot_verified);
        let stats = dataset_matching_decide(&db, &DatasetReviewRequest {
            run_id: run.run_id.clone(), left_id: first.left_id, right_id: first.right_id,
            action: "confirm".into(),
        }).unwrap();
        assert_eq!(stats.confirmed, 1);
        let all = dataset_matching_confirm_unambiguous(&db, &run.run_id).unwrap();
        assert_eq!(all.confirmed, 500);
        let approved = dataset_matching_approved_page(&db, &run.run_id, 0, 200).unwrap();
        assert_eq!(approved.total, 500);
        assert_eq!(approved.rows.len(), 200);
        drop_dataset_matching_run(&db, &run.run_id).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn candidate_evidence_survives_below_threshold() {
        let db = DbSession::new().unwrap();
        db.with_conn(|conn| conn.execute_batch("CREATE TEMP TABLE __test_scores(left_id BIGINT, right_id BIGINT, score DOUBLE); INSERT INTO __test_scores VALUES (1, 1, 0.50), (1, 2, 0.45), (2, 3, 0.93), (2, 4, 0.92), (3, 5, 0.95);").map_err(|e| e.to_string())).unwrap();
        let classification = db.with_conn(|conn| {
            let sql = "WITH ranked AS (SELECT *, row_number() OVER (PARTITION BY left_id ORDER BY score DESC, right_id ASC) AS rn, lead(score) OVER (PARTITION BY left_id ORDER BY score DESC, right_id ASC) AS second_score FROM __test_scores) SELECT left_id, CASE WHEN score < 0.70 THEN 'below_threshold' WHEN second_score >= 0.70 AND score - second_score < 0.03 THEN 'ambiguous' ELSE 'proposed' END FROM ranked WHERE rn = 1 ORDER BY left_id";
            let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = statement.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        }).unwrap();
        assert_eq!(classification, vec![(1, "below_threshold".into()), (2, "ambiguous".into()), (3, "proposed".into())]);
    }

    #[test]
    fn live_dataset_evaluation_distinguishes_three_outcomes() {
        use dwh_pipeline::{QueryDef, TransformationStep};
        let base = std::env::temp_dir().join(format!("dwh_matching_states_{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&base).unwrap();
        let left_path = base.join("left.csv");
        let right_path = base.join("right.csv");
        std::fs::write(&left_path, "code,name
X1,aaaa
X2,Gamma
X3,Orphan
").unwrap();
        std::fs::write(&right_path, "id,code,name
R1,X1,zzzz
R2,X2,Gamma
R3,X2,Gamma
").unwrap();
        let ws = Workspace { queries: vec![
            QueryDef { id: "left".into(), name: "left".into(), steps: vec![TransformationStep::LoadCsv { path: left_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
            QueryDef { id: "right".into(), name: "right".into(), steps: vec![TransformationStep::LoadCsv { path: right_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
        ], focus_query_id: "left".into(), key_maps: vec![] };
        let req = DatasetMatchingRequest { plan: MatchingPlan {
            source_ref: "left".into(), target_ref: "right".into(),
            map_key_fields: vec!["code".into()], target_identity_fields: vec!["id".into()],
            outputs: vec!["id".into()], comparisons: vec![
                crate::MatchingPlanComparison { source_field: "code".into(), target_field: "code".into(), role: MatchingFieldRole::HardConstraint },
                crate::MatchingPlanComparison { source_field: "name".into(), target_field: "name".into(), role: MatchingFieldRole::SoftSignal },
            ], normalization: vec!["trim".into(), "casefold".into()],
            ambiguity: crate::MatchingAmbiguityPolicy::LeaveForManual,
            scope: crate::MatchingScopeKind::Full, semantic_revision: 1, ui_revision: 0,
        }, sample_percent: 5, right_sample_percent: 100, max_candidate_pairs: 100, minimum_score: 0.9 };
        let db = DbSession::new().unwrap();
        let run = evaluate_dataset_matching(&db, &ws, &[], &[], &req).unwrap();
        assert_eq!(run.left_total, 3);
        assert_eq!(run.candidate_pairs, 3);
        assert_eq!(run.above_threshold_pairs, 2);
        assert_eq!(run.below_threshold_sources, 1);
        assert_eq!(run.ambiguous_sources, 1);
        assert_eq!(run.unmatched_sources, 1);
        assert_eq!(run.proposed_sources, 0);
        let below = dataset_matching_page(&db, &run.run_id, 0, 50, Some("below_threshold")).unwrap();
        assert_eq!(below.total, 1);
        assert!(below.rows[0].score.unwrap() < 0.9);
        let alternatives = dataset_matching_candidates(&db, &run.run_id, below.rows[0].left_id, 0, 50).unwrap();
        assert_eq!(alternatives.total, 1, "below-threshold evidence remains reviewable");
        assert_eq!(dataset_matching_confirm_unambiguous(&db, &run.run_id).unwrap().confirmed, 0);
        drop_dataset_matching_run(&db, &run.run_id).unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn full_evaluation_refuses_budget_without_sampling() {
        // Budget validation does not admit zero or excessively large silent runs.
        let req: DatasetMatchingRequest = serde_json::from_value(serde_json::json!({
            "plan": {
                "sourceRef": "a", "targetRef": "b", "mapKeyFields": ["code"],
                "targetIdentityFields": ["id"], "outputs": ["id"],
                "comparisons": [{"sourceField":"name","targetField":"name","role":"soft_signal"}],
                "scope":"full", "ambiguity":"leave_for_manual", "semanticRevision":1,"uiRevision":0
            }, "samplePercent":5,"maxCandidatePairs":0,"minimumScore":0.7
        })).unwrap();
        assert!(validate(&req).unwrap_err().contains("budget"));
    }
    #[test]
    fn grouped_left_preserves_physical_rows_and_refuses_conflicts() {
        use dwh_pipeline::{QueryDef, TransformationStep};
        let base = std::env::temp_dir().join(format!("dwh_matching_grouped_{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&base).unwrap();
        let left_path = base.join("left.csv");
        let right_path = base.join("right.csv");
        std::fs::write(&left_path, "code,name\nA,Alpha\nA,Alpha\nB,Beta\nB,Conflicting\nC,Gamma\nC,Gamma\nC,Gamma\n").unwrap();
        std::fs::write(&right_path, "id,name\nR1,Alpha\nR2,Beta\nR3,Gamma\n").unwrap();
        let ws = Workspace { queries: vec![
            QueryDef { id: "left".into(), name: "left".into(), steps: vec![TransformationStep::LoadCsv { path: left_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
            QueryDef { id: "right".into(), name: "right".into(), steps: vec![TransformationStep::LoadCsv { path: right_path.to_string_lossy().into(), path_kind: Default::default() }], execution: Default::default() },
        ], focus_query_id: "left".into(), key_maps: vec![] };
        let req = DatasetMatchingRequest { plan: MatchingPlan {
            source_ref: "left".into(), target_ref: "right".into(),
            map_key_fields: vec!["code".into()], target_identity_fields: vec!["id".into()], outputs: vec!["id".into()],
            comparisons: vec![crate::MatchingPlanComparison { source_field: "name".into(), target_field: "name".into(), role: MatchingFieldRole::SoftSignal }],
            normalization: vec!["trim".into(), "casefold".into()], ambiguity: crate::MatchingAmbiguityPolicy::LeaveForManual,
            scope: crate::MatchingScopeKind::Full, semantic_revision: 1, ui_revision: 0,
        }, sample_percent: 5, right_sample_percent: 100, max_candidate_pairs: 6, minimum_score: 0.7 };
        let db = DbSession::new().unwrap();
        let run = evaluate_dataset_matching(&db, &ws, &[], &[], &req).unwrap();
        assert_eq!(run.left_total, 3, "relationship-set rows are unique keys");
        assert_eq!(run.left_source_rows, 7, "all physical rows remain accounted");
        assert_eq!(run.conflicting_source_keys, 1);
        assert_eq!(run.candidate_pairs, 6, "only two consistent keys are scored against 3 RIGHT rows");
        let page = dataset_matching_page(&db, &run.run_id, 0, 50, None).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.rows.iter().map(|r| r.source_rows).sum::<u64>(), 7);
        let conflict = page.rows.iter().find(|r| r.map_key == r#"["B"]"#).unwrap();
        assert_eq!(conflict.state, "source_conflict");
        assert!(dataset_matching_decide(&db, &DatasetReviewRequest { run_id: run.run_id.clone(), left_id: conflict.left_id,
            right_id: conflict.right_id, action: "confirm".into() }).is_err());
        let reviewed = dataset_matching_confirm_unambiguous(&db, &run.run_id).unwrap();
        assert_eq!(reviewed.confirmed, 2, "only nonconflicting keys can be bulk-confirmed");
        let approved = dataset_matching_approved_page(&db, &run.run_id, 0, 50).unwrap();
        assert_eq!(approved.total, 2);
        drop_dataset_matching_run(&db, &run.run_id).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

}
