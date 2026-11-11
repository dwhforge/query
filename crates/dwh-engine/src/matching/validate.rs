//! Host-side Matching validation (ADR-0044 trust boundary).
//!
//! Renderer may send proposal/candidate ids + expected revisions.
//! This module rejects forged / stale / cross-session payloads and materializes
//! outputs only from registered candidates.

use super::types::{
    MatchingCandidate, MatchingDecision, MatchingDecisionKind, MatchingPlan, MatchingProposal,
    MatchingProposalState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchingValidateError {
    SessionMismatch,
    UnknownProposal,
    UnknownCandidate,
    CandidateSessionMismatch,
    TargetNotInAllowlist,
    StaleSemanticRevision,
    StaleEvidence,
    IncompleteMapKey,
    OutputArityMismatch,
    OutputsNotFromSingleCandidate,
    DecisionRequiresCandidate,
    ProposalNotSelectable,
    WritePolicyRefused(String),
}

impl MatchingValidateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SessionMismatch => "session_mismatch",
            Self::UnknownProposal => "unknown_proposal",
            Self::UnknownCandidate => "unknown_candidate",
            Self::CandidateSessionMismatch => "candidate_session_mismatch",
            Self::TargetNotInAllowlist => "target_not_in_allowlist",
            Self::StaleSemanticRevision => "stale_semantic_revision",
            Self::StaleEvidence => "stale_evidence",
            Self::IncompleteMapKey => "incomplete_map_key",
            Self::OutputArityMismatch => "output_arity_mismatch",
            Self::OutputsNotFromSingleCandidate => "outputs_not_from_single_candidate",
            Self::DecisionRequiresCandidate => "decision_requires_candidate",
            Self::ProposalNotSelectable => "proposal_not_selectable",
            Self::WritePolicyRefused(_) => "write_policy_refused",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::WritePolicyRefused(r) => r.clone(),
            other => other.code().replace('_', " "),
        }
    }
}

/// LLM / retrieval intake: register only if target_id is in the allowlist and
/// outputs match the registered candidate row (or are omitted for host fill).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmIntakeRequest {
    pub session_id: String,
    pub semantic_plan_revision: u64,
    pub map_key: Vec<String>,
    pub target_id: String,
    /// Untrusted if present — must equal registered candidate outputs or be empty.
    #[serde(default)]
    pub claimed_output_values: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedDecision {
    pub map_key: Vec<String>,
    pub candidate_id: String,
    pub target_id: String,
    pub output_values: Vec<String>,
    pub proposal_id: String,
    pub affected_source_rows: u32,
}

fn require_complete_key(plan: &MatchingPlan, map_key: &[String]) -> Result<(), MatchingValidateError> {
    if map_key.len() != plan.map_key_fields.len() {
        return Err(MatchingValidateError::IncompleteMapKey);
    }
    // Significant blanks: empty string parts are allowed and must not be dropped.
    // Incomplete means wrong arity only.
    Ok(())
}

fn candidate_by_id<'a>(
    registry: &'a HashMap<String, MatchingCandidate>,
    candidate_id: &str,
) -> Result<&'a MatchingCandidate, MatchingValidateError> {
    registry
        .get(candidate_id)
        .ok_or(MatchingValidateError::UnknownCandidate)
}

/// Validate LLM/manual intake against plan + registered candidates by target_id.
pub fn validate_llm_intake(
    plan: &MatchingPlan,
    session_id: &str,
    registry: &HashMap<String, MatchingCandidate>,
    allowlist_target_ids: &std::collections::HashSet<String>,
    req: &LlmIntakeRequest,
) -> Result<MatchingCandidate, MatchingValidateError> {
    if req.session_id != session_id {
        return Err(MatchingValidateError::SessionMismatch);
    }
    if req.semantic_plan_revision != plan.semantic_revision {
        return Err(MatchingValidateError::StaleSemanticRevision);
    }
    require_complete_key(plan, &req.map_key)?;
    if !allowlist_target_ids.contains(&req.target_id) {
        return Err(MatchingValidateError::TargetNotInAllowlist);
    }
    let cand = registry
        .values()
        .find(|c| c.session_id == session_id && c.target_id == req.target_id)
        .ok_or(MatchingValidateError::UnknownCandidate)?;
    if cand.session_id != session_id {
        return Err(MatchingValidateError::CandidateSessionMismatch);
    }
    if cand.output_values.len() != plan.outputs.len() {
        return Err(MatchingValidateError::OutputArityMismatch);
    }
    if !req.claimed_output_values.is_empty() && req.claimed_output_values != cand.output_values {
        return Err(MatchingValidateError::OutputsNotFromSingleCandidate);
    }
    Ok(cand.clone())
}

