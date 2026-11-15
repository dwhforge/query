/** ADR-0051 Basic producer adapter. Legacy batch shapes are pure call values only. */
import type { JoinTupleReport } from "../../lib/bridge";
import { BATCH_HIGH_CONFIDENCE_SCORE, tupleBatchProposals, tupleBatchHighConfidenceTarget, tupleBatchLlmPrompt,
  parseSuggestedBatchTuplePairs, type TupleBatchProposal, type TupleBatchPrompt } from "../../lib/joinLensBatch";
import { confirmTupleMapping, type LensTupleMapping } from "../../lib/joinLensConfirm";
import { mapKeyToken, type MatchingTabSession, type MatchingProposalView } from "./types";
import type { TupleBatchCommitReceipt } from "../../lib/joinLensBatchCommit";
import type { JoinNavigationTarget } from "../queryNavigation";

export function basicCandidateId(runId: string, parts: (string | null)[]): string {
  return JSON.stringify([runId, parts]);
}

export function basicPlanCompatible(session: MatchingTabSession): boolean {
  const b = session.joinBinding, p = session.plan;
  return !!b && !!p && mapKeyToken(p.mapKeyFields) === mapKeyToken(b.leftOn)
    && mapKeyToken(p.outputs) === mapKeyToken(b.rightOn)
    && p.comparisons.length === b.leftOn.length
    && p.comparisons.every((c, i) => c.sourceField === b.leftOn[i] && c.targetField === b.rightOn[i] && c.role === "soft_signal")
    && JSON.stringify(p.normalization) === JSON.stringify(["trim", "casefold"])
    && p.ambiguity === "leave_for_manual";
}

export function adaptBasicReport(session: MatchingTabSession, report: JoinTupleReport, runId: string, scoreCutoff = BATCH_HIGH_CONFIDENCE_SCORE): MatchingTabSession {
  const binding = session.joinBinding;
  if (!binding || !session.plan || !basicPlanCompatible(session) || JSON.stringify(report.left_on) !== JSON.stringify(binding.leftOn)
    || JSON.stringify(report.right_on) !== JSON.stringify(binding.rightOn)
    || report.sources.some(g => g.source.parts.length !== binding.leftOn.length)
    || report.right_universe.some(r => r.parts.length !== binding.rightOn.length)
    || report.sources.some(g => g.candidates.some(c => !Number.isInteger(c.right_index) || !report.right_universe[c.right_index]))) {
    throw new Error("Tuple report does not match the original JOIN binding.");
  }
  const revision = (session.basicRun?.evidenceRevision ?? 0) + 1;
  const initial = tupleBatchProposals(report, scoreCutoff);
  const candidates = report.right_universe.map(row => ({
    candidateId: basicCandidateId(runId, row.parts), targetId: mapKeyToken(row.parts),
    identityParts: [...row.parts], outputValues: [...row.parts], occurrences: row.occurrences,
    fields: Object.fromEntries(report.right_on.map((name, i) => [name, row.parts[i]])),
    evidenceRevision: revision, runId,
  }));
  const proposals: MatchingProposalView[] = initial.map(p => {
    const group = report.sources[p.sourceIndex]!;
    const best = p.alternatives[0];
    const safe = tupleBatchHighConfidenceTarget(report, p) !== null;
    return {
      proposalId: p.id, mapKey: [...group.source.parts],
      sourceValues: Object.fromEntries(report.left_on.map((name, i) => [name, group.source.parts[i]])),
      affectedSourceRows: group.source.occurrences,
      proposedCandidateId: best ? candidates[best.rightIndex]!.candidateId : null,
      alternativeCandidateIds: p.alternatives.map(a => candidates[a.rightIndex]!.candidateId),
      state: safe ? "proposed" : report.right_truncated ? "incomplete_search" : best ? "ambiguous" : "no_candidates",
      suggestionState: safe ? "proposed" : report.right_truncated ? "incomplete_search" : best ? "ambiguous" : "no_candidates",
      provenance: "fuzzy", semanticPlanRevision: session.plan!.semanticRevision,
      evidenceRevision: revision, runId, searchIncomplete: report.right_truncated,
      evidence: [{ field: "scope", note: "Bounded unmatched source tuples; scores are spelling similarity, not probabilities." }],
      edges: group.candidates.filter(c => !!candidates[c.right_index]).map(c => ({
        candidateId: candidates[c.right_index]!.candidateId, metric: "join_tuple_similarity",
        score: c.score, fieldScores: [...c.field_scores], origins: ["fuzzy"],
      })),
      coverage: {
        sourceTotal: report.left_distinct_total, sourceRetrieved: report.sources.length, sourceTruncated: report.left_truncated,
        rightTotal: report.right_distinct_total, rightRetrieved: report.right_universe.length, rightTruncated: report.right_truncated,
        competitorsScored: group.candidates.filter(c => c.score !== null).length,
        competitorsUnknown: group.candidates.filter(c => c.score === null).length + Math.max(0, report.right_universe.length - group.candidates.length), shortlistOmitted: p.omittedFuzzy,
      },
    };
  });
  return { ...session, matchingMode: "basic", basicRun: { id: runId, evidenceRevision: revision, scoreCutoff, report: structuredClone(report) },
    advancedRun: undefined,
    candidates, proposals, decisions: [], hasUnsavedDecisions: false, selectedProposalId: proposals[0]?.proposalId ?? null,
    reviewFilter: "all", pageIndex: 0, commitLifecycle: undefined, generation: session.generation + 1 };
}

