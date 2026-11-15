/** Matching workspace session (ADR-0044) — in-process only until persistence ADR. */
import type { JoinNavigationTarget } from "../queryNavigation";
import type { JoinTupleReport } from "../../lib/bridge";
import type { TupleBatchCommitReceipt } from "../../lib/joinLensBatchCommit";

export type MatchingTuple = (string | null)[];
export type MatchingEdge = {
  candidateId: string;
  metric: "join_tuple_similarity" | "contextual";
  score: number | null;
  fieldScores: (number | null)[];
  origins: MatchingProvenance[];
  rationale?: string;
};
export type MatchingJoinBinding = {
  readonly projectIdentity: string;
  readonly contextFingerprint: string;
  readonly hostQueryId: string;
  readonly joinStepIndex: number;
  readonly leftOn: readonly string[];
  readonly rightOn: readonly string[];
  readonly rightQueryId: string;
};
export type MatchingBasicRun = {
  id: string;
  evidenceRevision: number;
  scoreCutoff: number;
  /** Immutable producer evidence, never a decision queue. */
  report: JoinTupleReport;
};

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
  outputValues: MatchingTuple;
  identityParts?: MatchingTuple;
  occurrences?: number;
  runId?: string;
  /** Display fields for detail panel */
  fields: Record<string, string | null>;
  evidenceRevision: number;
};

export type MatchingEvidenceNote = {
  field: string;
  note: string;
};

export type MatchingProposalView = {
  proposalId: string;
  mapKey: MatchingTuple;
  sourceValues: Record<string, string | null>;
  affectedSourceRows: number;
  proposedCandidateId: string | null;
  alternativeCandidateIds: string[];
  state: MatchingProposalState;
  /** Producer status; Basic review status is derived from the ledger. */
  suggestionState?: MatchingProposalState;
  provenance: MatchingProvenance;
  semanticPlanRevision: number;
  evidenceRevision: number;
  searchIncomplete: boolean;
  evidence: MatchingEvidenceNote[];
  edges?: MatchingEdge[];
  /** Source/run-bound manual lookup evidence, never another decision ledger. */
  manualLookups?: Record<string, { text: string; offset: number }>;
  coverage?: {
    sourceTotal: number | null; sourceRetrieved: number; sourceTruncated: boolean;
    rightTotal: number | null; rightRetrieved: number; rightTruncated: boolean;
    competitorsScored: number; competitorsUnknown: number; shortlistOmitted: number;
    promptOmitted?: number;
  };
  runId?: string;
  userTouched?: boolean;
};

export type MatchingDecisionKind =
  | "confirm_proposed"
  | "choose_alternative"
  | "defer"
  | "reject"
  | "no_suitable_target";

export type MatchingDecisionView = {
  mapKey: MatchingTuple;
  kind: MatchingDecisionKind;
  candidateId: string | null;
  proposalId: string;
  expectedSemanticRevision: number;
  expectedEvidenceRevision?: number;
  expectedRunId?: string;
  revision?: number;
  origin?: "review" | "high_confidence_bulk" | "reviewed_bulk";
  bulkToken?: string;
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
  mapKey: MatchingTuple;
  kind: "add" | "change" | "noop" | "unresolved";
  oldOutputs: string[] | null;
  newOutputs: MatchingTuple | null;
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
  joinBinding?: MatchingJoinBinding;
  basicRun?: MatchingBasicRun;
  /** Basic is the easy default. Advanced is enabled only by explicit plan confirmation. */
  matchingMode?: "basic" | "advanced";
  advancedRun?: {
    id: string; evidenceRevision: number;
    snapshot: import("../../lib/bridge").MatchingJoinSnapshot;
    request: Pick<import("../../lib/bridge").MatchingAcquireJoinArgs, "mode" | "scope" | "sourceParts" | "allowExpand" | "llmBudgetRemaining">;
  };
  advancedSettings?: { expand: boolean; rank: boolean };
  commitLifecycle?:
    | { status: "pending"; runId: string }
    | { status: "acknowledged"; runId: string; receipt: TupleBatchCommitReceipt }
    | { status: "stale"; reason: string };
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

export function mapKeyToken(parts: readonly (string | null)[]): string {
  return JSON.stringify(parts);
}

/** Existing Mapping/contextual wire is string-only. Refuse, never coerce NULL. */
export function requireStringTuple(parts: MatchingTuple): string[] {
  if (parts.some(p => p === null)) throw new Error("NULL tuple parts cannot be written to Mapping.");
  return parts as string[];
}

export function requireStringFields(fields: Record<string, string | null>): Record<string, string> {
  if (Object.values(fields).some(v => v === null)) throw new Error("NULL contextual fields are not supported by this producer.");
  return fields as Record<string, string>;
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
