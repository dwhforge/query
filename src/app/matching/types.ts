/** Matching workspace session (ADR-0044) — in-process only until persistence ADR. */
import type { JoinNavigationTarget } from "../queryNavigation";

export type MatchingScopeKind = "selected" | "cohort" | "full";

export type MatchingFieldRole =
  | "hard_constraint"
  | "soft_signal"
  | "reference_context";

export type MatchingPlanComparison = {
  sourceField: string;
  targetField: string;
  role: MatchingFieldRole;
};

export type MatchingPlanDraft = {
  sourceRef: string;
  targetRef: string;
  mapKeyFields: string[];
  targetIdentityFields: string[];
  comparisons: MatchingPlanComparison[];
  normalization: string[];
  outputs: string[];
  ambiguity: "leave_for_manual" | "prefer_best_soft";
  scope: MatchingScopeKind;
  semanticRevision: number;
  uiRevision: number;
};

export type MatchingProvenance = "fuzzy" | "llm" | "manual" | "fixture" | "carried_over";

export type MatchingProposalState =
  | "proposed"
  | "ambiguous"
  | "no_candidates"
  | "incomplete_search"
  | "confirmed_in_draft"
  | "deferred"
  | "rejected"
  | "stale"
  | "saved";

export type MatchingCandidateView = {
  candidateId: string;
  targetId: string;
  outputValues: string[];
  /** Display fields for detail panel */
  fields: Record<string, string>;
  evidenceRevision: number;
};

export type MatchingEvidenceNote = {
  field: string;
  note: string;
};

export type MatchingProposalView = {
  proposalId: string;
  mapKey: string[];
  sourceValues: Record<string, string>;
  affectedSourceRows: number;
  proposedCandidateId: string | null;
  alternativeCandidateIds: string[];
  state: MatchingProposalState;
  provenance: MatchingProvenance;
  semanticPlanRevision: number;
  evidenceRevision: number;
  searchIncomplete: boolean;
  evidence: MatchingEvidenceNote[];
};

export type MatchingDecisionKind =
  | "confirm_proposed"
  | "choose_alternative"
  | "defer"
  | "reject"
  | "no_suitable_target";

export type MatchingDecisionView = {
  mapKey: string[];
  kind: MatchingDecisionKind;
  candidateId: string | null;
  proposalId: string;
  expectedSemanticRevision: number;
};

export type MatchingRunMetrics = {
  mode: "trial" | "mass";
  keysRequested: number;
  keysProcessed: number;
  keysUnprocessed: number;
  candidatesScored: number;
  llmCalls: number;
  llmRetries: number;
  durationMs: number;
  stopReason: "complete" | "budget" | "cancelled" | "universe_cap" | null;
  caps: {
    keyCap: number;
    shortlistPerKey: number;
    llmPerKey: number;
    maxLlmCalls: number;
    localUniverse: number;
  };
};

export type MatchingReviewFilter =
  | "needs_decision"
  /** Fuzzy + high-confidence LLM proposals — combined outcome before Save. */
  | "ready"
  | "ambiguous"
  | "incomplete_search"
  | "confirmed"
  /** Written into the Mapping this session. */
  | "saved"
  | "stale"
  | "all";

export type MatchingFinalDiffRow = {
  mapKey: string[];
  kind: "add" | "change" | "noop" | "unresolved";
  oldOutputs: string[] | null;
  newOutputs: string[] | null;
  origin: string;
  affectedSourceRows: number;
};

export type MatchingTabSession = {
  id: string;
  title: string;
  /** In-process data origin; demo never authorizes a Mapping write. */
  executionMode: "live" | "demo";
  targetMapId?: string;
  entry: "lens" | "mapping" | "query";
  scope: MatchingScopeKind;
  lensCtx?: {
    /** Captured once on entry, never rebound to the current canvas selection. */
    navigationTarget?: JoinNavigationTarget | null;
    hostQueryId: string;
    joinStepIndex: number;
    leftOn: string[];
    rightOn: string[];
    rightQueryId: string;
    /** Prefer FromQuery parent (e.g. pos_invoices), not the dirty Join query. */
    leftSourceQueryId?: string;
    sourceColumns?: string[];
    targetColumns?: string[];
  };
  /** Query ids for Source/Target combos (workspace). */
  queryOptions?: string[];
  instructionText: string;
  plan: MatchingPlanDraft | null;
  candidates: MatchingCandidateView[];
  proposals: MatchingProposalView[];
  decisions: MatchingDecisionView[];
  /** Map baseline at prepare (From token → outputs) */
  mapBaseline: { fromParts: string[]; outputValues: string[] }[];
  mapLive: { fromParts: string[]; outputValues: string[] }[];
  runMetrics: MatchingRunMetrics | null;
  reviewFilter: MatchingReviewFilter;
  selectedProposalId: string | null;
  pageIndex: number;
  pageSize: number;
  hasUnsavedDecisions: boolean;
  chatCollapsed: boolean;
  /** Explicit replace agreements for keys (joined with \0) */
  explicitReplaceKeys: string[];
  llmPermissionGranted: boolean;
  generation: number;
};

export function newMatchingSessionId(): string {
  return `match_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mapKeyToken(parts: string[]): string {
  return parts.join("\0");
}

export function emptyMatchingSession(
  partial: Omit<
    MatchingTabSession,
    | "executionMode"
    | "candidates"
    | "proposals"
    | "decisions"
    | "mapBaseline"
    | "mapLive"
    | "runMetrics"
    | "reviewFilter"
    | "selectedProposalId"
    | "pageIndex"
    | "pageSize"
    | "explicitReplaceKeys"
    | "llmPermissionGranted"
    | "generation"
  >,
): MatchingTabSession {
  return {
    ...partial,
    executionMode: "live",
    candidates: [],
    proposals: [],
    decisions: [],
    mapBaseline: [],
    mapLive: [],
    runMetrics: null,
    reviewFilter: "needs_decision",
    selectedProposalId: null,
    pageIndex: 0,
    pageSize: 50,
    explicitReplaceKeys: [],
    llmPermissionGranted: false,
    generation: 0,
  };
}
