/** ADR-0051 Advanced producer adapter and orchestration.
 *
 * The Host `matching_acquire_join` / `matching_verify_join_candidates` RPCs return
 * a typed, bounded, session-local snapshot of actual pre-JOIN LEFT source rows and
 * consumed RIGHT rows, plus a contextual `MatchingRetrieveResult` (real per-source
 * candidate scores, field evidence, allowlists, occurrences, multi-origin
 * provenance).
 *
 * This module projects that snapshot losslessly into the SAME
 * MatchingProposalView / MatchingCandidateView shared review model the Basic path
 * already drives. It never re-implements a scorer, never stringifies NULL, never
 * splits display strings, never normalizes identity and never fabricates
 * contextual scores from proposal state. Unknown scores stay unknown.
 *
 * The App supplies the current execution context and the atomic write/receipt
 * callback; this module owns the Advanced plan/run/commit logic (no App
 * orchestration), mirroring `basic.ts`.
 */
import type {
  MatchingAcquireJoinArgs,
  MatchingJoinSnapshot,
  MatchingJoinVerified,
} from "../../lib/bridge";
import type { TupleBatchCommitReceipt } from "../../lib/joinLensBatchCommit";
import { MATCHING_CAPS } from "../../lib/matchingCaps";
import { confirmTupleMapping } from "../../lib/joinLensConfirm";
import type { JoinNavigationTarget } from "../queryNavigation";
import { installMatchingRetrieval, type TrialEnrichment } from "./runTrial";
import { matchingReceiptOwned, reconcileBasicContext } from "./basic";
import { matchingSaveRevision } from "./persistSave";
import type {
  MatchingCandidateView,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingTabSession,
} from "./types";
import { mapKeyToken, requireStringTuple } from "./types";

/** The authoritative producer run for a JOIN-bound session: Basic stays the
 * easy default; Advanced is used only after an explicit semantic
 * confirmation. Unknown evidence stays unknown. */
export function sessionRun(session: MatchingTabSession): { id: string; evidenceRevision: number } | undefined {
  return session.advancedRun ?? session.basicRun;
}

/** Local-only async ownership token; never expose definition-bearing revisions. */
function advancedReviewRevision(session: MatchingTabSession): string {
  const run = sessionRun(session);
  return JSON.stringify([matchingSaveRevision(session), session.scope, session.joinBinding, run?.id, run?.evidenceRevision]);
}

/** Advanced plan is usable when it retains the original ordered JOIN
 * keys → outputs and target, as enforced by the Host acquisition. */
export function advancedPlanCompatible(session: MatchingTabSession): boolean {
  const b = session.joinBinding, p = session.plan;
  return !!b && !!p
    && JSON.stringify(p.mapKeyFields) === JSON.stringify(b.leftOn)
    && JSON.stringify(p.outputs) === JSON.stringify(b.rightOn);
}

/** Lossless candidate id namespace, distinct from the Basic run id. */
export function advancedCandidateId(runId: string, targetId: string): string {
  return JSON.stringify([runId, targetId]);
}

/** Build lossless live-field enrichment from the verified snapshot. The Host
 * retrieval already ran against these exact rows; we only attach actual fields,
 * identity, occurrences and per-source candidate scores. */
function buildEnrichment(snapshot: MatchingJoinSnapshot): TrialEnrichment {
  const sourceValuesByKey: TrialEnrichment["sourceValuesByKey"] = {};
  for (const row of snapshot.acquisition.sourceRows) {
    sourceValuesByKey[mapKeyToken(row.mapKey)] = { ...row.fields };
  }
  const targetByTargetId: TrialEnrichment["targetByTargetId"] = {};
  for (const row of snapshot.acquisition.targetRows) {
    targetByTargetId[row.targetId] = {
      outputValues: [...row.outputValues],
      identityParts: [...row.identityValues],
      occurrences: row.occurrences,
      fields: { id: row.targetId, ...row.fields },
    };
  }
  // Host retrieval allowlists are already candidate ids (verified against the
  // acquisition registry). The shared projection consumes candidate ids directly.
  const allowlistByProposal: TrialEnrichment["allowlistByProposal"] = {};
  for (const [proposalId, cids] of Object.entries(snapshot.retrieval.llmCandidateIdsByProposal)) {
    allowlistByProposal[proposalId] = [...cids];
  }
  return {
    sourceValuesByKey,
    targetByTargetId,
    scoresByProposal: snapshot.retrieval.candidateScoresByProposal,
    allowlistByProposal,
  };
}