/// Draft accept: renderer sends proposal_id + optional candidate_id + revisions.
pub fn accept_draft_decision(
    plan: &MatchingPlan,
    session_id: &str,
    proposals: &HashMap<String, MatchingProposal>,
    registry: &HashMap<String, MatchingCandidate>,
    decision: &MatchingDecision,
) -> Result<Option<MaterializedDecision>, MatchingValidateError> {
    if decision.expected_semantic_revision != plan.semantic_revision {
        return Err(MatchingValidateError::StaleSemanticRevision);
    }
    let proposal = proposals
        .get(&decision.proposal_id)
        .ok_or(MatchingValidateError::UnknownProposal)?;
    if proposal.session_id != session_id {
        return Err(MatchingValidateError::SessionMismatch);
    }
    if proposal.semantic_plan_revision != plan.semantic_revision {
        return Err(MatchingValidateError::StaleSemanticRevision);
    }
    require_complete_key(plan, &decision.map_key)?;
    if proposal.map_key != decision.map_key {
        return Err(MatchingValidateError::IncompleteMapKey);
    }
    match decision.kind {
        MatchingDecisionKind::Defer | MatchingDecisionKind::Reject | MatchingDecisionKind::NoSuitableTarget => {
            Ok(None)
        }
        MatchingDecisionKind::ConfirmProposed | MatchingDecisionKind::ChooseAlternative => {
            let cid = decision
                .candidate_id
                .as_deref()
                .ok_or(MatchingValidateError::DecisionRequiresCandidate)?;
            let cand = candidate_by_id(registry, cid)?;
            if cand.session_id != session_id {
                return Err(MatchingValidateError::CandidateSessionMismatch);
            }
            // Candidate must be proposed or listed alternative (or ConfirmProposed's id).
            let allowed = proposal.proposed_candidate_id.as_deref() == Some(cid)
                || proposal.alternative_candidate_ids.iter().any(|a| a == cid);
            if !allowed {
                return Err(MatchingValidateError::TargetNotInAllowlist);
            }
            if cand.evidence_revision != proposal.evidence_revision
                && decision.kind == MatchingDecisionKind::ConfirmProposed
            {
                // Confirming proposed uses proposal evidence stamp.
                if proposal.state == MatchingProposalState::Stale {
                    return Err(MatchingValidateError::StaleEvidence);
                }
            }
            if proposal.state == MatchingProposalState::Stale {
                return Err(MatchingValidateError::StaleEvidence);
            }
            if matches!(
                proposal.state,
                MatchingProposalState::Rejected | MatchingProposalState::Saved
            ) {
                return Err(MatchingValidateError::ProposalNotSelectable);
            }
            if cand.output_values.len() != plan.outputs.len() {
                return Err(MatchingValidateError::OutputArityMismatch);
            }
            Ok(Some(MaterializedDecision {
                map_key: decision.map_key.clone(),
                candidate_id: cand.candidate_id.clone(),
                target_id: cand.target_id.clone(),
                output_values: cand.output_values.clone(),
                proposal_id: proposal.proposal_id.clone(),
                affected_source_rows: proposal.affected_source_rows,
            }))
        }
    }
}

