//! Matching session contracts (ADR-0044). Pure data — no DuckDB.

use serde::{Deserialize, Serialize};

/// Role of a comparison field pair in the plan.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingFieldRole {
    /// Must hold for a candidate to remain eligible.
    HardConstraint,
    /// Soft ranking / evidence signal.
    SoftSignal,
    /// Shown for context; not a filter unless promoted.
    ReferenceContext,
}

/// One source↔target comparison in the structured plan.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingPlanComparison {
    pub source_field: String,
    pub target_field: String,
    pub role: MatchingFieldRole,
}

/// Behaviour when multiple candidates remain after hard constraints.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingAmbiguityPolicy {
    LeaveForManual,
    PreferBestSoft,
}

/// Processing scope label (never silently the Lens display sample).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingScopeKind {
    Selected,
    Cohort,
    Full,
}

/// Structured execution contract. Chat may populate; UI edits are authoritative.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingPlan {
    pub source_ref: String,
    pub target_ref: String,
    /// Map From columns / identity parts.
    pub map_key_fields: Vec<String>,
    /// Target identity field(s) used as candidate id.
    pub target_identity_fields: Vec<String>,
    pub comparisons: Vec<MatchingPlanComparison>,
    /// Allowed normalization ops (opaque tokens for now).
    #[serde(default)]
    pub normalization: Vec<String>,
    /// Map output columns (aligned with registered candidate outputs).
    pub outputs: Vec<String>,
    pub ambiguity: MatchingAmbiguityPolicy,
    pub scope: MatchingScopeKind,
    /// Semantic revision — comparison/key/identity/outputs. Invalidates proposals.
    pub semantic_revision: u64,
    /// UI revision — display/sort/label. Does not invalidate proposals.
    pub ui_revision: u64,
}

/// Registered, host-verified target candidate for a task/session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingCandidate {
    pub candidate_id: String,
    pub session_id: String,
    /// Target identity (allowlist membership key).
    pub target_id: String,
    /// Outputs aligned to plan `outputs` — host SoT for materialization.
    pub output_values: Vec<String>,
    /// Evidence freshness token for this candidate snapshot.
    pub evidence_revision: u64,
}

/// How a proposal was produced.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingProvenance {
    Fuzzy,
    Llm,
    Manual,
    CarriedOver,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingProposalState {
    Proposed,
    Ambiguous,
    NoCandidates,
    IncompleteSearch,
    ConfirmedInDraft,
    Deferred,
    Rejected,
    Stale,
    Saved,
}

/// Host-held proposal. Outputs are not trusted from the renderer.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingProposal {
    pub proposal_id: String,
    pub session_id: String,
    /// Full map From tuple.
    pub map_key: Vec<String>,
    /// Affected source row count sharing this key.
    pub affected_source_rows: u32,
    pub proposed_candidate_id: Option<String>,
    pub alternative_candidate_ids: Vec<String>,
    pub state: MatchingProposalState,
    pub provenance: MatchingProvenance,
    pub semantic_plan_revision: u64,
    pub evidence_revision: u64,
    /// Search was truncated / bounded.
    #[serde(default)]
    pub search_incomplete: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingDecisionKind {
    ConfirmProposed,
    ChooseAlternative,
    Defer,
    Reject,
    NoSuitableTarget,
}

/// User draft decision keyed by map key.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingDecision {
    pub map_key: Vec<String>,
    pub kind: MatchingDecisionKind,
    /// Required for ConfirmProposed / ChooseAlternative (registered candidate).
    pub candidate_id: Option<String>,
    pub proposal_id: String,
    pub expected_semantic_revision: u64,
}

/// Snapshot of one map row used for merge (baseline or live).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchingMapRowSnapshot {
    pub from_parts: Vec<String>,
    pub output_values: Vec<String>,
}

impl MatchingMapRowSnapshot {
    pub fn key_token(&self) -> String {
        map_key_token(&self.from_parts)
    }
}

/// Stable map-key token. Preserves empty parts (significant blanks) — never drop.
pub fn map_key_token(parts: &[String]) -> String {
    parts.join("\0")
}

/// A map row exists for this From key (“filled” in ADR-0044).
/// Presence of the row matters — not whether outputs look like 0/false/"".
pub fn map_row_exists(live: &std::collections::HashMap<String, MatchingMapRowSnapshot>, key: &[String]) -> bool {
    live.contains_key(&map_key_token(key))
}
