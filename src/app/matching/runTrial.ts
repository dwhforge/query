/** Apply plan → fixture or host retrieval proposals (ADR-0044). */
import {
  matchingRetrieve,
  type MatchingRetrieveResult,
} from "../../lib/bridge";
import { MATCHING_CAPS } from "../../lib/matchingCaps";
import {
  FIXTURE_PLAN,
  fixtureCandidatesForPlan,
  fixtureProposals,
} from "./fixtures";
import type {
  MatchingCandidateView,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingRunMetrics,
  MatchingTabSession,
} from "./types";
import { mapKeyToken } from "./types";

export function planToWire(plan: MatchingPlanDraft) {
  return {
    sourceRef: plan.sourceRef,
    targetRef: plan.targetRef,
    mapKeyFields: plan.mapKeyFields,
    targetIdentityFields: plan.targetIdentityFields,
    comparisons: plan.comparisons.map((c) => ({
      sourceField: c.sourceField,
      targetField: c.targetField,
      role: c.role,
    })),
    normalization: plan.normalization,
    outputs: plan.outputs,
    ambiguity: plan.ambiguity,
    scope: plan.scope,
    semanticRevision: plan.semanticRevision,
    uiRevision: plan.uiRevision,
  };
}

function mapHostProposal(
  p: MatchingRetrieveResult["proposals"][number],
): MatchingProposalView {
  return {
    proposalId: p.proposalId,
    mapKey: p.mapKey,
    sourceValues: Object.fromEntries(p.mapKey.map((v, i) => [`k${i}`, v])),
    affectedSourceRows: p.affectedSourceRows,
    proposedCandidateId: p.proposedCandidateId ?? null,
    alternativeCandidateIds: p.alternativeCandidateIds ?? [],
    state: (p.state as MatchingProposalView["state"]) ?? "proposed",
    provenance: (p.provenance as MatchingProposalView["provenance"]) ?? "fuzzy",
    semanticPlanRevision: p.semanticPlanRevision,
    evidenceRevision: p.evidenceRevision,
    searchIncomplete: Boolean(p.searchIncomplete),
    evidence: [],
  };
}

/** Lossless live-field enrichment for the shared trial projection. Built from a
 * verified Host acquisition snapshot (actual fields, identity, occurrences and
 * per-source candidate scores). Never fabricates values: unknowns stay unknown. */
export type TrialEnrichment = {
  sourceValuesByKey?: Record<string, Record<string, string | null>>;
  targetByTargetId?: Record<string, {
    outputValues: string[];
    identityParts?: string[];
    occurrences?: number;
    fields: Record<string, string | null>;
  }>;
  scoresByProposal?: Record<string, { candidateId: string; score: number | null; fieldScores: (number | null)[] }[]>;
  allowlistByProposal?: Record<string, string[]>;
};

function mapHostCandidate(
  c: MatchingRetrieveResult["candidates"][number],
  en?: TrialEnrichment,
): MatchingCandidateView {
  const t = en?.targetByTargetId?.[c.targetId];
  return {
    candidateId: c.candidateId,
    targetId: c.targetId,
    outputValues: t ? [...t.outputValues] : c.outputValues,
    identityParts: t?.identityParts ? [...t.identityParts] : undefined,
    occurrences: t?.occurrences,
    fields: t ? { ...t.fields } : { id: c.targetId },
    evidenceRevision: c.evidenceRevision,
  };
}

/** Add per-source contextual score edges / allowlists to a proposal, keeping
 * whatever display data was already adapted. Unknowns stay unknown. */
function applyProposalEnrichment(
  p: MatchingProposalView,
  en: TrialEnrichment | undefined,
): MatchingProposalView {
  const key = mapKeyToken(p.mapKey);
  const sourceValues = en?.sourceValuesByKey?.[key];
  // Host evidence maps are keyed by Host proposal id, not by source key.
  const scores = en?.scoresByProposal?.[p.proposalId];
  const allowlist = en?.allowlistByProposal?.[p.proposalId];
  const next: MatchingProposalView = { ...p };
  if (sourceValues) next.sourceValues = { ...sourceValues };
  if (allowlist?.length) {
    const alts = allowlist.filter((id) => id !== p.proposedCandidateId);
    next.alternativeCandidateIds = [...new Set([...p.alternativeCandidateIds, ...alts])];
    if (!next.proposedCandidateId && allowlist.length) next.proposedCandidateId = allowlist[0];
    if (allowlist.length && next.state === "no_candidates") next.state = "proposed";
  }
  if (scores?.length) {
    next.edges = scores.map((s) => ({
      candidateId: s.candidateId,
      metric: "contextual" as const,
      score: s.score,
      fieldScores: [...s.fieldScores],
      origins: ["fuzzy" as const],
    }));
  }
  return next;
}