/** Lossless adapter: Host snapshot → shared review session (Advanced).
 * Reuses the shared runTrial projection (one engine, no renderer scorer); the
 * enrichment supplies the verified actual fields and per-source scores. */
export function adaptAdvancedSnapshot(
  session: MatchingTabSession,
  snapshot: MatchingJoinSnapshot,
): MatchingTabSession {
  const binding = session.joinBinding;
  if (!binding || !session.plan || !session.lensCtx) {
    throw new Error("Advanced requires an original JOIN binding and captured Lens context.");
  }
  // The Host already guarded the ordered JOIN keys → outputs shape; re-assert here
  // so a mismatched adapter never installs a foreign binding.
  if (JSON.stringify(snapshot.plan.mapKeyFields) !== JSON.stringify(binding.leftOn)
    || JSON.stringify(snapshot.plan.outputs) !== JSON.stringify(binding.rightOn)
    || snapshot.plan.targetRef !== binding.rightQueryId) {
    throw new Error("Advanced snapshot does not match the original JOIN binding.");
  }
  const installed = installMatchingRetrieval(session, snapshot.retrieval, buildEnrichment(snapshot));
  const complete = snapshot.acquisition.complete;
  const totalRight = snapshot.acquisition.targetRows.length;
  const sourceRowsByKey = new Map(snapshot.acquisition.sourceRows.map((r) => [mapKeyToken(r.mapKey), r] as const));
  const proposals: MatchingProposalView[] = installed.proposals.map((p) => {
    const src = sourceRowsByKey.get(mapKeyToken(p.mapKey));
    const scored = p.edges?.length ?? 0;
    // The Host shortlist reports the proposed candidate separately from its
    // alternatives. The shared ledger requires the proposed candidate to be
    // selectable (alternative-inclusion guard), so include it losslessly first.
    const alternativeCandidateIds = p.proposedCandidateId
      ? [p.proposedCandidateId, ...p.alternativeCandidateIds.filter((id) => id !== p.proposedCandidateId)]
      : p.alternativeCandidateIds;
    return {
      ...p,
      alternativeCandidateIds,
      affectedSourceRows: src?.affectedSourceRows ?? p.affectedSourceRows,
      searchIncomplete: !complete || p.searchIncomplete,
      evidence: [
        ...p.evidence,
        {
          field: "scope",
          note: "Actual bounded JOIN fields. Scores are contextual similarity, not probabilities. Verified live — not a fixture.",
        },
      ],
      coverage: {
        sourceTotal: null,
        sourceRetrieved: snapshot.acquisition.sourceRows.length,
        sourceTruncated: false,
        rightTotal: totalRight,
        rightRetrieved: totalRight,
        rightTruncated: !complete,
        competitorsScored: scored,
        competitorsUnknown: Math.max(0, totalRight - scored),
        shortlistOmitted: Math.max(0, totalRight - scored),
        promptOmitted: undefined,
      },
      runId: snapshot.runId,
    };
  });
  const candidates: MatchingCandidateView[] = installed.candidates.map((c) => ({ ...c, runId: snapshot.runId }));
  const m = snapshot.retrieval.metrics;
  const runMode: "trial" | "mass" = m.mode === "mass" ? "mass" : "trial";
  return {
    ...installed,
    candidates,
    proposals,
    basicRun: undefined,
    matchingMode: "advanced",
    advancedRun: {
      id: snapshot.runId,
      evidenceRevision: snapshot.evidenceRevision,
      snapshot: structuredClone(snapshot),
      request: {
        mode: runMode,
        scope: snapshot.acquisition.scope,
        sourceParts: undefined,
        allowExpand: false,
        llmBudgetRemaining: 0,
      },
    },
    advancedSettings: { expand: false, rank: false },
    decisions: [],
    mapBaseline: [],
    mapLive: [],
    hasUnsavedDecisions: false,
    commitLifecycle: undefined,
  };
}

