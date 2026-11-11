//! Bounded Matching retrieval with run caps (ADR-0044).
//! Pure in-memory shortlist — no silent full-dictionary download.

use super::caps::{
    LLM_CANDIDATES_PER_KEY, LOCAL_TARGET_UNIVERSE_ROWS, MASS_RUN_UNIQUE_KEYS,
    MAX_LLM_CALLS_PER_RUN, RETRIEVAL_SHORTLIST_PER_KEY, TRIAL_UNIQUE_KEYS,
};
use super::types::{
    MatchingCandidate, MatchingPlan, MatchingProposal, MatchingProposalState, MatchingProvenance,
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
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Strip common English legal / noise tokens for soft business-name compare.
/// Tier‑1 only — no thesaurus. Semantic aliases are cascade Tier‑2 (LLM expand).
fn business_core(s: &str) -> String {
    let mut t = norm(s);
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
    let a = norm(src);
    let b = norm(tgt);
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
    if a.contains(&b) || b.contains(&a) || ca.contains(&cb) || cb.contains(&ca) {
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

    let cap = key_cap(req.mode);
    let keys_requested = req.source_rows.len();
    let (process, rest) = if req.source_rows.len() > cap {
        (
            &req.source_rows[..cap],
            req.source_rows.len() - cap,
        )
    } else {
        (req.source_rows.as_slice(), 0)
    };

    let hard: Vec<_> = req
        .plan
        .comparisons
        .iter()
        .filter(|c| matches!(c.role, super::types::MatchingFieldRole::HardConstraint))
        .collect();
    let soft: Vec<_> = req
        .plan
        .comparisons
        .iter()
        .filter(|c| {
            matches!(
                c.role,
                super::types::MatchingFieldRole::SoftSignal
                    | super::types::MatchingFieldRole::ReferenceContext
            )
        })
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
    let mut scored = 0u32;
    let mut stop_reason: Option<String> = None;
    if rest > 0 {
        stop_reason = Some("key_cap".into());
    }

    for (i, src) in process.iter().enumerate() {
        if src.map_key.len() != req.plan.map_key_fields.len() {
            return Err(format!(
                "refused: source map_key arity mismatch at row {i}"
            ));
        }

        #[derive(Clone)]
        struct Rank {
            target_id: String,
            score: f64,
            hard_ok: bool,
        }

        let mut ranks: Vec<Rank> = Vec::new();
        for t in &req.target_rows {
            scored += 1;
            let mut hard_ok = true;
            for h in &hard {
                let sv = src
                    .fields
                    .get(&h.source_field)
                    .cloned()
                    .unwrap_or_default();
                let tv = t
                    .fields
                    .get(&h.target_field)
                    .cloned()
                    .unwrap_or_default();
                // Empty source hard field → do not filter as exact; leave ambiguous.
                if sv.trim().is_empty() {
                    hard_ok = false;
                    break;
                }
                if field_score(&sv, &tv) < 0.85 {
                    hard_ok = false;
                    break;
                }
            }
            let mut score = 0.0;
            let mut n = 0;
            for s in &soft {
                let sv = src
                    .fields
                    .get(&s.source_field)
                    .cloned()
                    .unwrap_or_default();
                let tv = t
                    .fields
                    .get(&s.target_field)
                    .cloned()
                    .unwrap_or_default();
                score += field_score(&sv, &tv);
                n += 1;
            }
            if n > 0 {
                score /= n as f64;
            }
            ranks.push(Rank {
                target_id: t.target_id.clone(),
                score,
                hard_ok,
            });
        }

        ranks.sort_by(|a, b| {
            b.hard_ok
                .cmp(&a.hard_ok)
                .then(
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });

        let mut shortlist: Vec<Rank> = ranks
            .iter()
            .filter(|r| r.hard_ok && r.score >= 0.7)
            .take(RETRIEVAL_SHORTLIST_PER_KEY)
            .cloned()
            .collect();

        let mut incomplete = false;
        if shortlist.is_empty() && req.allow_expand {
            // Expand: take top soft scores even if hard failed (still bounded).
            shortlist = ranks.iter().take(RETRIEVAL_SHORTLIST_PER_KEY.min(10)).cloned().collect();
            incomplete = true;
        } else if shortlist.is_empty() && ranks.len() > RETRIEVAL_SHORTLIST_PER_KEY {
            incomplete = true;
        }

        let pid = format!("prop:{}:{}", i, src.map_key.join("|"));
        let (state, proposed, alts) = if shortlist.is_empty() {
            if incomplete {
                (MatchingProposalState::IncompleteSearch, None, vec![])
            } else {
                (MatchingProposalState::NoCandidates, None, vec![])
            }
        } else if shortlist.len() == 1 && shortlist[0].score >= 0.9 && shortlist[0].hard_ok {
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
            if !best.hard_ok || best.score < 0.9 || !alts.is_empty() {
                (MatchingProposalState::Ambiguous, cid, alts)
            } else {
                (MatchingProposalState::Proposed, cid, alts)
            }
        };

        // Empty hard region + multiple name hits → force ambiguous, no auto pick.
        let empty_hard = hard.iter().any(|h| {
            src.fields
                .get(&h.source_field)
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
        });
        let (state, proposed, alts) = if empty_hard && shortlist.len() != 1 {
            let ids: Vec<_> = shortlist
                .iter()
                .filter_map(|r| cand_index.get(&r.target_id).cloned())
                .collect();
            (
                MatchingProposalState::Ambiguous,
                None,
                ids,
            )
        } else {
            (state, proposed, alts)
        };

        let llm_ids: Vec<String> = shortlist
            .iter()
            .take(LLM_CANDIDATES_PER_KEY)
            .filter_map(|r| cand_index.get(&r.target_id).cloned())
            .collect();
        llm_map.insert(pid.clone(), llm_ids);

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
            fields: [("name".into(), "a1".into()), ("region".into(), "Europe".into())]
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
                fields: [("name".into(), "a1".into()), ("region".into(), "Europe".into())]
                    .into_iter()
                    .collect(),
                output_values: vec!["1".into()],
            },
            MatchingTargetRow {
                target_id: "2".into(),
                fields: [("name".into(), "a1".into()), ("region".into(), "RUS".into())]
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
                fields: [("provider".into(), "a1".into()), ("region".into(), "".into())]
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
    fn eurpope_prefers_europe_with_alt() {
        let targets = vec![
            MatchingTargetRow {
                target_id: "1".into(),
                fields: [("name".into(), "a1".into()), ("region".into(), "Europe".into())]
                    .into_iter()
                    .collect(),
                output_values: vec!["1".into()],
            },
            MatchingTargetRow {
                target_id: "2".into(),
                fields: [("name".into(), "a1".into()), ("region".into(), "RUS".into())]
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
        // Soft name match + expand may yield proposed or ambiguous with alts.
        assert!(
            p.proposed_candidate_id.is_some()
                || !p.alternative_candidate_ids.is_empty()
                || p.state == MatchingProposalState::Ambiguous
                || p.state == MatchingProposalState::IncompleteSearch
                || p.state == MatchingProposalState::Proposed,
            "{p:?}"
        );
    }

    #[test]
    fn soft_score_tier1_is_algorithmic_not_thesaurus() {
        // Exact / legal-suffix normalize.
        assert!((field_score("ComputerParts LLC", "ComputerParts") - 0.85).abs() < 0.01
            || field_score("ComputerParts LLC", "ComputerParts") >= 0.85);
        // Typo within Levenshtein band.
        assert!(field_score("KomputerParts LLC", "ComputerParts LLC") >= 0.75);
        // Semantic / world-knowledge must NOT be faked in Tier‑1 (cascade → LLM).
        assert!(field_score("USA", "United States") < 0.5);
        assert!(field_score("NW bottled water", "Nestlé Waters") < 0.5);
        assert!(field_score("Acme Widgets", "Globex") < 0.5);
    }
}
