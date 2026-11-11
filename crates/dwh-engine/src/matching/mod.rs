//! Matching workspace pure contracts (ADR-0044).
//!
//! Caps, plan/proposal/decision types, host-side validation, and map-key merge.
//! No DuckDB / no LLM HTTP here.

mod caps;
mod merge;
mod retrieve;
mod types;
mod validate;

pub use caps::{
    LLM_CANDIDATES_PER_KEY, LLM_RETRIES_PER_REQUEST, LOCAL_TARGET_UNIVERSE_ROWS,
    MASS_RUN_UNIQUE_KEYS, MAX_LLM_CALLS_PER_RUN, PARALLEL_LLM_REQUESTS,
    RETRIEVAL_SHORTLIST_PER_KEY, TRIAL_UNIQUE_KEYS,
};
pub use merge::{
    bulk_saveable, classify_merge, commit_blocked_reason, detect_proposal_conflicts,
    plan_bulk_confirm, MatchingMergeItem, MatchingMergeOutcome,
};
pub use retrieve::{
    matching_retrieve, MatchingRetrieveRequest, MatchingRetrieveResult, MatchingRunMetrics,
    MatchingRunMode, MatchingSourceRow, MatchingTargetRow,
};
pub use types::{
    map_key_token, map_row_exists, MatchingAmbiguityPolicy, MatchingCandidate, MatchingDecision,
    MatchingDecisionKind, MatchingFieldRole, MatchingMapRowSnapshot, MatchingPlan,
    MatchingPlanComparison, MatchingProposal, MatchingProposalState, MatchingProvenance,
    MatchingScopeKind,
};
pub use validate::{
    accept_draft_decision, gate_commit_write_policy, validate_llm_intake, LlmIntakeRequest,
    MaterializedDecision, MatchingValidateError,
};
