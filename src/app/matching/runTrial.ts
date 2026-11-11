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

function planToWire(plan: MatchingPlanDraft) {
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

function mapHostCandidate(
  c: MatchingRetrieveResult["candidates"][number],
): MatchingCandidateView {
  return {
    candidateId: c.candidateId,
    targetId: c.targetId,
    outputValues: c.outputValues,
    fields: { id: c.targetId },
    evidenceRevision: c.evidenceRevision,
  };
}

export function loadFixtureTrial(session: MatchingTabSession): MatchingTabSession {
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

/** Live retrieve via host; falls back to fixtures on empty rows / host error. */
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
): Promise<MatchingTabSession> {
  if (!session.plan) return loadFixtureTrial(session);
  if (!live?.sourceRows.length || !live.targetRows.length) {
    return loadFixtureTrial(session);
  }
  try {
    const out = await matchingRetrieve({
      sessionId: session.id,
      plan: planToWire(session.plan),
      mode: "trial",
      sourceRows: live.sourceRows,
      targetRows: live.targetRows,
      llmBudgetRemaining: MATCHING_CAPS.maxLlmCallsPerRun,
      allowExpand: true,
    });
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
    const proposals = out.proposals.map(mapHostProposal);
    return {
      ...session,
      candidates: out.candidates.map(mapHostCandidate),
      proposals,
      decisions: [],
      runMetrics: metrics,
      selectedProposalId: proposals[0]?.proposalId ?? null,
      pageIndex: 0,
      reviewFilter: "needs_decision",
      chatCollapsed: true,
      generation: session.generation + 1,
    };
  } catch {
    return loadFixtureTrial(session);
  }
}