export function loadFixtureTrial(session: MatchingTabSession): MatchingTabSession {
  if (session.executionMode !== "demo") {
    throw new Error("Fixture trials require an explicitly selected Demo fixtures session.");
  }
  // Offline fixture rows use provider/region — never keep a Lens plan whose
  // comparisons point at vendor_label/… or expand will match on region alone.
  const plan: MatchingPlanDraft = {
    ...FIXTURE_PLAN,
    scope: session.scope,
    semanticRevision: session.plan?.semanticRevision ?? FIXTURE_PLAN.semanticRevision,
    uiRevision: session.plan?.uiRevision ?? 0,
    outputs:
      session.plan?.outputs && session.plan.outputs.length > 1
        ? session.plan.outputs
        : FIXTURE_PLAN.outputs,
  };
  const proposals = fixtureProposals(plan.semanticRevision);
  // If plan is multi-output demo, keep multi-out proposal; else drop it when outputs len=1
  const filtered =
    plan.outputs.length > 1
      ? proposals
      : proposals.filter((p) => p.proposalId !== "prop:multi-out");
  const metrics: MatchingRunMetrics = {
    mode: "trial",
    keysRequested: filtered.length,
    keysProcessed: filtered.length,
    keysUnprocessed: 0,
    candidatesScored: fixtureCandidatesForPlan(plan).length * filtered.length,
    llmCalls: 0,
    llmRetries: 0,
    durationMs: 0,
    stopReason: "complete",
    caps: {
      keyCap: MATCHING_CAPS.trialUniqueKeys,
      shortlistPerKey: MATCHING_CAPS.retrievalShortlistPerKey,
      llmPerKey: MATCHING_CAPS.llmCandidatesPerKey,
      maxLlmCalls: MATCHING_CAPS.maxLlmCallsPerRun,
      localUniverse: MATCHING_CAPS.localTargetUniverseRows,
    },
  };
  return {
    ...session,
    plan,
    candidates: fixtureCandidatesForPlan(plan),
    proposals: filtered,
    decisions: [],
    runMetrics: metrics,
    selectedProposalId: filtered[0]?.proposalId ?? null,
    pageIndex: 0,
    reviewFilter: "needs_decision",
    chatCollapsed: true,
    generation: session.generation + 1,
  };
}

/** Explicit demo or live retrieve. Rejections leave the caller's draft untouched. */
export async function runMatchingTrial(
  session: MatchingTabSession,
  live?: {
    sourceRows: {
      mapKey: string[];
      fields: Record<string, string>;
      affectedSourceRows?: number;
    }[];
    targetRows: {
      targetId: string;
      fields: Record<string, string>;
      outputValues: string[];
    }[];
  },
  retrieve = matchingRetrieve,
): Promise<MatchingTabSession> {
  if (session.executionMode === "demo") return loadFixtureTrial(session);
  if (!session.plan) throw new Error("Live matching unavailable: confirm a plan first.");
  if (!live?.sourceRows.length || !live.targetRows.length) {
    throw new Error("Live matching unavailable: source and target rows must both be non-empty. No fixture fallback was used.");
  }
  const out = await retrieve({
    sessionId: session.id,
    plan: planToWire(session.plan),
    mode: "trial",
    sourceRows: live.sourceRows,
    targetRows: live.targetRows,
    llmBudgetRemaining: MATCHING_CAPS.maxLlmCallsPerRun,
    allowExpand: true,
  });
  return installMatchingRetrieval(session, out);
}

/** Shared trial projection also consumes Host acquisition's already-run retrieval. */
export function installMatchingRetrieval(
  session: MatchingTabSession,
  out: MatchingRetrieveResult,
  enrichment?: TrialEnrichment,
): MatchingTabSession {
  const metrics: MatchingRunMetrics = {
    mode: "trial",
    keysRequested: out.metrics.keysRequested,
    keysProcessed: out.metrics.keysProcessed,
    keysUnprocessed: out.metrics.keysUnprocessed,
    candidatesScored: out.metrics.candidatesScored,
    llmCalls: out.metrics.llmCalls,
    llmRetries: out.metrics.llmRetries,
    durationMs: out.metrics.durationMs,
    stopReason: (out.metrics.stopReason as MatchingRunMetrics["stopReason"]) ?? "complete",
    caps: {
      keyCap: out.metrics.keyCap,
      shortlistPerKey: out.metrics.shortlistPerKey,
      llmPerKey: out.metrics.llmPerKey,
      maxLlmCalls: out.metrics.maxLlmCalls,
      localUniverse: out.metrics.localUniverse,
    },
  };
  const proposals = out.proposals.map(mapHostProposal).map((p) => applyProposalEnrichment(p, enrichment));
  return {
    ...session,
    candidates: out.candidates.map((c) => mapHostCandidate(c, enrichment)),
    proposals,
    decisions: [],
    runMetrics: metrics,
    selectedProposalId: proposals[0]?.proposalId ?? null,
    pageIndex: 0,
    reviewFilter: "needs_decision",
    chatCollapsed: true,
    generation: session.generation + 1,
  };
}
