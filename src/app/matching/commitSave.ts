/** Final Matching commit via host gates + map merge intent (ADR-0044). */
import { matchingAcceptDraft, matchingPlanCommit } from "../../lib/bridge";
import {
  buildFinalDiff,
  summarizeFinalDiff,
} from "./reviewLogic";
import type { MatchingPlanDraft, MatchingTabSession } from "./types";

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

export type MatchingCommitResult =
  | {
      ok: true;
      upserts: { fromParts: string[]; outputValues: string[] }[];
      /** Validated keys including already_matches; not a persistence receipt. */
      acceptedKeys: string[][];
      session: MatchingTabSession;
      summary: ReturnType<typeof summarizeFinalDiff>;
    }
  | { ok: false; reason: string; session: MatchingTabSession };

/**
 * Re-validate each draft decision on the host, plan commit, refuse partial Save.
 * Returns upserts for the App to merge into the Mapping via existing Save.
 */
export async function commitMatchingSession(
  session: MatchingTabSession,
  opts: { writeAllowed: boolean; writeRefusalReason?: string },
  gates = { acceptDraft: matchingAcceptDraft, planCommit: matchingPlanCommit },
): Promise<MatchingCommitResult> {
  if (!session.plan) {
    return { ok: false, reason: "plan_missing", session };
  }
  const plan = planToWire(session.plan);
  const proposals = session.proposals.map((p) => ({
    proposalId: p.proposalId,
    sessionId: session.id,
    mapKey: p.mapKey,
    affectedSourceRows: p.affectedSourceRows,
    proposedCandidateId: p.proposedCandidateId,
    alternativeCandidateIds: p.alternativeCandidateIds,
    state: p.state,
    provenance: p.provenance === "fixture" ? "manual" : p.provenance,
    semanticPlanRevision: p.semanticPlanRevision,
    evidenceRevision: p.evidenceRevision,
    searchIncomplete: p.searchIncomplete,
  }));
  const candidates = session.candidates.map((c) => ({
    candidateId: c.candidateId,
    sessionId: session.id,
    targetId: c.targetId,
    outputValues: c.outputValues,
    evidenceRevision: c.evidenceRevision,
  }));

  // Host draft-accept each confirming decision (forged-payload gate).
  const materialized = [];
  for (const d of session.decisions) {
    // Previously acknowledged rows are checked against live storage by persistence;
    // Saved proposals are deliberately not selectable at the host draft gate.
    if (session.proposals.find((p) => p.proposalId === d.proposalId)?.state === "saved") continue;
    if (d.kind !== "confirm_proposed" && d.kind !== "choose_alternative") {
      continue;
    }
    try {
      const res = await gates.acceptDraft({
        sessionId: session.id,
        plan,
        proposals,
        candidates,
        decision: {
          mapKey: d.mapKey,
          kind: d.kind,
          candidateId: d.candidateId,
          proposalId: d.proposalId,
          expectedSemanticRevision: d.expectedSemanticRevision,
        },
      });
      if (!res.accepted || !res.materialized) {
        return { ok: false, reason: "decision_not_materialized", session };
      }
      materialized.push(res.materialized);
    } catch (e) {
      return {
        ok: false,
        reason: typeof e === "string" ? e : String(e),
        session,
      };
    }
  }

  const commit = await gates.planCommit({
    decisions: materialized,
    baseline: session.mapBaseline,
    live: session.mapLive,
    explicitReplaceKeys: session.explicitReplaceKeys.map((t) => t.split("\0")),
    writeAllowed: opts.writeAllowed,
    writeRefusalReason: opts.writeRefusalReason ?? null,
  });

  if (!commit.ok) {
    return {
      ok: false,
      reason: commit.blockedReason ?? "commit_blocked",
      session,
    };
  }

  const upserts = commit.items
    .filter((i) => i.outcome === "add" || i.outcome === "replace")
    .map((i) => ({
      fromParts: i.mapKey,
      outputValues: i.proposedOutputs ?? [],
    }));

  const acceptedKeys =
    commit.items
      .filter((i) =>
        ["add", "replace", "already_matches"].includes(i.outcome),
      )
      .map((i) => i.mapKey);

  const summary = summarizeFinalDiff(buildFinalDiff(session));
  return { ok: true, upserts, acceptedKeys, session, summary };
}
