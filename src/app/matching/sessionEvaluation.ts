/** Existing Basic / Advanced session → universal read-only Set Evaluation. */
import type { MatchingTabSession, MatchingProposalView } from "./types";
import { evaluateSet, setTupleKey, type EvaluationOutcome, type SetEvaluation } from "./setEvaluation";

function status(p: MatchingProposalView): EvaluationOutcome {
  if (p.searchIncomplete && ["proposed", "ambiguous", "no_candidates", "incomplete_search"].includes(p.state))
    return "incomplete";
  switch (p.state) {
    case "proposed": return p.searchIncomplete ? "incomplete" : "proposed";
    case "ambiguous": return "ambiguous";
    case "no_candidates": return p.searchIncomplete ? "incomplete" : "no_proposal";
    case "incomplete_search": return "incomplete";
    case "confirmed_in_draft": return "confirmed_draft";
    case "deferred": return "deferred";
    case "rejected": return "rejected";
    case "saved": return "saved";
    case "stale": return "stale";
  }
}

export function evaluationFromSession(session: MatchingTabSession): SetEvaluation | null {
  const basic = session.basicRun;
  const advanced = session.advancedRun;
  if (!basic && !advanced) return null;
  const candidates = new Map(session.candidates.map(c => [c.candidateId, c]));
  const runId = advanced?.id ?? basic!.id;
  const rightKeys = advanced
    ? advanced.snapshot.acquisition.targetRows.map(r => JSON.stringify(r.identityValues))
    : basic!.report.right_universe.map(r => setTupleKey(r.parts));
  const report = basic?.report;
  const sourceComplete = advanced ? advanced.snapshot.acquisition.complete
    : report ? !report.left_truncated : null;
  const targetComplete = advanced ? advanced.snapshot.acquisition.complete
    : report ? !report.right_truncated : null;
  const rows = session.proposals.map(p => {
    const c = p.proposedCandidateId ? candidates.get(p.proposedCandidateId) : undefined;
    const score = p.proposedCandidateId
      ? p.edges?.find(e => e.candidateId === p.proposedCandidateId)?.score ?? null : null;
    return {
      id: p.proposalId,
      left: [...p.mapKey], sourceRows: p.affectedSourceRows,
      right: c ? [...c.outputValues] : null,
      candidateId: c?.candidateId ?? null,
      score, alternatives: p.alternativeCandidateIds.length,
      outcome: status(p), searchIncomplete: p.searchIncomplete,
    };
  });
  const retrieval = advanced?.snapshot.retrieval;
  return evaluateSet({
    runId, producer: advanced ? "advanced" : "basic",
    planRevision: session.plan?.semanticRevision ?? 0,
    // ContextFingerprint binds the captured project/JOIN definitions, but is NOT a DB snapshot.
    contextFingerprint: session.joinBinding?.contextFingerprint ?? null,
    sourceScope: advanced ? advanced.snapshot.acquisition.scope : "unmatched",
    sourceComplete, targetComplete,
    sourceTotal: report ? report.left_distinct_total
      : retrieval?.metrics.keysRequested ?? null,
    rightTotal: report ? report.right_distinct_total
      : advanced?.snapshot.acquisition.targetRows.length ?? null,
    rightKeys, rows,
  });
}
