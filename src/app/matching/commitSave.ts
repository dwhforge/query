/** Final Matching commit via host gates + map merge intent (ADR-0044). */
import { matchingAcceptDraft, matchingPlanCommit } from "../../lib/bridge";
import {
  buildFinalDiff,
  materializedFromSession,
  summarizeFinalDiff,
} from "./reviewLogic";
import type { MatchingPlanDraft, MatchingTabSession } from "./types";
import { mapKeyToken } from "./types";

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
    if (d.kind !== "confirm_proposed" && d.kind !== "choose_alternative") {
      continue;
    }
    try {
      const res = await matchingAcceptDraft({
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
      if (res.materialized) materialized.push(res.materialized);
    } catch (e) {
      return {
        ok: false,
        reason: typeof e === "string" ? e : String(e),
        session,
      };
    }
  }

  // Prefer host-materialized; fall back to local materialization for fixture-only.
  const decisions =
    materialized.length > 0 ? materialized : materializedFromSession(session);

  const commit = await matchingPlanCommit({
    decisions,
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

  // AlreadyMatches → no-op rows; still mark saved
  const savedKeys = new Set(
    commit.items
      .filter((i) =>
        ["add", "replace", "already_matches"].includes(i.outcome),
      )
      .map((i) => mapKeyToken(i.mapKey)),
  );

  const next: MatchingTabSession = {
    ...session,
    proposals: session.proposals.map((p) =>
      savedKeys.has(mapKeyToken(p.mapKey))
        ? { ...p, state: "saved" as const }
        : p,
    ),
    hasUnsavedDecisions: false,
  };

  const summary = summarizeFinalDiff(buildFinalDiff(next));
  return { ok: true, upserts, session: next, summary };
}