/** Current execution context supplied by the App for the immutable binding. */
export type AdvancedExecutionContext = {
  workspace: MatchingAcquireJoinArgs["workspace"];
  connections: MatchingAcquireJoinArgs["connections"];
  sources: MatchingAcquireJoinArgs["sources"];
  projectFile?: string;
  projectUid?: string;
  references?: MatchingAcquireJoinArgs["references"];
  connectionBindings?: MatchingAcquireJoinArgs["connectionBindings"];
  executionEngine?: MatchingAcquireJoinArgs["executionEngine"];
};

function advancedPlanToWire(plan: MatchingPlanDraft, targetRef: string) {
  return {
    sourceRef: plan.sourceRef,
    targetRef,
    mapKeyFields: [...plan.mapKeyFields],
    targetIdentityFields: [...plan.targetIdentityFields],
    comparisons: plan.comparisons.map((c) => ({ sourceField: c.sourceField, targetField: c.targetField, role: c.role })),
    normalization: [...plan.normalization],
    outputs: [...plan.outputs],
    ambiguity: plan.ambiguity,
    scope: plan.scope,
    semanticRevision: plan.semanticRevision,
    uiRevision: plan.uiRevision,
  };
}

/** Build the immutable JOIN acquisition identity (runId / evidence revision).
 * Host requires runId = "<sessionId>:<non-empty>". */
export function advancedRunIdentity(session: MatchingTabSession): { runId: string; evidenceRevision: number } {
  return {
    runId: `${session.id}:${session.generation + 1}:${Date.now()}`,
    evidenceRevision: 1,
  };
}

/** ADR-0051: explicit Advanced live run. Immutable JOIN binding acquisition
 * with the current execution context; the Host already runs matching_retrieve
 * inside acquisition — no second engine, no fixture fallback. */
export async function runAdvancedMatching(
  session: MatchingTabSession,
  ctx: {
    execution: AdvancedExecutionContext;
    targetRef: string;
    isContextCurrent: (session: MatchingTabSession) => boolean;
    acquire: (args: MatchingAcquireJoinArgs) => Promise<MatchingJoinSnapshot>;
    latest: () => MatchingTabSession | undefined;
  },
): Promise<MatchingTabSession> {
  const b = session.joinBinding, plan = session.plan;
  if (!advancedPlanCompatible(session) || !plan) throw new Error("Advanced requires a confirmed plan that retains the original JOIN keys/outputs.");
  if (!ctx.isContextCurrent(session)) throw new Error("Original JOIN context changed. Reopen Find Matches.");
  if (session.commitLifecycle?.status === "pending" || session.commitLifecycle?.status === "stale") throw new Error("Matching review is locked or stale. Reopen Find Matches.");
  if (session.hasUnsavedDecisions) throw new Error("Review decisions are still dirty. Undo or finish this review before re-running the plan.");
  // Neither a cohort definition nor an immutable selected source tuple is captured
  // by this session. Never reinterpret either label as all/unmatched source keys.
  if (session.scope !== "full" || plan.scope !== "full") {
    throw new Error("Advanced selected/cohort scope is unsupported: no exact selected tuple or cohort is bound to this session. No rows were acquired; full scope was not substituted.");
  }
  const revision = advancedReviewRevision(session);
  const { runId, evidenceRevision } = advancedRunIdentity(session);
  const request: MatchingAcquireJoinArgs = {
    workspace: ctx.execution.workspace, connections: ctx.execution.connections, sources: ctx.execution.sources,
    projectFile: ctx.execution.projectFile, projectUid: ctx.execution.projectUid,
    references: ctx.execution.references ?? [], connectionBindings: ctx.execution.connectionBindings ?? [],
    executionEngine: ctx.execution.executionEngine,
    queryId: b!.hostQueryId, joinIndex: b!.joinStepIndex, sessionId: session.id,
    runId, evidenceRevision,
    plan: advancedPlanToWire(plan, ctx.targetRef),
    mode: "trial", scope: "all", allowExpand: true, llmBudgetRemaining: MATCHING_CAPS.maxLlmCallsPerRun,
  };
  const snapshot = await ctx.acquire(request);
  const latest = ctx.latest();
  if (!latest || advancedReviewRevision(latest) !== revision
    || latest.commitLifecycle?.status === "pending" || latest.commitLifecycle?.status === "stale"
    || latest.hasUnsavedDecisions || !ctx.isContextCurrent(latest)) {
    throw new Error("Matching context changed while retrieving. No evidence was installed.");
  }
  if (snapshot.sessionId !== session.id || snapshot.runId !== runId || snapshot.evidenceRevision !== evidenceRevision
    || snapshot.plan.semanticRevision !== plan.semanticRevision || snapshot.plan.scope !== plan.scope
    || snapshot.acquisition.queryId !== b!.hostQueryId || snapshot.acquisition.joinIndex !== b!.joinStepIndex
    || snapshot.acquisition.scope !== request.scope) {
    throw new Error("Advanced retrieval returned evidence for a different session, run or scope. No evidence was installed.");
  }
  return adaptAdvancedSnapshot(latest, snapshot);
}

