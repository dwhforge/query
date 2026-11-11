//! Matching host gates (ADR-0044). Renderer sends ids + revisions; host validates.

use crate::error::{HostError, RpcError};
use dwh_engine::{
    accept_draft_decision, commit_blocked_reason, gate_commit_write_policy, matching_retrieve,
    plan_bulk_confirm, validate_llm_intake, LlmIntakeRequest, MatchingCandidate, MatchingDecision,
    MatchingMapRowSnapshot, MatchingMergeItem, MatchingMergeOutcome, MatchingPlan,
    MatchingProposal, MatchingRetrieveRequest, MatchingValidateError, MaterializedDecision,
    LLM_CANDIDATES_PER_KEY, LLM_RETRIES_PER_REQUEST, LOCAL_TARGET_UNIVERSE_ROWS,
    MASS_RUN_UNIQUE_KEYS, MAX_LLM_CALLS_PER_RUN, PARALLEL_LLM_REQUESTS, RETRIEVAL_SHORTLIST_PER_KEY,
    TRIAL_UNIQUE_KEYS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

fn map_err(e: MatchingValidateError) -> RpcError {
    HostError::validation(format!("{}: {}", e.code(), e.message())).into()
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchingCapsDto {
    pub trial_unique_keys: u32,
    pub mass_run_unique_keys: u32,
    pub retrieval_shortlist_per_key: u32,
    pub llm_candidates_per_key: u32,
    pub local_target_universe_rows: u32,
    pub parallel_llm_requests: u32,
    pub llm_retries_per_request: u32,
    pub max_llm_calls_per_run: u32,
}

pub fn matching_retrieve_cmd(args: MatchingRetrieveRequest) -> Result<Value, RpcError> {
    let out = matching_retrieve(args).map_err(|e| RpcError::from(HostError::validation(e)))?;
    serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
}

pub fn matching_caps() -> Result<Value, RpcError> {
    let dto = MatchingCapsDto {
        trial_unique_keys: TRIAL_UNIQUE_KEYS as u32,
        mass_run_unique_keys: MASS_RUN_UNIQUE_KEYS as u32,
        retrieval_shortlist_per_key: RETRIEVAL_SHORTLIST_PER_KEY as u32,
        llm_candidates_per_key: LLM_CANDIDATES_PER_KEY as u32,
        local_target_universe_rows: LOCAL_TARGET_UNIVERSE_ROWS as u32,
        parallel_llm_requests: PARALLEL_LLM_REQUESTS as u32,
        llm_retries_per_request: LLM_RETRIES_PER_REQUEST as u32,
        max_llm_calls_per_run: MAX_LLM_CALLS_PER_RUN as u32,
    };
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingLlmIntakeArgs {
    pub session_id: String,
    pub plan: MatchingPlan,
    pub candidates: Vec<MatchingCandidate>,
    pub allowlist_target_ids: Vec<String>,
    pub request: LlmIntakeRequest,
}

pub fn matching_validate_llm_intake(args: MatchingLlmIntakeArgs) -> Result<Value, RpcError> {
    let reg: HashMap<_, _> = args
        .candidates
        .into_iter()
        .map(|c| (c.candidate_id.clone(), c))
        .collect();
    let allow: HashSet<_> = args.allowlist_target_ids.into_iter().collect();
    let cand = validate_llm_intake(
        &args.plan,
        &args.session_id,
        &reg,
        &allow,
        &args.request,
    )
    .map_err(map_err)?;
    serde_json::to_value(cand).map_err(|e| RpcError::from(e.to_string()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingDraftAcceptArgs {
    pub session_id: String,
    pub plan: MatchingPlan,
    pub proposals: Vec<MatchingProposal>,
    pub candidates: Vec<MatchingCandidate>,
    pub decision: MatchingDecision,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingDraftAcceptResult {
    pub accepted: bool,
    pub materialized: Option<MaterializedDecision>,
}

pub fn matching_accept_draft(args: MatchingDraftAcceptArgs) -> Result<Value, RpcError> {
    let proposals: HashMap<_, _> = args
        .proposals
        .into_iter()
        .map(|p| (p.proposal_id.clone(), p))
        .collect();
    let reg: HashMap<_, _> = args
        .candidates
        .into_iter()
        .map(|c| (c.candidate_id.clone(), c))
        .collect();
    let mat = accept_draft_decision(
        &args.plan,
        &args.session_id,
        &proposals,
        &reg,
        &args.decision,
    )
    .map_err(map_err)?;
    let dto = MatchingDraftAcceptResult {
        accepted: true,
        materialized: mat,
    };
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingPlanCommitArgs {
    pub decisions: Vec<MaterializedDecision>,
    pub baseline: Vec<MatchingMapRowSnapshot>,
    pub live: Vec<MatchingMapRowSnapshot>,
    #[serde(default)]
    pub explicit_replace_keys: Vec<Vec<String>>,
    pub write_allowed: bool,
    #[serde(default)]
    pub write_refusal_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingPlanCommitResult {
    pub ok: bool,
    pub blocked_reason: Option<String>,
    pub items: Vec<MatchingMergeItemDto>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchingMergeItemDto {
    pub map_key: Vec<String>,
    pub outcome: MatchingMergeOutcome,
    pub affected_source_rows: u32,
    pub proposed_outputs: Option<Vec<String>>,
    pub live_outputs: Option<Vec<String>>,
}

impl From<&MatchingMergeItem> for MatchingMergeItemDto {
    fn from(i: &MatchingMergeItem) -> Self {
        Self {
            map_key: i.map_key.clone(),
            outcome: i.outcome,
            affected_source_rows: i.affected_source_rows,
            proposed_outputs: i.proposed_outputs.clone(),
            live_outputs: i.live_outputs.clone(),
        }
    }
}

/// Plan a Matching commit: merge classify + write-policy gate.
/// On conflict/stale/needs-replace in the set → ok=false, no implied partial Save.
pub fn matching_plan_commit(args: MatchingPlanCommitArgs) -> Result<Value, RpcError> {
    gate_commit_write_policy(args.write_allowed, args.write_refusal_reason.as_deref())
        .map_err(map_err)?;
    let baseline: HashMap<_, _> = args
        .baseline
        .into_iter()
        .map(|r| (r.key_token(), r))
        .collect();
    let live: HashMap<_, _> = args.live.into_iter().map(|r| (r.key_token(), r)).collect();
    let explicit: HashSet<_> = args
        .explicit_replace_keys
        .into_iter()
        .map(|k| dwh_engine::map_key_token(&k))
        .collect();
    let items = plan_bulk_confirm(&args.decisions, &baseline, &live, &explicit);
    let blocked = commit_blocked_reason(&items).map(|s| s.to_string());
    let dto = MatchingPlanCommitResult {
        ok: blocked.is_none(),
        blocked_reason: blocked,
        items: items.iter().map(MatchingMergeItemDto::from).collect(),
    };
    serde_json::to_value(dto).map_err(|e| RpcError::from(e.to_string()))
}

#[cfg(test)]
mod forged_host_tests {
    use super::*;
    use dwh_engine::{
        MatchingAmbiguityPolicy, MatchingDecisionKind, MatchingFieldRole, MatchingPlanComparison,
        MatchingProposalState, MatchingProvenance, MatchingScopeKind,
    };

    fn plan() -> MatchingPlan {
        MatchingPlan {
            source_ref: "Client".into(),
            target_ref: "A".into(),
            map_key_fields: vec!["provider".into(), "region".into()],
            target_identity_fields: vec!["id".into()],
            comparisons: vec![MatchingPlanComparison {
                source_field: "provider".into(),
                target_field: "name".into(),
                role: MatchingFieldRole::SoftSignal,
            }],
            normalization: vec![],
            outputs: vec!["id".into()],
            ambiguity: MatchingAmbiguityPolicy::LeaveForManual,
            scope: MatchingScopeKind::Selected,
            semantic_revision: 1,
            ui_revision: 0,
        }
    }

    #[test]
    fn host_rejects_unknown_target() {
        let err = matching_validate_llm_intake(MatchingLlmIntakeArgs {
            session_id: "s1".into(),
            plan: plan(),
            candidates: vec![MatchingCandidate {
                candidate_id: "c1".into(),
                session_id: "s1".into(),
                target_id: "1".into(),
                output_values: vec!["1".into()],
                evidence_revision: 1,
            }],
            allowlist_target_ids: vec!["1".into()],
            request: LlmIntakeRequest {
                session_id: "s1".into(),
                semantic_plan_revision: 1,
                map_key: vec!["a1".into(), "Eurpope".into()],
                target_id: "999".into(),
                claimed_output_values: vec![],
            },
        })
        .expect_err("unknown target");
        assert!(err.message().contains("target_not_in_allowlist"), "{}", err.message());
    }

    #[test]
    fn host_rejects_other_session_on_draft() {
        let err = matching_accept_draft(MatchingDraftAcceptArgs {
            session_id: "s1".into(),
            plan: plan(),
            proposals: vec![MatchingProposal {
                proposal_id: "p1".into(),
                session_id: "s1".into(),
                map_key: vec!["a1".into(), "Europe".into()],
                affected_source_rows: 1,
                proposed_candidate_id: Some("c1".into()),
                alternative_candidate_ids: vec![],
                state: MatchingProposalState::Proposed,
                provenance: MatchingProvenance::Llm,
                semantic_plan_revision: 1,
                evidence_revision: 1,
                search_incomplete: false,
            }],
            candidates: vec![MatchingCandidate {
                candidate_id: "c1".into(),
                session_id: "other".into(),
                target_id: "1".into(),
                output_values: vec!["1".into()],
                evidence_revision: 1,
            }],
            decision: MatchingDecision {
                map_key: vec!["a1".into(), "Europe".into()],
                kind: MatchingDecisionKind::ConfirmProposed,
                candidate_id: Some("c1".into()),
                proposal_id: "p1".into(),
                expected_semantic_revision: 1,
            },
        })
        .expect_err("session");
        assert!(
            err.message().contains("candidate_session_mismatch"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn host_rejects_readonly_commit() {
        let err = matching_plan_commit(MatchingPlanCommitArgs {
            decisions: vec![],
            baseline: vec![],
            live: vec![],
            explicit_replace_keys: vec![],
            write_allowed: false,
            write_refusal_reason: Some("import write-back is not allowed".into()),
        })
        .expect_err("ro");
        assert!(err.message().contains("write_policy_refused"), "{}", err.message());
    }

    #[test]
    fn host_commit_stops_on_stale_without_partial_ok() {
        let live = MatchingMapRowSnapshot {
            from_parts: vec!["k".into()],
            output_values: vec!["concurrent".into()],
        };
        let baseline = MatchingMapRowSnapshot {
            from_parts: vec!["k".into()],
            output_values: vec!["1".into()],
        };
        let out = matching_plan_commit(MatchingPlanCommitArgs {
            decisions: vec![MaterializedDecision {
                map_key: vec!["k".into()],
                candidate_id: "c".into(),
                target_id: "2".into(),
                output_values: vec!["2".into()],
                proposal_id: "p".into(),
                affected_source_rows: 1,
            }],
            baseline: vec![baseline],
            live: vec![live],
            explicit_replace_keys: vec![],
            write_allowed: true,
            write_refusal_reason: None,
        })
        .expect("rpc ok");
        assert_eq!(out["ok"], false);
        assert_eq!(out["blockedReason"], "stale_baseline");
    }

    #[test]
    fn caps_rpc_exposes_shared_constants() {
        let v = matching_caps().unwrap();
        assert_eq!(v["massRunUniqueKeys"], 200);
        assert_eq!(v["retrievalShortlistPerKey"], 40);
        assert_eq!(v["llmCandidatesPerKey"], 10);
    }
}