/** Project the one ledger for invoking existing pure prompt/eligibility algorithms. */
export function basicInvocationProposals(session: MatchingTabSession): TupleBatchProposal[] {
  const run = session.basicRun;
  if (!run) return [];
  return session.proposals.map(p => {
    const decision = session.decisions.find(d => mapKeyToken(d.mapKey) === mapKeyToken(p.mapKey));
    const selected = decision?.candidateId ? session.candidates.find(c => c.candidateId === decision.candidateId) : undefined;
    return {
      id: mapKeyToken(p.mapKey), sourceIndex: run.report.sources.findIndex(g => mapKeyToken(g.source.parts) === mapKeyToken(p.mapKey)),
      alternatives: p.alternativeCandidateIds.flatMap(id => {
        const c = session.candidates.find(c => c.candidateId === id);
        const rightIndex = c ? run.report.right_universe.findIndex(r => mapKeyToken(r.parts) === mapKeyToken(c.outputValues)) : -1;
        const edge = p.edges?.find(e => e.candidateId === id);
        return rightIndex < 0 ? [] : [{ rightIndex,
          origins: (edge?.origins ?? []).filter((o): o is "fuzzy" | "llm" | "manual" => ["fuzzy", "llm", "manual"].includes(o)), why: edge?.rationale }];
      }),
      selected: selected ? run.report.right_universe.findIndex(r => mapKeyToken(r.parts) === mapKeyToken(selected.outputValues)) : null,
      decision: decision ? ["confirm_proposed", "choose_alternative"].includes(decision.kind) ? "accepted" : "skipped" : "pending",
      omittedFuzzy: p.coverage?.shortlistOmitted ?? 0, userTouched: p.userTouched,
    };
  });
}

export function basicHighConfidenceIds(session: MatchingTabSession): string[] {
  if (!session.basicRun || session.commitLifecycle) return [];
  return basicInvocationProposals(session).filter(p => tupleBatchHighConfidenceTarget(session.basicRun!.report, p) !== null).map(p => p.id);
}

export function basicPrompt(session: MatchingTabSession): TupleBatchPrompt {
  if (!session.basicRun) throw new Error("Find matches first.");
  return tupleBatchLlmPrompt(session.basicRun.report, basicInvocationProposals(session), session.selectedProposalId);
}

/** Merge into latest evidence only; explicit decisions and producer suggestions stay separate. */
export function mergeBasicLlm(session: MatchingTabSession, runId: string, text: string, sent: TupleBatchPrompt): MatchingTabSession {
  if (session.basicRun?.id !== runId || session.commitLifecycle || !basicPlanCompatible(session)
    || session.proposals.some(p => p.semanticPlanRevision !== session.plan?.semanticRevision)) return session;
  let proposals = session.proposals.map(p => {
    const group = sent.groups.find(g => mapKeyToken(g.source) === mapKeyToken(p.mapKey));
    return group && p.coverage ? { ...p, coverage: { ...p.coverage,
      promptOmitted: session.basicRun!.report.right_universe.length - group.allowed.length } } : p;
  });
  for (const pair of parseSuggestedBatchTuplePairs(text, sent)) {
    const candidate = session.candidates.find(c => mapKeyToken(c.outputValues) === mapKeyToken(pair.to_parts));
    if (!candidate) continue;
    proposals = proposals.map(p => {
      if (mapKeyToken(p.mapKey) !== mapKeyToken(pair.from_parts)) return p;
      const edges = [...(p.edges ?? [])];
      const i = edges.findIndex(e => e.candidateId === candidate.candidateId);
      const edge = i < 0 ? { candidateId: candidate.candidateId, metric: "join_tuple_similarity" as const,
        score: null, fieldScores: pair.to_parts.map(() => null), origins: [] } : edges[i]!;
      const merged = { ...edge, origins: [...new Set([...edge.origins, "llm" as const])], rationale: pair.why };
      if (i < 0) edges.push(merged); else edges[i] = merged;
      return { ...p, edges, alternativeCandidateIds: [...new Set([...p.alternativeCandidateIds, candidate.candidateId])] };
    });
  }
  return { ...session, proposals };
}