/** Explicit Advanced invalidation: a JOIN change clears old evidence and
 * decisions. It never reinterprets them; an explicit validated refresh may
 * rebind and clear/revalidate. Display-only state is retained. */
export function invalidateAdvancedOnJoinChange(
  session: MatchingTabSession,
  reason: string,
): MatchingTabSession {
  if (!session.advancedRun) return session;
  return {
    ...session,
    matchingMode: undefined,
    advancedRun: undefined,
    proposals: [],
    candidates: [],
    decisions: [],
    hasUnsavedDecisions: false,
    selectedProposalId: null,
    commitLifecycle: { status: "stale", reason },
    generation: session.generation + 1,
  };
}

/** Explicit semantic-plan invalidation across producers: both producer runs,
 * decisions and evidence are cleared; display-only plan state (including the
 * confirmed Advanced mode) is retained and an explicit Find-matches re-run is
 * required. Disclosure alone never re-runs. Display (uiRevision-only) changes
 * never reach here. */
export function invalidateRunOnPlanChange(session: MatchingTabSession): MatchingTabSession {
  if (!sessionRun(session) && !session.matchingMode) return session;
  return {
    ...session,
    basicRun: undefined,
    advancedRun: undefined,
    proposals: [],
    candidates: [],
    decisions: [],
    hasUnsavedDecisions: false,
    selectedProposalId: null,
    generation: session.generation + 1,
  };
}

/** Advanced alias retained for callers that only care about the Advanced run. */
export function invalidateAdvancedOnPlanChange(session: MatchingTabSession): MatchingTabSession {
  return invalidateRunOnPlanChange(session);
}

/** Sticky local-definition invalidation for Advanced; returning to an old
 * definition is not a refresh. Mirrors Basic reconciliation. */
export function reconcileAdvancedContext(
  session: MatchingTabSession,
  identity: string,
  fingerprint: string,
  ownReceipt?: TupleBatchCommitReceipt,
): MatchingTabSession {
  // This also guards an acknowledged summary after its producer run is cleared.
  // Preserve stale evidence for inspection, just as the App's shared reconciler
  // does; returning to the old definition must not restore write authority.
  return reconcileBasicContext(session, identity, fingerprint, ownReceipt);
}

/** Collect Advanced decisions eligible for the atomic verified write. Reuse the
 * exact ordered LEFT keys → RIGHT outputs tuple shape. */
