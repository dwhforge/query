//! Bounded Matching retrieval with run caps (ADR-0044).
//! Pure in-memory shortlist — no silent full-dictionary download.

use super::caps::{
    LLM_CANDIDATES_PER_KEY, LOCAL_TARGET_UNIVERSE_ROWS, MASS_RUN_UNIQUE_KEYS,
    MAX_LLM_CALLS_PER_RUN, RETRIEVAL_SHORTLIST_PER_KEY, TRIAL_UNIQUE_KEYS,
};
use super::types::{
    MatchingCandidate, MatchingFieldRole, MatchingPlan, MatchingProposal, MatchingProposalState,
    MatchingProvenance,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingRunMode {
    Trial,
    Mass,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingSourceRow {
    pub map_key: Vec<String>,
    #[serde(default)]
    pub fields: HashMap<String, String>,
    #[serde(default = "one")]
    pub affected_source_rows: u32,
}

fn one() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingTargetRow {
    pub target_id: String,
    #[serde(default)]
    pub fields: HashMap<String, String>,
    pub output_values: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingRetrieveRequest {
    pub session_id: String,
    pub plan: MatchingPlan,
    pub mode: MatchingRunMode,
    pub source_rows: Vec<MatchingSourceRow>,
    pub target_rows: Vec<MatchingTargetRow>,
    /// Remaining LLM call budget for this run (incl. prior plan calls).
    #[serde(default = "default_llm_budget")]
    pub llm_budget_remaining: u32,
    /// When true, attempt one expand pass if shortlist empty (still within caps).
    #[serde(default)]
    pub allow_expand: bool,
}

fn default_llm_budget() -> u32 {
    MAX_LLM_CALLS_PER_RUN as u32
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingRunMetrics {
    pub mode: MatchingRunMode,
    pub keys_requested: u32,
    pub keys_processed: u32,
    pub keys_unprocessed: u32,
    pub candidates_scored: u32,
    pub llm_calls: u32,
    pub llm_retries: u32,
    pub duration_ms: u64,
    pub stop_reason: Option<String>,
    pub key_cap: u32,
    pub shortlist_per_key: u32,
    pub llm_per_key: u32,
    pub max_llm_calls: u32,
    pub local_universe: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingRetrieveResult {
    pub candidates: Vec<MatchingCandidate>,
    pub proposals: Vec<MatchingProposal>,
    pub metrics: MatchingRunMetrics,
    /// Target ids eligible for LLM (≤ llm_per_key per proposal, truncated).
    pub llm_candidate_ids_by_proposal: HashMap<String, Vec<String>>,
    /// Ranked shortlist evidence per source proposal, not global candidate scores.
    /// This is bounded by shortlist_per_key and is not a complete competitor universe.
    #[serde(default)]
    pub candidate_scores_by_proposal: HashMap<String, Vec<MatchingCandidateScore>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingCandidateScore {
    pub candidate_id: String,
    /// Mean of soft signals only; unknown when the plan has no soft signals.
    pub score: Option<f64>,
    /// Aligned to plan.comparisons. Hard/reference fields are unscored (null).
    pub field_scores: Vec<Option<f64>>,
}

/// Apply only explicitly supported plan operations, in the declared order.
fn normalize(value: &str, operations: &[String]) -> String {
    operations
        .iter()
        .fold(value.to_owned(), |value, op| match op.as_str() {
            "trim" => value.trim().to_owned(),
            "lower" => value.to_lowercase(),
            "upper" => value.to_uppercase(),
            "collapse_space" => value.split_whitespace().collect::<Vec<_>>().join(" "),
            "ltrim_zeros" => value.trim_start_matches('0').to_owned(),
            // The canonical plan normalization token is `casefold` (trim + case
            // fold). Accept it as a case fold so the shared Basic/Advanced plan
            // vocabulary is honored instead of refused. Identity/outputs are never
            // normalized, so this only affects comparison values.
            "casefold" => value.trim().to_lowercase(),
            _ => unreachable!("normalization validated before retrieval"),
        })
}

/// Strip common English legal / noise tokens for soft business-name compare.
/// Tier‑1 only — no thesaurus. Semantic aliases are cascade Tier‑2 (LLM expand).
fn business_core(s: &str) -> String {
    let mut t = s.to_owned();
    for noise in [
        " limited",
        " ltd.",
        " ltd",
        " llc.",
        " llc",
        " inc.",
        " inc",
        " corp.",
        " corp",
        " co.",
        " company",
        " international",
        " division",
        " div.",
        " the ",
    ] {
        t = t.replace(noise, " ");
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    if n > 48 || m > 48 {
        return n.max(m);
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0; m + 1];
    for i in 1..=n {
        cur[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m]
}

fn field_score(src: &str, tgt: &str) -> f64 {
    let a = src;
    let b = tgt;
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let ca = business_core(&a);
    let cb = business_core(&b);
    if !ca.is_empty() && ca == cb {
        return 0.95;
    }
    // Containment / shared prefix — typos and truncated labels.
    if a.contains(b) || b.contains(a) || ca.contains(&cb) || cb.contains(&ca) {
        return 0.85;
    }
    let min_l = ca.len().min(cb.len()).max(1);
    let dist = levenshtein(&ca, &cb);
    if dist * 100 / min_l <= 25 && min_l >= 4 {
        return 0.8;
    }
    let min_raw = a.len().min(b.len());
    let mut pref = 0;
    for (x, y) in a.chars().zip(b.chars()) {
        if x == y {
            pref += 1;
        } else {
            break;
        }
    }
    if min_raw > 0 && pref * 100 / min_raw >= 70 {
        return 0.7;
    }
    0.0
}

fn key_cap(mode: MatchingRunMode) -> usize {
    match mode {
        MatchingRunMode::Trial => TRIAL_UNIQUE_KEYS,
        MatchingRunMode::Mass => MASS_RUN_UNIQUE_KEYS,
    }
}

/// Retrieve bounded candidates/proposals. Refuses silent full download over universe cap.
pub fn matching_retrieve(req: MatchingRetrieveRequest) -> Result<MatchingRetrieveResult, String> {
    let started = std::time::Instant::now();
    if req.target_rows.len() > LOCAL_TARGET_UNIVERSE_ROWS {
        return Err(format!(
            "refused: target universe {} exceeds local cap {} — use server-side retrieval or reduce scope (no silent full download)",
            req.target_rows.len(),
            LOCAL_TARGET_UNIVERSE_ROWS
        ));
    }
    if req.plan.outputs.is_empty() {
        return Err("refused: plan outputs empty".into());
    }
    for op in &req.plan.normalization {
        if !matches!(
            op.as_str(),
            "trim" | "lower" | "upper" | "collapse_space" | "ltrim_zeros" | "casefold"
        ) {
            return Err(format!(
                "refused: unsupported normalization operation {op:?}"
            ));
        }
    }
    // The string-only wire cannot represent missing/NULL comparison values. Never
    // invent empty strings (including for reference-only fields).
    for comparison in &req.plan.comparisons {
        if req
            .source_rows
            .iter()
            .any(|row| !row.fields.contains_key(&comparison.source_field))
        {
            return Err(format!(
                "refused: missing source comparison field {:?}",
                comparison.source_field
            ));
        }
        if req
            .target_rows
            .iter()
            .any(|row| !row.fields.contains_key(&comparison.target_field))
        {
            return Err(format!(
                "refused: missing target comparison field {:?}",
                comparison.target_field
            ));
        }
    }

    let cap = key_cap(req.mode);
    let keys_requested = req.source_rows.len();
    let (process, rest) = if req.source_rows.len() > cap {
        (&req.source_rows[..cap], req.source_rows.len() - cap)
    } else {
        (req.source_rows.as_slice(), 0)
    };

    let hard: Vec<_> = req
        .plan
        .comparisons
        .iter()
        .filter(|c| matches!(c.role, MatchingFieldRole::HardConstraint))
        .collect();

    let mut candidates: Vec<MatchingCandidate> = Vec::new();
    let mut cand_index: HashMap<String, String> = HashMap::new(); // target_id → candidate_id
    for t in &req.target_rows {
        if t.output_values.len() != req.plan.outputs.len() {
            return Err(format!(
                "refused: target {} outputs arity {} ≠ plan {}",
                t.target_id,
                t.output_values.len(),
                req.plan.outputs.len()
            ));
        }
        let cid = format!("cand:{}", t.target_id);
        cand_index.insert(t.target_id.clone(), cid.clone());
        candidates.push(MatchingCandidate {
            candidate_id: cid,
            session_id: req.session_id.clone(),
            target_id: t.target_id.clone(),
            output_values: t.output_values.clone(),
            evidence_revision: req.plan.semantic_revision,
        });
    }

    let mut proposals = Vec::new();
    let mut llm_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut score_map = HashMap::new();
    let mut scored = 0u32;
    let mut stop_reason: Option<String> = None;
    if rest > 0 {
        stop_reason = Some("key_cap".into());
    }

    for (i, src) in process.iter().enumerate() {
        if src.map_key.len() != req.plan.map_key_fields.len() {
            return Err(format!("refused: source map_key arity mismatch at row {i}"));
        }

        #[derive(Clone)]
        struct Rank {
            target_id: String,
            score: Option<f64>,
            field_scores: Vec<Option<f64>>,
        }

        let mut ranks: Vec<Rank> = Vec::new();
        for t in &req.target_rows {
            scored += 1;
            let hard_ok = hard.iter().all(|h| {
                let sv = normalize(&src.fields[&h.source_field], &req.plan.normalization);
                let tv = normalize(&t.fields[&h.target_field], &req.plan.normalization);
                !sv.trim().is_empty() && !tv.trim().is_empty() && sv == tv
            });
            if !hard_ok {
                continue;
            }
            let mut score = 0.0;
            let mut n = 0;
            let field_scores = req
                .plan
                .comparisons
                .iter()
                .map(|s| {
                    if s.role != MatchingFieldRole::SoftSignal {
                        return None;
                    }
                    let sv = normalize(&src.fields[&s.source_field], &req.plan.normalization);
                    let tv = normalize(&t.fields[&s.target_field], &req.plan.normalization);
                    let value = field_score(&sv, &tv);
                    score += value;
                    n += 1;
                    Some(value)
                })
                .collect();
            ranks.push(Rank {
                target_id: t.target_id.clone(),
                score: (n > 0).then(|| score / n as f64),
                field_scores,
            });
        }

        ranks.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let eligible_count = ranks
            .iter()
            .filter(|r| r.score.map_or(true, |s| s >= 0.7))
            .count();
        let mut shortlist: Vec<Rank> = ranks
            .iter()
            .filter(|r| r.score.map_or(true, |s| s >= 0.7))
            .take(RETRIEVAL_SHORTLIST_PER_KEY)
            .cloned()
            .collect();

        let mut incomplete = eligible_count > RETRIEVAL_SHORTLIST_PER_KEY;
        if shortlist.is_empty() && req.allow_expand && !ranks.is_empty() {
            // Relax the soft cutoff only. Hard failures never enter ranks.
            shortlist = ranks
                .iter()
                .take(RETRIEVAL_SHORTLIST_PER_KEY.min(10))
                .cloned()
                .collect();
            incomplete = true;
        }

        let pid = format!("prop:{}:{}", i, src.map_key.join("|"));
        let (state, proposed, alts) = if shortlist.is_empty() {
            if incomplete {
                (MatchingProposalState::IncompleteSearch, None, vec![])
            } else {
                (MatchingProposalState::NoCandidates, None, vec![])
            }
        } else if shortlist.len() == 1 && shortlist[0].score.is_some_and(|s| s >= 0.9) {
            let cid = cand_index.get(&shortlist[0].target_id).cloned();
            (MatchingProposalState::Proposed, cid, vec![])
        } else {
            let best = &shortlist[0];
            let cid = cand_index.get(&best.target_id).cloned();
            let alts: Vec<_> = shortlist
                .iter()
                .skip(1)
                .filter_map(|r| cand_index.get(&r.target_id).cloned())
                .collect();
            if best.score.map_or(true, |s| s < 0.9) || !alts.is_empty() {
                (MatchingProposalState::Ambiguous, cid, alts)
            } else {
                (MatchingProposalState::Proposed, cid, alts)
            }
        };

        // Empty hard region + multiple name hits → force ambiguous, no auto pick.
        let empty_hard = hard.iter().any(|h| {
            src.fields
                .get(&h.source_field)
                .map(|v| normalize(v, &req.plan.normalization).trim().is_empty())
                .unwrap_or(true)
        });
        let (state, proposed, alts) = if empty_hard && shortlist.len() != 1 {
            let ids: Vec<_> = shortlist
                .iter()
                .filter_map(|r| cand_index.get(&r.target_id).cloned())
                .collect();
            (MatchingProposalState::Ambiguous, None, ids)
        } else {
            (state, proposed, alts)
        };

        let llm_ids: Vec<String> = shortlist
            .iter()
            .take(LLM_CANDIDATES_PER_KEY)
            .filter_map(|r| cand_index.get(&r.target_id).cloned())
            .collect();
        llm_map.insert(pid.clone(), llm_ids);
        score_map.insert(
            pid.clone(),
            shortlist
                .iter()
                .map(|r| MatchingCandidateScore {
                    candidate_id: cand_index[&r.target_id].clone(),
                    score: r.score,
                    field_scores: r.field_scores.clone(),
                })
                .collect(),
        );

        proposals.push(MatchingProposal {
            proposal_id: pid,
            session_id: req.session_id.clone(),
            map_key: src.map_key.clone(),
            affected_source_rows: src.affected_source_rows,
            proposed_candidate_id: proposed,
            alternative_candidate_ids: alts,
            state,
            provenance: MatchingProvenance::Fuzzy,
            semantic_plan_revision: req.plan.semantic_revision,
            evidence_revision: req.plan.semantic_revision,
            search_incomplete: incomplete,
        });
    }

    // LLM budget is not spent here — retrieval is deterministic. Report remaining as 0 calls.
    let metrics = MatchingRunMetrics {
        mode: req.mode,
        keys_requested: keys_requested as u32,
        keys_processed: process.len() as u32,
        keys_unprocessed: rest as u32,
        candidates_scored: scored,
        llm_calls: 0,
        llm_retries: 0,
        duration_ms: started.elapsed().as_millis() as u64,
        stop_reason,
        key_cap: cap as u32,
        shortlist_per_key: RETRIEVAL_SHORTLIST_PER_KEY as u32,
        llm_per_key: LLM_CANDIDATES_PER_KEY as u32,
        max_llm_calls: req.llm_budget_remaining.min(MAX_LLM_CALLS_PER_RUN as u32),
        local_universe: LOCAL_TARGET_UNIVERSE_ROWS as u32,
    };

    Ok(MatchingRetrieveResult {
        candidates,
        proposals,
        metrics,
        llm_candidate_ids_by_proposal: llm_map,
        candidate_scores_by_proposal: score_map,
    })
}

#[cfg(test)]
mod retrieve_tests {
    use super::*;
    use crate::matching::types::{
        MatchingAmbiguityPolicy, MatchingFieldRole, MatchingPlanComparison, MatchingScopeKind,
    };

    fn plan() -> MatchingPlan {
        MatchingPlan {
            source_ref: "Client".into(),
            target_ref: "A".into(),
            map_key_fields: vec!["provider".into(), "region".into()],
            target_identity_fields: vec!["id".into()],
            comparisons: vec![
                MatchingPlanComparison {
                    source_field: "provider".into(),
                    target_field: "name".into(),
                    role: MatchingFieldRole::SoftSignal,
                },
                MatchingPlanComparison {
                    source_field: "region".into(),
                    target_field: "region".into(),
                    role: MatchingFieldRole::HardConstraint,
                },
            ],
            normalization: vec![],
            outputs: vec!["id".into()],
            ambiguity: MatchingAmbiguityPolicy::LeaveForManual,
            scope: MatchingScopeKind::Cohort,
            semantic_revision: 1,
            ui_revision: 0,
        }
    }

    #[test]
    fn refuses_oversize_universe() {
        let targets: Vec<_> = (0..LOCAL_TARGET_UNIVERSE_ROWS + 1)
            .map(|i| MatchingTargetRow {
                target_id: i.to_string(),
                fields: HashMap::new(),
                output_values: vec![i.to_string()],
            })
            .collect();
        let err = matching_retrieve(MatchingRetrieveRequest {
            session_id: "s".into(),
            plan: plan(),
            mode: MatchingRunMode::Trial,
            source_rows: vec![],
            target_rows: targets,
            llm_budget_remaining: 220,
            allow_expand: false,
        })
        .unwrap_err();
        assert!(err.contains("local cap"), "{err}");
    }

    #[test]
    fn trial_caps_unprocessed_keys() {
        let targets = vec![MatchingTargetRow {
            target_id: "1".into(),
            fields: [
                ("name".into(), "a1".into()),
                ("region".into(), "Europe".into()),
            ]
            .into_iter()
            .collect(),
            output_values: vec!["1".into()],
        }];
        let sources: Vec<_> = (0..25)
            .map(|i| MatchingSourceRow {
                map_key: vec![format!("k{i}"), "Europe".into()],
                fields: [
                    ("provider".into(), format!("k{i}")),
                    ("region".into(), "Europe".into()),
                ]
                .into_iter()
                .collect(),
                affected_source_rows: 1,
            })
            .collect();
        let out = matching_retrieve(MatchingRetrieveRequest {
            session_id: "s".into(),
            plan: plan(),
            mode: MatchingRunMode::Trial,
            source_rows: sources,
            target_rows: targets,
            llm_budget_remaining: 220,
            allow_expand: false,
        })
        .unwrap();
        assert_eq!(out.metrics.keys_processed, TRIAL_UNIQUE_KEYS as u32);
        assert_eq!(out.metrics.keys_unprocessed, 5);
        assert_eq!(out.metrics.stop_reason.as_deref(), Some("key_cap"));
    }

    #[test]
    fn empty_region_does_not_auto_pick_among_namesakes() {
        let targets = vec![
            MatchingTargetRow {
                target_id: "1".into(),
                fields: [
                    ("name".into(), "a1".into()),
                    ("region".into(), "Europe".into()),
                ]
                .into_iter()
                .collect(),
                output_values: vec!["1".into()],
            },
            MatchingTargetRow {
                target_id: "2".into(),
                fields: [
                    ("name".into(), "a1".into()),
                    ("region".into(), "RUS".into()),
                ]
                .into_iter()
                .collect(),
                output_values: vec!["2".into()],
            },
        ];
        let out = matching_retrieve(MatchingRetrieveRequest {
            session_id: "s".into(),
            plan: plan(),
            mode: MatchingRunMode::Trial,
            source_rows: vec![MatchingSourceRow {
                map_key: vec!["a1".into(), "".into()],
                fields: [
                    ("provider".into(), "a1".into()),
                    ("region".into(), "".into()),
                ]
                .into_iter()
                .collect(),
                affected_source_rows: 3,
            }],
            target_rows: targets,
            llm_budget_remaining: 220,
            allow_expand: true,
        })
        .unwrap();
        assert_eq!(out.proposals.len(), 1);
        assert_eq!(out.proposals[0].state, MatchingProposalState::Ambiguous);
        assert!(out.proposals[0].proposed_candidate_id.is_none());
    }

    #[test]
    fn hard_typo_is_not_a_candidate_even_with_expansion() {
        let targets = vec![
            MatchingTargetRow {
                target_id: "1".into(),
                fields: [
                    ("name".into(), "a1".into()),
                    ("region".into(), "Europe".into()),
                ]
                .into_iter()
                .collect(),
                output_values: vec!["1".into()],
            },
            MatchingTargetRow {
                target_id: "2".into(),
                fields: [
                    ("name".into(), "a1".into()),
                    ("region".into(), "RUS".into()),
                ]
                .into_iter()
                .collect(),
                output_values: vec!["2".into()],
            },
        ];
        let out = matching_retrieve(MatchingRetrieveRequest {
            session_id: "s".into(),
            plan: plan(),
            mode: MatchingRunMode::Trial,
            source_rows: vec![MatchingSourceRow {
                map_key: vec!["a1".into(), "Eurpope".into()],
                fields: [
                    ("provider".into(), "a1".into()),
                    ("region".into(), "Eurpope".into()),
                ]
                .into_iter()
                .collect(),
                affected_source_rows: 24,
            }],
            target_rows: targets,
            llm_budget_remaining: 220,
            allow_expand: true,
        })
        .unwrap();
        let p = &out.proposals[0];
        assert_eq!(p.state, MatchingProposalState::NoCandidates);
        assert!(p.proposed_candidate_id.is_none());
        assert!(p.alternative_candidate_ids.is_empty());
        assert!(out.llm_candidate_ids_by_proposal[&p.proposal_id].is_empty());
        assert!(out.candidate_scores_by_proposal[&p.proposal_id].is_empty());
    }

    #[test]
    fn soft_score_tier1_is_algorithmic_not_thesaurus() {
        // Exact / legal-suffix normalize.
        assert!(
            (field_score("ComputerParts LLC", "ComputerParts") - 0.85).abs() < 0.01
                || field_score("ComputerParts LLC", "ComputerParts") >= 0.85
        );
        // Typo within Levenshtein band.
        assert!(field_score("KomputerParts LLC", "ComputerParts LLC") >= 0.75);
        // Semantic / world-knowledge must NOT be faked in Tier‑1 (cascade → LLM).
        assert!(field_score("USA", "United States") < 0.5);
        assert!(field_score("NW bottled water", "Nestlé Waters") < 0.5);
        assert!(field_score("Acme Widgets", "Globex") < 0.5);
    }

    fn request(source_region: &str, target_region: &str) -> MatchingRetrieveRequest {
        MatchingRetrieveRequest {
            session_id: "live".into(),
            plan: plan(),
            mode: MatchingRunMode::Trial,
            source_rows: vec![MatchingSourceRow {
                map_key: vec![" Raw | Key ".into(), source_region.into()],
                fields: [
                    ("provider".into(), "Acme".into()),
                    ("region".into(), source_region.into()),
                ]
                .into(),
                affected_source_rows: 7,
            }],
            target_rows: vec![MatchingTargetRow {
                target_id: " Raw ID ".into(),
                fields: [
                    ("name".into(), "Acme".into()),
                    ("region".into(), target_region.into()),
                ]
                .into(),
                output_values: vec![" Raw Output ".into()],
            }],
            llm_budget_remaining: 0,
            allow_expand: false,
        }
    }

    fn evidence(out: &MatchingRetrieveResult) -> &[MatchingCandidateScore] {
        &out.candidate_scores_by_proposal[&out.proposals[0].proposal_id]
    }

    #[test]
    fn hard_equality_rejects_containment_suffix_case_and_whitespace_without_operations() {
        for (source, target) in [
            ("Europe", "Europe West"),
            ("Acme ltd", "Acme"),
            ("Europe", "europe"),
            (" Europe ", "Europe"),
            ("", ""),
            ("   ", "   "),
        ] {
            for expand in [false, true] {
                let mut req = request(source, target);
                req.allow_expand = expand;
                let out = matching_retrieve(req).unwrap();
                assert!(
                    evidence(&out).is_empty(),
                    "{source:?}, {target:?}, expand={expand}"
                );
                assert!(out.proposals[0].proposed_candidate_id.is_none());
                assert!(out.proposals[0].alternative_candidate_ids.is_empty());
                assert!(out
                    .llm_candidate_ids_by_proposal
                    .values()
                    .all(Vec::is_empty));
            }
        }
    }

    #[test]
    fn supported_normalization_is_ordered_and_does_not_mutate_identity_or_outputs() {
        for (ops, source, target) in [
            (vec!["trim", "lower"], " EUROPE ", "europe"),
            (vec!["upper"], "éurope", "ÉUROPE"),
            (
                vec!["collapse_space", "lower"],
                "  North\t  Europe \n",
                "north europe",
            ),
            (vec!["trim", "ltrim_zeros"], " 00042 ", "42"),
            (vec!["lower", "upper"], "Europe", "EUROPE"),
        ] {
            let mut req = request(source, target);
            req.plan.normalization = ops.into_iter().map(String::from).collect();
            let original_key = req.source_rows[0].map_key.clone();
            let out = matching_retrieve(req).unwrap();
            assert_eq!(evidence(&out)[0].score, Some(1.0));
            assert_eq!(out.proposals[0].map_key, original_key);
            assert_eq!(out.proposals[0].affected_source_rows, 7);
            assert_eq!(out.candidates[0].target_id, " Raw ID ");
            assert_eq!(out.candidates[0].output_values, [" Raw Output "]);
        }
        let mut req = request(" 00042 ", "42");
        req.plan.normalization = vec!["ltrim_zeros".into(), "trim".into()];
        assert!(evidence(&matching_retrieve(req).unwrap()).is_empty());
    }

    #[test]
    fn canonical_casefold_token_is_trim_then_lower_for_comparisons_only() {
        // The shared Basic/Advanced canonical plan uses ["trim", "casefold"].
        // It must be honored (trim + case fold on comparison values only), not
        // refused as an unsupported token.
        let mut req = request("  EUROPE ", "europe");
        req.plan.normalization = vec!["trim".into(), "casefold".into()];
        let out = matching_retrieve(req.clone()).unwrap();
        assert_eq!(evidence(&out)[0].score, Some(1.0));
        // Identity and outputs are never normalized.
        assert_eq!(out.candidates[0].target_id, " Raw ID ");
        assert_eq!(out.candidates[0].output_values, [" Raw Output "]);
        assert_eq!(out.proposals[0].map_key, req.source_rows[0].map_key);

        // A value differing only by raw case is an exact normalized equality
        // because hard equality applies the same normalize() to both sides.
        let mut req2 = request("  EUROPE ", "EUROPE");
        req2.plan.normalization = vec!["trim".into(), "casefold".into()];
        let out2 = matching_retrieve(req2).unwrap();
        assert_eq!(evidence(&out2)[0].score, Some(1.0));

        // A genuinely different hard value is still dropped — casefold never
        // relaxes a hard constraint (region is the hard comparison here).
        let mut req3 = request("  EUROPE ", "america");
        req3.plan.normalization = vec!["trim".into(), "casefold".into()];
        let out3 = matching_retrieve(req3).unwrap();
        assert!(evidence(&out3).is_empty());
        assert_eq!(out3.proposals[0].state, MatchingProposalState::NoCandidates);
    }

    #[test]
    fn unsupported_normalization_refuses_even_an_empty_run() {
        for op in ["unaccent", "trim_lower", "LOWER", "", "lower(name)"] {
            let mut req = request("Europe", "Europe");
            req.plan.normalization = vec!["trim".into(), op.into()];
            req.source_rows.clear();
            req.target_rows.clear();
            let error = matching_retrieve(req).unwrap_err();
            assert!(error.contains("unsupported normalization"), "{error}");
        }
    }

    #[test]
    fn missing_comparison_fields_refuse_instead_of_becoming_empty() {
        for role in [
            MatchingFieldRole::HardConstraint,
            MatchingFieldRole::SoftSignal,
            MatchingFieldRole::ReferenceContext,
        ] {
            for source in [false, true] {
                let mut req = request("Europe", "Europe");
                req.plan.comparisons[1].role = role;
                if source {
                    req.source_rows[0].fields.remove("region");
                } else {
                    req.target_rows[0].fields.remove("region");
                }
                let error = matching_retrieve(req).unwrap_err();
                assert!(
                    error.contains(if source {
                        "missing source"
                    } else {
                        "missing target"
                    }),
                    "{error}"
                );
            }
        }
    }

    #[test]
    fn reference_context_neither_rescues_nor_dilutes_soft_score() {
        for reference_matches in [false, true] {
            let mut req = request("Europe", if reference_matches { "Europe" } else { "Asia" });
            req.plan.comparisons[1].role = MatchingFieldRole::ReferenceContext;
            let out = matching_retrieve(req.clone()).unwrap();
            assert_eq!(evidence(&out)[0].score, Some(1.0));
            assert_eq!(evidence(&out)[0].field_scores, [Some(1.0), None]);
            req.target_rows[0]
                .fields
                .insert("name".into(), "Globex".into());
            assert!(evidence(&matching_retrieve(req.clone()).unwrap()).is_empty());
            req.allow_expand = true;
            let out = matching_retrieve(req).unwrap();
            assert_eq!(evidence(&out)[0].score, Some(0.0));
            assert!(out.proposals[0].search_incomplete);
            assert_eq!(out.proposals[0].state, MatchingProposalState::Ambiguous);
        }
    }

    #[test]
    fn expansion_relaxes_soft_cutoff_but_never_any_hard_constraint() {
        let mut req = request("Europe", "Europe");
        req.allow_expand = true;
        req.target_rows[0]
            .fields
            .insert("name".into(), "Globex".into());
        let mut forbidden = req.target_rows[0].clone();
        forbidden.target_id = "forbidden".into();
        forbidden
            .fields
            .insert("region".into(), "Europe West".into());
        forbidden.fields.insert("name".into(), "Acme".into());
        req.target_rows.push(forbidden);
        let out = matching_retrieve(req).unwrap();
        assert_eq!(evidence(&out).len(), 1);
        assert_eq!(evidence(&out)[0].candidate_id, "cand: Raw ID ");
        assert_eq!(evidence(&out)[0].score, Some(0.0));
        assert_eq!(
            out.llm_candidate_ids_by_proposal[&out.proposals[0].proposal_id],
            ["cand: Raw ID "]
        );
    }

    #[test]
    fn no_soft_signals_remain_unscored_not_invented_confidence() {
        for role in [
            MatchingFieldRole::HardConstraint,
            MatchingFieldRole::ReferenceContext,
        ] {
            let mut req = request("Europe", "Europe");
            req.plan.comparisons[0].role = role;
            let out = matching_retrieve(req).unwrap();
            assert_eq!(evidence(&out)[0].score, None);
            assert_eq!(evidence(&out)[0].field_scores, [None, None]);
            assert_eq!(out.proposals[0].state, MatchingProposalState::Ambiguous);
        }
    }

    #[test]
    fn evidence_is_per_source_mean_of_ordered_soft_fields() {
        let mut req = request("Europe", "Europe");
        req.plan.comparisons.insert(
            0,
            MatchingPlanComparison {
                source_field: "context".into(),
                target_field: "context".into(),
                role: MatchingFieldRole::ReferenceContext,
            },
        );
        req.plan.comparisons.push(MatchingPlanComparison {
            source_field: "label".into(),
            target_field: "label".into(),
            role: MatchingFieldRole::SoftSignal,
        });
        req.source_rows[0]
            .fields
            .insert("context".into(), "unrelated".into());
        req.source_rows[0]
            .fields
            .insert("label".into(), "Widgets".into());
        req.target_rows[0]
            .fields
            .insert("context".into(), "context".into());
        req.target_rows[0]
            .fields
            .insert("label".into(), "Widgets West".into());
        let mut second = req.source_rows[0].clone();
        second.map_key[0] = "second".into();
        second.fields.insert("provider".into(), "Acme West".into());
        req.source_rows.push(second);
        let out = matching_retrieve(req).unwrap();
        let first = &evidence(&out)[0];
        let second = &out.candidate_scores_by_proposal[&out.proposals[1].proposal_id][0];
        assert_eq!(first.field_scores, [None, Some(1.0), None, Some(0.85)]);
        assert_eq!(first.score, Some((1.0 + 0.85) / 2.0));
        assert_eq!(second.field_scores, [None, Some(0.85), None, Some(0.85)]);
        assert_eq!(second.score, Some(0.85));
        assert_eq!(first.candidate_id, second.candidate_id);
        assert_eq!(out.metrics.llm_calls, 0);
        assert_eq!(out.metrics.candidates_scored, 2);
        let json = serde_json::to_value(&out).unwrap();
        let wire = &json["candidateScoresByProposal"][&out.proposals[0].proposal_id][0];
        assert_eq!(wire["candidateId"], first.candidate_id);
        assert!(wire["fieldScores"][0].is_null());
        // Old producers remain deserializable; absence means unknown evidence.
        let mut old = json;
        old.as_object_mut()
            .unwrap()
            .remove("candidateScoresByProposal");
        let old: MatchingRetrieveResult = serde_json::from_value(old).unwrap();
        assert!(old.candidate_scores_by_proposal.is_empty());
    }

    #[test]
    fn shortlist_truncation_is_honest_and_evidence_stays_bounded() {
        let mut req = request("Europe", "Europe");
        req.target_rows = (0..RETRIEVAL_SHORTLIST_PER_KEY + 1)
            .map(|i| {
                let mut row = req.target_rows[0].clone();
                row.target_id = i.to_string();
                row
            })
            .collect();
        let out = matching_retrieve(req).unwrap();
        assert!(out.proposals[0].search_incomplete);
        assert_eq!(evidence(&out).len(), RETRIEVAL_SHORTLIST_PER_KEY);
        assert_eq!(
            out.proposals[0].alternative_candidate_ids.len(),
            RETRIEVAL_SHORTLIST_PER_KEY - 1
        );
        assert_eq!(
            out.llm_candidate_ids_by_proposal[&out.proposals[0].proposal_id].len(),
            LLM_CANDIDATES_PER_KEY
        );
    }

    #[test]
    fn soft_normalization_uses_plan_not_implicit_trim_lower() {
        let mut req = request("Europe", "Europe");
        req.target_rows[0]
            .fields
            .insert("name".into(), "ACME".into());
        assert!(evidence(&matching_retrieve(req.clone()).unwrap()).is_empty());
        req.plan.normalization = vec!["lower".into()];
        let out = matching_retrieve(req.clone()).unwrap();
        assert_eq!(evidence(&out)[0].score, Some(1.0));
        req.target_rows[0]
            .fields
            .insert("name".into(), " ACME ".into());
        let out = matching_retrieve(req.clone()).unwrap();
        // The existing business-core heuristic collapses whitespace at 0.95,
        // but only explicit trim can produce exact normalized equality (1.0).
        assert_eq!(evidence(&out)[0].score, Some(0.95));
        req.plan.normalization.insert(0, "trim".into());
        let out = matching_retrieve(req).unwrap();
        assert_eq!(evidence(&out)[0].score, Some(1.0));
    }

    #[test]
    fn every_hard_constraint_must_hold_even_during_expansion() {
        let mut req = request("Europe", "Europe");
        req.allow_expand = true;
        req.plan.comparisons[0].role = MatchingFieldRole::HardConstraint;
        req.target_rows[0]
            .fields
            .insert("name".into(), "Acme West".into());
        let out = matching_retrieve(req).unwrap();
        assert!(evidence(&out).is_empty());
        assert_eq!(out.proposals[0].state, MatchingProposalState::NoCandidates);
    }

    #[test]
    fn returned_score_order_matches_proposed_candidate_and_alternatives() {
        let mut req = request("Europe", "Europe");
        let mut best = req.target_rows[0].clone();
        best.target_id = "best".into();
        req.target_rows[0]
            .fields
            .insert("name".into(), "Acme West".into());
        req.target_rows.push(best);
        let out = matching_retrieve(req).unwrap();
        assert_eq!(evidence(&out)[0].candidate_id, "cand:best");
        assert_eq!(evidence(&out)[0].score, Some(1.0));
        assert_eq!(evidence(&out)[1].score, Some(0.85));
        assert_eq!(
            out.proposals[0].proposed_candidate_id.as_deref(),
            Some("cand:best")
        );
        assert_eq!(
            out.proposals[0].alternative_candidate_ids,
            ["cand: Raw ID "]
        );
    }
}