export function collectBasicDecisions(session: MatchingTabSession): LensTupleMapping[] | { error: string } {
  const binding = session.joinBinding, run = session.basicRun;
  if (session.commitLifecycle?.status === "stale") return { error: "Stale Matching review cannot be written. Reopen Find Matches." };
  if (!binding || !run || !session.plan || !basicPlanCompatible(session)) return { error: "Missing original JOIN run or unsupported Advanced plan." };
  const result: LensTupleMapping[] = [];
  const seen = new Set<string>();
  for (const d of session.decisions) {
    if (!["confirm_proposed", "choose_alternative"].includes(d.kind)) continue;
    const p = session.proposals.find(p => p.proposalId === d.proposalId);
    const c = session.candidates.find(c => c.candidateId === d.candidateId);
    if (!p || !c || seen.has(mapKeyToken(d.mapKey)) || mapKeyToken(d.mapKey) !== mapKeyToken(p.mapKey)
      || d.expectedRunId !== run.id || d.expectedEvidenceRevision !== p.evidenceRevision
      || d.expectedSemanticRevision !== session.plan.semanticRevision || c.runId !== run.id
      || !p.alternativeCandidateIds.includes(c.candidateId)) return { error: "Stale, missing or conflicting complete tuple decision." };
    const mapping = confirmTupleMapping([...binding.leftOn], [...binding.rightOn], d.mapKey, c.outputValues);
    if ("error" in mapping) return mapping;
    seen.add(mapKeyToken(d.mapKey)); result.push(mapping);
  }
  return result;
}

/** Sticky local-definition invalidation; returning to an old definition is not refresh. */
export function matchingReceiptOwned(session: MatchingTabSession, receipt: TupleBatchCommitReceipt): boolean {
  const run = session.advancedRun ?? session.basicRun;
  const count = session.decisions.filter(d => ["confirm_proposed", "choose_alternative"].includes(d.kind)).length;
  return !!run && session.commitLifecycle?.status === "pending" && session.commitLifecycle.runId === run.id
    && receipt.matchingSessionId === session.id && receipt.matchingRunId === run.id
    && receipt.projectIdentity === session.joinBinding?.projectIdentity
    && count > 0 && receipt.appliedCount === count
    && Number.isInteger(receipt.joinStepIndex) && receipt.joinStepIndex >= 0;
}

export function reconcileBasicContext(session: MatchingTabSession, identity: string, fingerprint: string,
  ownReceipt?: TupleBatchCommitReceipt): MatchingTabSession {
  const b = session.joinBinding;
  if (!b || session.commitLifecycle?.status === "stale") return session;
  const permitted = !!ownReceipt && matchingReceiptOwned(session, ownReceipt);
  if (identity === b.projectIdentity && fingerprint === (permitted ? ownReceipt.contextFingerprint : b.contextFingerprint)) return session;
  return { ...session, commitLifecycle: { status: "stale", reason: "Original JOIN context changed. Draft retained for inspection only; reopen Find Matches to review current data." } };
}

export function acknowledgeBasicReceipt(session: MatchingTabSession, receipt: TupleBatchCommitReceipt,
  identity: string, fingerprint: string, navigationTarget: JoinNavigationTarget | null): MatchingTabSession | { error: string } {
  const b = session.joinBinding, run = session.basicRun;
  if (!b || !run || !matchingReceiptOwned(session, receipt)
    || receipt.matchingSessionId !== session.id || receipt.matchingRunId !== run.id
    || receipt.projectIdentity !== b.projectIdentity || identity !== receipt.projectIdentity
    || fingerprint !== receipt.contextFingerprint) return { error: "Project or Matching session changed before acknowledgement. Inspect the project and reopen Find Matches." };
  return { ...session, joinBinding: { ...b, contextFingerprint: receipt.contextFingerprint, joinStepIndex: receipt.joinStepIndex },
    lensCtx: session.lensCtx ? { ...session.lensCtx, joinStepIndex: receipt.joinStepIndex, navigationTarget } : undefined,
    basicRun: undefined, proposals: [], candidates: [], decisions: [], hasUnsavedDecisions: false,
    generation: session.generation + 1, selectedProposalId: null,
    commitLifecycle: { status: "acknowledged", runId: run.id, receipt } };
}