export function collectAdvancedDecisions(
  session: MatchingTabSession,
): { error: string } | { sourceParts: string[]; outputValues: string[]; candidateId: string }[] {
  const binding = session.joinBinding;
  const run = session.advancedRun;
  if (session.commitLifecycle?.status === "stale") return { error: "Stale Matching review cannot be written. Reopen Find Matches." };
  if (!binding || !run || !session.plan) return { error: "Missing original JOIN run or advanced session." };
  if (session.scope !== "full" || session.plan.scope !== "full" || run.snapshot.plan.scope !== "full")
    return { error: "Advanced selected/cohort scope is unsupported. Retrieve and review an explicitly full-scope session before writing." };
  const result: { sourceParts: string[]; outputValues: string[]; candidateId: string }[] = [];
  const seen = new Set<string>();
  for (const d of session.decisions) {
    if (!["confirm_proposed", "choose_alternative"].includes(d.kind)) continue;
    const p = session.proposals.find((p) => p.proposalId === d.proposalId);
    const c = session.candidates.find((c) => c.candidateId === d.candidateId);
    if (!p || !c || seen.has(mapKeyToken(d.mapKey)) || mapKeyToken(d.mapKey) !== mapKeyToken(p.mapKey)
      || d.expectedRunId !== run.id || d.expectedEvidenceRevision !== p.evidenceRevision
      || d.expectedSemanticRevision !== session.plan.semanticRevision || c.runId !== run.id
      || !p.alternativeCandidateIds.includes(c.candidateId)) return { error: "Stale, missing or conflicting advanced decision." };
    try {
      const sourceParts = requireStringTuple(d.mapKey);
      const outputValues = requireStringTuple(c.outputValues);
      if (sourceParts.length !== binding.leftOn.length || outputValues.length !== binding.rightOn.length)
        return { error: "Advanced decision does not match the original JOIN key/output arity." };
      seen.add(mapKeyToken(d.mapKey));
      result.push({ sourceParts, outputValues, candidateId: d.candidateId! });
    } catch (e) {
      return { error: `Advanced decision cannot be written: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return result;
}

/** ADR-0051: verified Advanced write. Verification is an Advanced Host
 * reacquisition (never the Basic fuzzy verifier), reusing the session's atomic
 * write planner / receipt / ack supplied by the App. */
export async function commitAdvancedMatching(
  session: MatchingTabSession,
  ctx: {
    execution: AdvancedExecutionContext;
    isContextCurrent: (session: MatchingTabSession) => boolean;
    verify: (args: MatchingAcquireJoinArgs & {
      verification: {
        expectedSemanticRevision: number;
        expectedSnapshot: MatchingJoinSnapshot;
        decisions: { candidateId: string; sourceParts: string[]; outputValues: string[]; runId: string; evidenceRevision: number }[];
      };
    }) => Promise<MatchingJoinVerified>;
    /** App atomic write: returns the reducer-acknowledged receipt + new binding. */
    write: (session: MatchingTabSession, materialized: { sourceParts: string[]; outputValues: string[] }[]) => Promise<{
      result: "applied" | "error";
      message: string;
      receipt?: TupleBatchCommitReceipt;
    }>;
    /** Post-write identity of the committed context (from the receipt). */
    identity: () => string;
    fingerprint: () => string;
    navigationTarget: () => JoinNavigationTarget | null;
    latest: () => MatchingTabSession | undefined;
  },
): Promise<{ status: "saved" | "refused" | "error"; message: string; session?: MatchingTabSession }> {
  const refused = (message: string) => ({ status: "refused" as const, message });
  const b = session.joinBinding, run = session.advancedRun;
  if (!b || !run || !session.plan || !session.lensCtx) return refused("Original JOIN or write context is unavailable. Reopen Find Matches.");
  if (!ctx.isContextCurrent(session)) return refused("Original JOIN or write context is unavailable. Reopen Find Matches.");
  const selections = collectAdvancedDecisions(session);
  if ("error" in selections) return refused(selections.error);
  if (!selections.length) return refused("Confirm at least one complete tuple first.");
  const revision = advancedReviewRevision(session);
  // Mark pending so the shared UI freezes this session during the write.
  // The App applies this via onChange before awaiting (see App wiring).
  // Verification reacquires with the FROZEN acquisition input (the snapshot's
  // plan/mode/scope), not the current UI plan — a UI-only revision may differ.
  const snapshot = run.snapshot;
  const snapshotMode: "trial" | "mass" = snapshot.retrieval.metrics.mode === "mass" ? "mass" : "trial";
  const request: MatchingAcquireJoinArgs = {
    workspace: ctx.execution.workspace, connections: ctx.execution.connections, sources: ctx.execution.sources,
    projectFile: ctx.execution.projectFile, projectUid: ctx.execution.projectUid,
    references: ctx.execution.references ?? [], connectionBindings: ctx.execution.connectionBindings ?? [],
    executionEngine: ctx.execution.executionEngine,
    queryId: b.hostQueryId, joinIndex: b.joinStepIndex, sessionId: session.id,
    runId: snapshot.runId, evidenceRevision: snapshot.evidenceRevision,
    plan: snapshot.plan,
    mode: snapshotMode, scope: snapshot.acquisition.scope,
    allowExpand: false, llmBudgetRemaining: MATCHING_CAPS.maxLlmCallsPerRun,
  };
  const verified = await ctx.verify({ ...request,
    verification: { expectedSemanticRevision: snapshot.plan.semanticRevision, expectedSnapshot: snapshot,
      decisions: selections.map((d) => ({ candidateId: d.candidateId, sourceParts: d.sourceParts, outputValues: d.outputValues, runId: run.id, evidenceRevision: run.evidenceRevision })) } });
  const latest = ctx.latest();
  if (!latest || advancedReviewRevision(latest) !== revision || latest.commitLifecycle?.status !== "pending"
    || latest.commitLifecycle.runId !== run.id || !ctx.isContextCurrent(latest) || verified.sessionId !== session.id || verified.runId !== run.id
    || verified.evidenceRevision !== run.evidenceRevision || verified.materialized.length !== selections.length
    || selections.some(d => verified.materialized.filter(v => v.candidateId === d.candidateId
      && mapKeyToken(v.sourceParts) === mapKeyToken(d.sourceParts)
      && mapKeyToken(v.outputValues) === mapKeyToken(d.outputValues)).length !== 1))
    return refused("Context changed during live verification. Draft retained.");
  const written = await ctx.write(latest, verified.materialized.map((v) => ({ sourceParts: v.sourceParts, outputValues: v.outputValues })));
  if (written.result !== "applied" || !written.receipt) return { status: written.result === "error" ? "error" : "refused", message: written.message };
  const after = ctx.latest();
  if (!after) return refused("Matching session was closed before acknowledgement. Inspect the project.");
  if (advancedReviewRevision(after) !== revision)
    return refused("Matching review changed before acknowledgement. Inspect the project; the current draft was not cleared.");
  const acknowledged = acknowledgeAdvancedReceipt(after, written.receipt, ctx.identity(), ctx.fingerprint(), ctx.navigationTarget());
  if ("error" in acknowledged) return refused(acknowledged.error);
  return { status: "saved", message: `Applied ${written.receipt.appliedCount} complete tuple mappings. Save the project file separately.`, session: acknowledged };
}

/** Acknowledge a successful Advanced atomic write: update the bound JOIN index
 * from the receipt, clear old actionable decisions, wait for an explicit
 * Refresh. Preserves the receipt across its exact committed-context transition. */
export function acknowledgeAdvancedReceipt(
  session: MatchingTabSession,
  receipt: TupleBatchCommitReceipt,
  identity: string,
  fingerprint: string,
  navigationTarget: JoinNavigationTarget | null,
): MatchingTabSession | { error: string } {
  const b = session.joinBinding;
  const run = session.advancedRun;
  if (
    !b ||
    !run ||
    !matchingReceiptOwned(session, receipt) ||
    receipt.matchingSessionId !== session.id ||
    receipt.matchingRunId !== run.id ||
    receipt.projectIdentity !== b.projectIdentity ||
    identity !== receipt.projectIdentity ||
    fingerprint !== receipt.contextFingerprint
  )
    return { error: "Project or Matching session changed before acknowledgement. Inspect the project and re-run the confirmed plan." };
  return {
    ...session,
    joinBinding: { ...b, contextFingerprint: receipt.contextFingerprint, joinStepIndex: receipt.joinStepIndex },
    lensCtx: session.lensCtx
      ? { ...session.lensCtx, joinStepIndex: receipt.joinStepIndex, navigationTarget }
      : undefined,
    advancedRun: undefined,
    proposals: [],
    candidates: [],
    decisions: [],
    hasUnsavedDecisions: false,
    selectedProposalId: null,
    generation: session.generation + 1,
    commitLifecycle: { status: "acknowledged", runId: run.id, receipt },
  };
}

/** The Host acquisition allowlist is candidate-id namespaced; the shared LLM
 * rank/intake pipeline is target-id namespaced (host intake validates target
 * ids). Convert losslessly; unknown ids are dropped, never invented. */
export function advancedRankAllowlist(
  session: MatchingTabSession,
): Record<string, string[]> | undefined {
  const run = session.advancedRun;
  if (!run) return undefined;
  const targetByCandidate = new Map(
    session.candidates.map((c) => [c.candidateId, c.targetId] as const),
  );
  const out: Record<string, string[]> = {};
  for (const [pid, cids] of Object.entries(run.snapshot.retrieval.llmCandidateIdsByProposal)) {
    out[pid] = cids.map((cid) => targetByCandidate.get(cid)).filter(Boolean) as string[];
  }
  return out;
}

/** Advanced confidence-bulk eligibility: reuse the Basic 0.88 cutoff / 0.03 gap
 * policy ONLY with complete scored competitors. Unknown, truncated or shortlist-
 * omitted competitors exclude the record (block, never infer). */
export function advancedHighConfidenceIds(
  session: MatchingTabSession,
  scoreCutoff: number,
  gapThreshold: number,
): string[] {
  if (!session.advancedRun || session.commitLifecycle) return [];
  const ids: string[] = [];
  for (const p of session.proposals) {
    if (p.searchIncomplete || p.userTouched || session.decisions.some(d => mapKeyToken(d.mapKey) === mapKeyToken(p.mapKey))) continue;
    const candidate = session.candidates.find(c => c.candidateId === p.proposedCandidateId);
    const binding = session.joinBinding;
    if (!binding || !candidate || p.runId !== session.advancedRun.id || candidate.runId !== p.runId
      || p.semanticPlanRevision !== session.plan?.semanticRevision
      || p.evidenceRevision !== session.advancedRun.evidenceRevision || candidate.evidenceRevision !== p.evidenceRevision
      || "error" in confirmTupleMapping([...binding.leftOn], [...binding.rightOn], p.mapKey, candidate.outputValues)) continue;
    const cov = p.coverage;
    if (!cov) continue;
    if (cov.rightTruncated) continue;
    if (cov.competitorsUnknown > 0) continue;
    if (cov.competitorsScored < 1) continue;
    if ((p.edges ?? []).some(e => e.score === null || !Number.isFinite(e.score)
      || e.score < 0 || e.score > 1 || e.origins.some(o => o === "manual" || o === "llm"))) continue;
    const best = [...(p.edges ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    if (best?.candidateId !== candidate.candidateId) continue;
    const scores = (p.edges ?? [])
      .map((e) => e.score)
      .filter((s): s is number => s !== null)
      .sort((a, b) => b - a);
    // Honest: every counted competitor must be present with an actual score.
    if (scores.length < cov.competitorsScored) continue;
    const top = scores[0];
    const second = scores.length > 1 ? scores[1] : null;
    if (top < scoreCutoff) continue;
    const gap = second === null ? gapThreshold : top - second;
    if (gap < gapThreshold) continue;
    ids.push(p.proposalId);
  }
  return ids;
}