/// Final commit gate: write policy + re-check materialization.
pub fn gate_commit_write_policy(
    write_allowed: bool,
    refusal_reason: Option<&str>,
) -> Result<(), MatchingValidateError> {
    if write_allowed {
        Ok(())
    } else {
        Err(MatchingValidateError::WritePolicyRefused(
            refusal_reason
                .unwrap_or("import write-back is not allowed for this relation")
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod forged_payload_tests {
    use super::*;
    use crate::matching::types::{
        MatchingAmbiguityPolicy, MatchingFieldRole, MatchingPlanComparison, MatchingProvenance,
        MatchingScopeKind,
    };
    use std::collections::HashSet;

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
            semantic_revision: 3,
            ui_revision: 1,
        }
    }

    fn cand(session: &str, id: &str, target: &str, out: &str) -> MatchingCandidate {
        MatchingCandidate {
            candidate_id: id.into(),
            session_id: session.into(),
            target_id: target.into(),
            output_values: vec![out.into()],
            evidence_revision: 1,
        }
    }

    fn registry(cands: Vec<MatchingCandidate>) -> HashMap<String, MatchingCandidate> {
        cands.into_iter().map(|c| (c.candidate_id.clone(), c)).collect()
    }

    #[test]
    fn rejects_unknown_target_id_on_llm_intake() {
        let p = plan();
        let reg = registry(vec![cand("s1", "c1", "1", "1")]);
        let allow: HashSet<String> = ["1".into()].into_iter().collect();
        let err = validate_llm_intake(
            &p,
            "s1",
            &reg,
            &allow,
            &LlmIntakeRequest {
                session_id: "s1".into(),
                semantic_plan_revision: 3,
                map_key: vec!["a1".into(), "Eurpope".into()],
                target_id: "999".into(),
                claimed_output_values: vec![],
            },
        )
        .unwrap_err();
        assert_eq!(err, MatchingValidateError::TargetNotInAllowlist);
    }

    #[test]
    fn rejects_other_session_candidate_on_draft() {
        let p = plan();
        let reg = registry(vec![cand("other", "c1", "1", "1")]);
        let mut proposals = HashMap::new();
        proposals.insert(
            "p1".into(),
            MatchingProposal {
                proposal_id: "p1".into(),
                session_id: "s1".into(),
                map_key: vec!["a1".into(), "Europe".into()],
                affected_source_rows: 1,
                proposed_candidate_id: Some("c1".into()),
                alternative_candidate_ids: vec![],
                state: MatchingProposalState::Proposed,
                provenance: MatchingProvenance::Llm,
                semantic_plan_revision: 3,
                evidence_revision: 1,
                search_incomplete: false,
            },
        );
        let err = accept_draft_decision(
            &p,
            "s1",
            &proposals,
            &reg,
            &MatchingDecision {
                map_key: vec!["a1".into(), "Europe".into()],
                kind: MatchingDecisionKind::ConfirmProposed,
                candidate_id: Some("c1".into()),
                proposal_id: "p1".into(),
                expected_semantic_revision: 3,
            },
        )
        .unwrap_err();
        assert_eq!(err, MatchingValidateError::CandidateSessionMismatch);
    }

    #[test]
    fn rejects_mutated_claimed_outputs_on_intake() {
        let p = plan();
        let reg = registry(vec![cand("s1", "c1", "1", "1")]);
        let allow: HashSet<String> = ["1".into()].into_iter().collect();
        let err = validate_llm_intake(
            &p,
            "s1",
            &reg,
            &allow,
            &LlmIntakeRequest {
                session_id: "s1".into(),
                semantic_plan_revision: 3,
                map_key: vec!["a1".into(), "Europe".into()],
                target_id: "1".into(),
                claimed_output_values: vec!["hacked".into()],
            },
        )
        .unwrap_err();
        assert_eq!(err, MatchingValidateError::OutputsNotFromSingleCandidate);
    }

    #[test]
    fn rejects_stale_semantic_revision() {
        let p = plan();
        let reg = registry(vec![cand("s1", "c1", "1", "1")]);
        let mut proposals = HashMap::new();
        proposals.insert(
            "p1".into(),
            MatchingProposal {
                proposal_id: "p1".into(),
                session_id: "s1".into(),
                map_key: vec!["a1".into(), "Europe".into()],
                affected_source_rows: 1,
                proposed_candidate_id: Some("c1".into()),
                alternative_candidate_ids: vec![],
                state: MatchingProposalState::Proposed,
                provenance: MatchingProvenance::Fuzzy,
                semantic_plan_revision: 2,
                evidence_revision: 1,
                search_incomplete: false,
            },
        );
        let err = accept_draft_decision(
            &p,
            "s1",
            &proposals,
            &reg,
            &MatchingDecision {
                map_key: vec!["a1".into(), "Europe".into()],
                kind: MatchingDecisionKind::ConfirmProposed,
                candidate_id: Some("c1".into()),
                proposal_id: "p1".into(),
                expected_semantic_revision: 2,
            },
        )
        .unwrap_err();
        assert_eq!(err, MatchingValidateError::StaleSemanticRevision);
    }

    #[test]
    fn rejects_read_only_write_policy() {
        let err = gate_commit_write_policy(false, Some("import write-back is not allowed")).unwrap_err();
        assert!(matches!(err, MatchingValidateError::WritePolicyRefused(_)));
    }

    #[test]
    fn materializes_outputs_from_registered_candidate_not_client() {
        let p = plan();
        let reg = registry(vec![cand("s1", "c1", "1", "1")]);
        let mut proposals = HashMap::new();
        proposals.insert(
            "p1".into(),
            MatchingProposal {
                proposal_id: "p1".into(),
                session_id: "s1".into(),
                map_key: vec!["a1".into(), "Eurpope".into()],
                affected_source_rows: 24,
                proposed_candidate_id: Some("c1".into()),
                alternative_candidate_ids: vec!["c2".into()],
                state: MatchingProposalState::Proposed,
                provenance: MatchingProvenance::Llm,
                semantic_plan_revision: 3,
                evidence_revision: 1,
                search_incomplete: false,
            },
        );
        // Register alternative too for choose path.
        let mut reg = reg;
        reg.insert("c2".into(), cand("s1", "c2", "2", "2"));
        let mat = accept_draft_decision(
            &p,
            "s1",
            &proposals,
            &reg,
            &MatchingDecision {
                map_key: vec!["a1".into(), "Eurpope".into()],
                kind: MatchingDecisionKind::ChooseAlternative,
                candidate_id: Some("c2".into()),
                proposal_id: "p1".into(),
                expected_semantic_revision: 3,
            },
        )
        .unwrap()
        .expect("materialized");
        assert_eq!(mat.output_values, vec!["2".to_string()]);
        assert_eq!(mat.affected_source_rows, 24);
    }

    #[test]
    fn preserves_significant_blank_in_map_key() {
        let p = plan();
        let reg = registry(vec![cand("s1", "c1", "1", "1")]);
        let allow: HashSet<String> = ["1".into()].into_iter().collect();
        let ok = validate_llm_intake(
            &p,
            "s1",
            &reg,
            &allow,
            &LlmIntakeRequest {
                session_id: "s1".into(),
                semantic_plan_revision: 3,
                map_key: vec!["a1".into(), "".into()],
                target_id: "1".into(),
                claimed_output_values: vec![],
            },
        );
        assert!(ok.is_ok());
    }
}
