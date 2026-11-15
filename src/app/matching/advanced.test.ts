/** ADR-0051 Advanced producer adapter, orchestration, invalidation and commit. */
import assert from "node:assert/strict";
import type { MatchingJoinSnapshot, MatchingRetrieveResult } from "../../lib/bridge";
import type { TupleBatchCommitReceipt } from "../../lib/joinLensBatchCommit";
import {
  adaptAdvancedSnapshot,
  advancedHighConfidenceIds,
  advancedPlanCompatible,
  advancedRankAllowlist,
  advancedRunIdentity,
  acknowledgeAdvancedReceipt,
  collectAdvancedDecisions,
  lookupAdvancedMatching,
  commitAdvancedMatching,
  invalidateAdvancedOnJoinChange,
  invalidateRunOnPlanChange,
  reconcileAdvancedContext,
  runAdvancedMatching,
  sessionRun,
} from "./advanced";
import { basicPlanCompatible, adaptBasicReport, reconcileBasicContext, acknowledgeBasicReceipt } from "./basic";
import { applyBulkConfirm, applyDecision, previewBulkConfirm, undoMatchingBulk, confirmReviewedSelection } from "./reviewLogic";
import { buildLensMatchingPlan } from "./planDefaults";
import { emptyMatchingSession, type MatchingTabSession } from "./types";

const left = ["vendor_name", "region"];
const right = ["vendor_name", "region"];

/** A Basic-shaped plan (the Find Matches default). */
function basicPlan() {
  return buildLensMatchingPlan({ leftOn: left, rightOn: right, sourceRef: "fact", targetRef: "dim", targetColumns: ["id", ...right], scope: "cohort" });
}
/** An Advanced-shaped plan: same locked key/output, different comparison roles. */
function advancedPlan(rev = 2) {
  const p = basicPlan();
  p.scope = "full";
  p.comparisons = [{ sourceField: "vendor_name", targetField: "vendor_name", role: "soft_signal" }, { sourceField: "region", targetField: "region", role: "hard_constraint" }];
  p.normalization = ["trim"];
  p.semanticRevision = rev;
  return p;
}
function boundSession(plan = basicPlan()): MatchingTabSession {
  return emptyMatchingSession({
    id: "adv-test", title: "Advanced", entry: "lens", scope: plan.scope, instructionText: "match names",
    hasUnsavedDecisions: false, chatCollapsed: true,
    joinBinding: { projectIdentity: "project:0", contextFingerprint: "local", hostQueryId: "fact", joinStepIndex: 1,
      leftOn: left, rightOn: right, rightQueryId: "dim" },
    lensCtx: { hostQueryId: "fact", joinStepIndex: 1, leftOn: left, rightOn: right, rightQueryId: "dim",
      sourceColumns: ["vendor_name", "region"], targetColumns: ["id", ...right] },
    queryOptions: ["fact", "dim"],
    plan,
  });
}
function retrieval(): MatchingRetrieveResult {
  return {
    candidates: [
      { candidateId: "cand:t1", sessionId: "adv-test", targetId: "t1", outputValues: ["Acme Inc", "United States"], evidenceRevision: 1 },
      { candidateId: "cand:t2", sessionId: "adv-test", targetId: "t2", outputValues: ["Widget", "Germany"], evidenceRevision: 1 },
    ],
    proposals: [{ proposalId: "prop:0", sessionId: "adv-test", mapKey: ["Acme", "US"], affectedSourceRows: 3,
      proposedCandidateId: "cand:t1", alternativeCandidateIds: ["cand:t2"],
      state: "proposed", provenance: "fuzzy", semanticPlanRevision: 2, evidenceRevision: 1 }],
    metrics: { mode: "trial", keysRequested: 1, keysProcessed: 1, keysUnprocessed: 0, candidatesScored: 2,
      llmCalls: 0, llmRetries: 0, durationMs: 5, stopReason: "complete",
      keyCap: 20, shortlistPerKey: 40, llmPerKey: 10, maxLlmCalls: 220, localUniverse: 10000 },
    llmCandidateIdsByProposal: { "prop:0": ["cand:t1", "cand:t2"] },
    candidateScoresByProposal: { "prop:0": [
      { candidateId: "cand:t1", score: .95, fieldScores: [.9, .95] },
      { candidateId: "cand:t2", score: .4, fieldScores: [.4, .4] }] },
  };
}
function snapshot(planRev = 2): MatchingJoinSnapshot {
  const plan = advancedPlan(planRev);
  return {
    sessionId: "adv-test", runId: "adv-test:1", evidenceRevision: 1, plan,
    acquisition: { queryId: "fact", joinIndex: 1, rightQueryId: "dim", scope: "all",
      sourceFields: ["vendor_name", "region"], targetFields: ["id", "vendor_name", "region"],
      sourceRows: [{ mapKey: ["Acme", "US"], fields: { vendor_name: "Acme", region: "US" }, affectedSourceRows: 3 }],
      targetRows: [
        { targetId: "t1", identityValues: ["id-1"], fields: { id: "id-1", vendor_name: "Acme Inc", region: "United States" }, outputValues: ["Acme Inc", "United States"], occurrences: 2 },
        { targetId: "t2", identityValues: ["id-2"], fields: { id: "id-2", vendor_name: "Widget", region: "Germany" }, outputValues: ["Widget", "Germany"], occurrences: 1 }],
      sourceKeyCap: 20, targetRowCap: 10000, targetOccurrences: 3, complete: true },
    retrieval: retrieval(),
  };
}

// ── Shape gates ─────────────────────────────────────────────────────────────
{
  const s = boundSession(advancedPlan());
  assert.ok(basicPlanCompatible(boundSession(basicPlan())), "default lens plan is Basic-compatible");
  assert.ok(!basicPlanCompatible(s), "role/normalization edits are not Basic form");
  assert.ok(advancedPlanCompatible(s), "edited plan retains the JOIN key/output shape");
  assert.ok(!advancedPlanCompatible({ ...s, plan: { ...s.plan!, outputs: ["only_name"] } }), "outputs are locked to the JOIN");
  assert.ok(!advancedPlanCompatible({ ...s, plan: { ...s.plan!, mapKeyFields: ["region", "vendor_name"] } }), "keys are ordered and locked");
  assert.ok(sessionRun(s) === undefined);
}

// ── Lossless adapter ────────────────────────────────────────────────────────
const adapted = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
// Manual lookup is evidence only. Late replies cannot enter a changed review,
// project ABA or closed session, and frozen source/page identity is checked.
for (const change of ["none", "decision", "stale", "closed", "plan", "source-reply", "run-reply"] as const) {
  let latest: MatchingTabSession | undefined = structuredClone(adapted);
  const pending = lookupAdvancedMatching(latest, "prop:0", { text: "Widget", offset: 0 }, {
    execution: {} as never, latest: () => latest, isContextCurrent: s => s.commitLifecycle?.status !== "stale",
    lookup: async args => {
      assert.deepEqual(args.lookup.sourceParts, ["Acme", "US"]);
      assert.deepEqual(args.lookup.page, { text: "Widget", offset: 0 });
      if (change === "decision") latest = applyDecision(latest!, "prop:0", "defer", null);
      if (change === "stale") latest = { ...latest!, commitLifecycle: { status: "stale", reason: "ABA" } };
      if (change === "closed") latest = undefined;
      if (change === "plan") latest = invalidateRunOnPlanChange(latest!);
      return { sessionId: adapted.id, runId: change === "run-reply" ? "foreign" : adapted.advancedRun!.id,
        evidenceRevision: 1, sourceParts: change === "source-reply" ? ["foreign"] : ["Acme", "US"],
        page: { offset: args.lookup.page.offset, text: args.lookup.page.text }, total: 0, pageSize: 20, universeCount: 2, universeCap: 10000, candidates: [] };
    },
  });
  if (change === "none") {
    assert.equal((await pending).total, 0);
    assert.deepEqual(latest!.decisions, [], "lookup never confirms or mutates ledger");
  } else await assert.rejects(pending, /context changed/);
}
{
  assert.equal(adapted.matchingMode, "advanced");
  assert.ok(adapted.advancedRun && adapted.advancedRun.id === "adv-test:1");
  assert.equal(adapted.basicRun, undefined, "the producer run is exclusive");
  assert.equal(adapted.decisions.length, 0, "acquisition never confirms");
  assert.equal(adapted.hasUnsavedDecisions, false);
  assert.equal(adapted.advancedRun!.request.allowExpand, false, "frozen acquisition input");
  assert.equal(adapted.advancedRun!.request.llmBudgetRemaining, 0);
  const p = adapted.proposals[0]!;
  assert.deepEqual(p.mapKey, ["Acme", "US"]);
  assert.equal(p.proposedCandidateId, "cand:t1");
  assert.deepEqual(p.alternativeCandidateIds, ["cand:t1", "cand:t2"], "proposed candidate stays selectable in the ledger");
  assert.equal(p.affectedSourceRows, 3);
  assert.equal(p.evidenceRevision, 1);
  assert.equal(p.runId, "adv-test:1");
  assert.equal(p.edges?.length, 2, "per-source candidate scores preserved");
  assert.equal(p.edges?.[0]?.metric, "contextual");
  assert.equal(p.edges?.[0]?.score, .95);
  assert.deepEqual(p.edges?.[0]?.fieldScores, [.9, .95]);
  assert.equal(p.coverage?.competitorsScored, 2);
  assert.equal(p.coverage?.competitorsUnknown, 0);
  assert.equal(p.coverage?.rightTruncated, false);
  assert.equal(p.searchIncomplete, false);
  const t1 = adapted.candidates.find((c) => c.candidateId === "cand:t1")!;
  assert.deepEqual(t1.outputValues, ["Acme Inc", "United States"]);
  assert.deepEqual(t1.identityParts, ["id-1"]);
  assert.equal(t1.occurrences, 2);
  assert.deepEqual(t1.fields, { id: "id-1", vendor_name: "Acme Inc", region: "United States" });
  assert.equal(t1.runId, "adv-test:1");
}
assert.throws(() => adaptAdvancedSnapshot(boundSession(advancedPlan()), { ...snapshot(), plan: { ...snapshot().plan, outputs: ["only_name"] } }),
  /does not match the original JOIN binding/);

// ── Run orchestration ───────────────────────────────────────────────────────
{
  const s = boundSession(advancedPlan());
  let acquired: MatchingJoinSnapshot | undefined;
  const run = async () => runAdvancedMatching(s, {
    execution: {} as never,
    targetRef: "dim",
    isContextCurrent: () => true,
    acquire: async (args) => {
      assert.equal(args.queryId, "fact");
      assert.equal(args.joinIndex, 1);
      assert.equal(args.sessionId, "adv-test");
      assert.equal(args.plan.sourceRef, "fact");
      assert.deepEqual(args.plan.mapKeyFields, left);
      assert.deepEqual(args.plan.outputs, right);
      assert.equal(args.plan.scope, "full");
      assert.equal(args.scope, "all");
      acquired = { ...snapshot(), runId: args.runId };
      return acquired;
    },
    latest: () => s,
  });
  const out = await run();
  assert.equal(out.advancedRun!.request.allowExpand, true, "lookup/commit replay actual initial expansion policy");
  assert.equal(out.advancedRun!.request.llmBudgetRemaining, 220, "lookup/commit replay actual run budget");
  assert.equal(out.advancedRun?.id, acquired!.runId);
  assert.equal(out.matchingMode, "advanced");
  // Stale generation after acquisition refuses the install.
  await assert.rejects(runAdvancedMatching(s, {
    execution: {} as never, targetRef: "dim", isContextCurrent: () => true,
    acquire: async () => acquired!, latest: () => ({ ...s, generation: s.generation + 1 }),
  }), /context changed while retrieving/i);
  // Dirty review blocks a re-run.
  await assert.rejects(runAdvancedMatching({ ...s, hasUnsavedDecisions: true }, {
    execution: {} as never, targetRef: "dim", isContextCurrent: () => true,
    acquire: async () => snapshot(), latest: () => s,
  }), /decisions are still dirty/i);
  // Context drift blocks acquisition.
  await assert.rejects(runAdvancedMatching(s, {
    execution: {} as never, targetRef: "dim", isContextCurrent: () => false,
    acquire: async () => snapshot(), latest: () => s,
  }), /context changed/i);
  // A shape that drops the original JOIN outputs is not a confirmed Advanced plan.
  const broken = { ...s, plan: { ...advancedPlan(), outputs: ["region"] } };
  await assert.rejects(runAdvancedMatching(broken, {
    execution: {} as never, targetRef: "dim", isContextCurrent: () => true,
    acquire: async () => snapshot(), latest: () => s,
  }), /confirmed plan/i);
  const id = advancedRunIdentity(s);
  assert.match(id.runId, /^adv-test:\d+:\d+$/);
  assert.equal(id.evidenceRevision, 1);
}

// ── Explicit invalidation ───────────────────────────────────────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  const decided = applyDecision(s, s.proposals[0]!.proposalId, "confirm_proposed", "cand:t2");
  assert.equal(decided.decisions.length, 1);
  const cleared = invalidateRunOnPlanChange(decided);
  assert.equal(cleared.basicRun, undefined);
  assert.equal(cleared.advancedRun, undefined);
  assert.deepEqual(cleared.proposals, []);
  assert.deepEqual(cleared.decisions, []);
  assert.equal(cleared.hasUnsavedDecisions, false);
  assert.equal(cleared.matchingMode, "advanced", "confirmed mode is display state, not cleared evidence");
  assert.notEqual(cleared.generation, s.generation);
  assert.ok(advancedPlanCompatible(cleared), "plan shape is retained after invalidation");
  // No run, no mode → the helper is a no-op (structurally identical).
  const untouched = boundSession(advancedPlan());
  assert.deepEqual(invalidateRunOnPlanChange(untouched), untouched);
  // JOIN change: stale lifecycle, sticky, draft retained for inspection.
  const stale = invalidateAdvancedOnJoinChange(decided, "join changed");
  assert.equal(stale.commitLifecycle?.status, "stale");
  assert.equal(stale.advancedRun, undefined);
  assert.deepEqual(stale.decisions, []);
  const noRun = boundSession(advancedPlan());
  assert.deepEqual(invalidateAdvancedOnJoinChange(noRun, "x"), noRun, "no Advanced run → JOIN change is a no-op");
}

// ── Reconciliation (sticky local-definition invalidation) ──────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  assert.equal(reconcileAdvancedContext(s, "project:0", "local"), s, "unchanged context stays valid");
  const stale = reconcileAdvancedContext(s, "project:0", "changed");
  assert.equal(stale.commitLifecycle?.status, "stale");
  assert.equal(stale.advancedRun, s.advancedRun, "stale evidence remains inspectable, not actionable");
  // Own receipt transition is permitted (pending + exact receipt context).
  const receipt: TupleBatchCommitReceipt = { status: "applied", contextFingerprint: "next", projectIdentity: "project:0",
    joinStepIndex: 3, appliedCount: 1, matchingSessionId: "adv-test", matchingRunId: "adv-test:1" };
  const reviewed = applyDecision(s, s.proposals[0]!.proposalId, "confirm_proposed", "cand:t1");
  const pending = { ...reviewed, commitLifecycle: { status: "pending" as const, runId: "adv-test:1" } };
  const kept = reconcileAdvancedContext(pending, "project:0", "next", receipt);
  assert.equal(kept.commitLifecycle?.status, "pending", "own receipt transition is never invalidated");
  const lost = reconcileAdvancedContext(pending, "project:0", "other", receipt);
  assert.equal(lost.commitLifecycle?.status, "stale");
  // Basic reconciliation stays independent.
  const basicSeed = boundSession(basicPlan());
  const basic = adaptBasicReport(basicSeed, {
    left_on: left, right_on: right, tuple_cap: 200, left_distinct_total: 1, left_occurrences_total: 3,
    right_distinct_total: 1, right_occurrences_total: 2, left_truncated: false, right_truncated: false,
    sources: [{ source: { parts: ["Acme", "US"], occurrences: 3 }, candidates: [{ right_index: 0, score: .95, field_scores: [.9, .95] }] }],
    right_universe: [{ parts: ["Acme Inc", "United States"], occurrences: 2 }],
  }, "basic:1");
  assert.equal(reconcileBasicContext(basic, "project:0", "local"), basic);
  assert.equal(reconcileBasicContext(basic, "project:0", "x").commitLifecycle?.status, "stale");
  const basicAck = acknowledgeBasicReceipt(
    { ...applyDecision(basic, basic.proposals[0]!.proposalId, "confirm_proposed", basic.proposals[0]!.proposedCandidateId),
      commitLifecycle: { status: "pending", runId: "basic:1" } }, receipt2("basic:1"), "project:0", "local", null);
  assert.ok(!("error" in basicAck), "Basic ack unchanged by Advanced work");
  assert.equal(basicAck.basicRun, undefined);
}
function receipt2(runId: string): TupleBatchCommitReceipt {
  return { status: "applied", contextFingerprint: "local", projectIdentity: "project:0", joinStepIndex: 1,
    appliedCount: 1, matchingSessionId: "adv-test", matchingRunId: runId };
}

// ── Confidence bulk (complete scored competitors only) ─────────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  const ids = advancedHighConfidenceIds(s, .88, .03);
  assert.deepEqual(ids, ["prop:0"], "0.95 top with 0.55 gap is eligible");
  assert.deepEqual(advancedHighConfidenceIds({ ...s, commitLifecycle: { status: "pending", runId: "adv-test:1" } }, .88, .03), []);
  const low = { ...s, proposals: s.proposals.map((p) => ({ ...p, edges: p.edges?.map((e, i) => ({ ...e, score: i === 0 ? .5 : .4 })) })) };
  assert.deepEqual(advancedHighConfidenceIds(low, .88, .03), [], "below cutoff is never inferred");
  const gap = { ...s, proposals: s.proposals.map((p) => ({ ...p, edges: p.edges?.map((e, i) => ({ ...e, score: i === 0 ? .95 : .94 })) })) };
  assert.deepEqual(advancedHighConfidenceIds(gap, .88, .03), [], "gap under 0.03 excludes");
  const unknown = { ...s, proposals: s.proposals.map((p) => ({ ...p, coverage: { ...p.coverage!, competitorsUnknown: 1, competitorsScored: 1 } })) };
  assert.deepEqual(advancedHighConfidenceIds(unknown, .88, .03), [], "unknown competitors block");
  const truncated = { ...s, proposals: s.proposals.map((p) => ({ ...p, coverage: { ...p.coverage!, rightTruncated: true } })) };
  assert.deepEqual(advancedHighConfidenceIds(truncated, .88, .03), [], "truncated universe blocks");
  const incomplete = { ...s, proposals: s.proposals.map((p) => ({ ...p, searchIncomplete: true })) };
  assert.deepEqual(advancedHighConfidenceIds(incomplete, .88, .03), [], "incomplete search blocks");

  const preview = previewBulkConfirm(s, "filter", []);
  assert.equal(preview.keyCount, 1);
  const accepted = applyBulkConfirm(s, preview);
  assert.equal(accepted.decisions.length, 1);
  assert.equal(accepted.decisions[0]?.origin, "high_confidence_bulk");
  assert.ok(accepted.decisions[0]?.bulkToken?.startsWith("bulk:"), "bulk decision carries its undo token");
  const undone = undoMatchingBulk(accepted);
  assert.equal(undone.decisions.length, 0);
  assert.deepEqual(advancedHighConfidenceIds(undone, .88, .03), [], "undo remains user-touched");
  for (const kind of ["defer", "reject", "no_suitable_target", "confirm_proposed"] as const) {
    const individual = applyDecision(s, "prop:0", kind, "cand:t1");
    assert.deepEqual(advancedHighConfidenceIds(individual, .88, .03), [], "ledger excludes every explicit decision");
    assert.deepEqual(applyBulkConfirm(individual, preview).decisions, individual.decisions,
      "old bulk preview cannot overwrite an intervening individual decision");
  }
  const unsafe = { ...s, candidates: s.candidates.map(c => ({ ...c, outputValues: [null, "US"] })) };
  assert.deepEqual(advancedHighConfidenceIds(unsafe, .88, .03), [], "unsafe tuple cannot qualify");
  const manual = { ...s, proposals: s.proposals.map(p => ({ ...p, edges: p.edges?.map(e => ({ ...e, origins: ["manual" as const] })) })) };
  assert.deepEqual(advancedHighConfidenceIds(manual, .88, .03), [], "manual evidence is not automatic confidence");
  const wrongPick = { ...s, proposals: s.proposals.map(p => ({ ...p, proposedCandidateId: "cand:t2" })) };
  assert.deepEqual(advancedHighConfidenceIds(wrongPick, .88, .03), [], "high score for another candidate cannot qualify the current suggestion");
  // Reviewed bulk confirms the displayed target (an alternative, not the proposed).
  const reviewed = confirmReviewedSelection(s, [s.proposals[0]!.proposalId]);
  assert.equal(reviewed.decisions[0]?.kind, "confirm_proposed");
  assert.equal(reviewed.decisions[0]?.candidateId, "cand:t1");
}

// ── Decision collection ─────────────────────────────────────────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  const ok = applyDecision(s, s.proposals[0]!.proposalId, "choose_alternative", "cand:t2");
  assert.deepEqual(collectAdvancedDecisions(ok), [
    { sourceParts: ["Acme", "US"], outputValues: ["Widget", "Germany"], candidateId: "cand:t2" }]);
  assert.deepEqual(collectAdvancedDecisions(s), [], "no decisions yet → empty collection (commit layer guards)");
  const staleRun = applyDecision({ ...s, advancedRun: { ...s.advancedRun!, id: "other" } }, s.proposals[0]!.proposalId, "confirm_proposed", "cand:t1");
  assert.ok("error" in collectAdvancedDecisions(staleRun));
  const nullKey = { ...ok, decisions: ok.decisions.map((d) => ({ ...d, mapKey: [null, "US"] })) };
  assert.ok("error" in collectAdvancedDecisions(nullKey), "NULL tuple parts are refused, not coerced");
}

// ── Verified atomic commit ──────────────────────────────────────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  const decided = applyDecision(s, s.proposals[0]!.proposalId, "confirm_proposed", "cand:t1");
  const pending: MatchingTabSession = { ...decided, commitLifecycle: { status: "pending", runId: "adv-test:1" } };
  const receipt: TupleBatchCommitReceipt = { status: "applied", contextFingerprint: "next", projectIdentity: "project:0",
    joinStepIndex: 2, appliedCount: 1, matchingSessionId: "adv-test", matchingRunId: "adv-test:1" };
  type VerifyArgs = { verification: {
    expectedSemanticRevision: number;
    expectedSnapshot: MatchingJoinSnapshot;
    decisions: { candidateId: string; sourceParts: string[]; outputValues: string[]; runId: string; evidenceRevision: number }[];
  } };
  let written: { sourceParts: string[]; outputValues: string[] }[] = [];
  let verifyCalls = 0;
  const ctx = {
    execution: {} as never,
    isContextCurrent: (_: MatchingTabSession) => true,
    verify: async (args: VerifyArgs) => {
      verifyCalls++;
      assert.equal(args.verification.expectedSnapshot.runId, "adv-test:1");
      assert.deepEqual(args.verification.decisions.map((d) => d.outputValues), [["Acme Inc", "United States"]]);
      return { sessionId: "adv-test", runId: "adv-test:1", evidenceRevision: 1,
        materialized: [{ sourceParts: ["Acme", "US"], outputValues: ["Acme Inc", "United States"], candidateId: "cand:t1" }] };
    },
    write: async (latest: MatchingTabSession, materialized: { sourceParts: string[]; outputValues: string[] }[]) => {
      written = materialized;
      assert.equal(latest.commitLifecycle?.status, "pending");
      return { result: "applied" as const, message: "Applied 1", receipt };
    },
    identity: () => "project:0",
    fingerprint: () => "next",
    navigationTarget: () => null,
    latest: () => pending,
  };
  const result = await commitAdvancedMatching(pending, ctx);
  assert.equal(result.status, "saved");
  assert.equal(verifyCalls, 1);
  assert.deepEqual(written, [{ sourceParts: ["Acme", "US"], outputValues: ["Acme Inc", "United States"] }]);
  const acked = result.session!;
  assert.equal(acked.commitLifecycle?.status, "acknowledged");
  assert.equal(acked.joinBinding?.joinStepIndex, 2, "JOIN index shifts from the receipt");
  assert.equal(acked.joinBinding?.contextFingerprint, "next");
  assert.equal(acked.matchingMode, "advanced", "the confirmed producer survives the receipt transition");
  assert.deepEqual(acked.decisions, []);
  assert.equal(acked.hasUnsavedDecisions, false);
  assert.ok(acked.lensCtx?.joinStepIndex === 2);

  // Context drift during verification refuses; the draft is retained.
  const drifted = await commitAdvancedMatching(pending, {
    ...ctx, verify: async () => {
      throw new Error("boom");
    },
  }).catch(() => "threw");
  assert.ok(drifted === "threw" || (drifted as { status?: string }).status === "refused");
  const refused = await commitAdvancedMatching({ ...pending, proposals: [] }, ctx);
  assert.equal(refused.status, "refused", "no confirmable decisions refuse without a write");
  const writeFailed = await commitAdvancedMatching(pending, {
    ...ctx, write: async () => ({ result: "error" as const, message: "Apply refused" }),
  });
  assert.equal(writeFailed.status, "error");
  // Acknowledgement never accepts a foreign receipt.
  assert.ok("error" in acknowledgeAdvancedReceipt(pending, { ...receipt, matchingRunId: "other" }, "project:0", "next", null));
}

// ── Rank allowlist conversion (candidate ids → target ids) ─────────────────
{
  const s = adaptAdvancedSnapshot(boundSession(advancedPlan()), snapshot());
  assert.deepEqual(advancedRankAllowlist(s), { "prop:0": ["t1", "t2"] });
  assert.equal(advancedRankAllowlist(boundSession(advancedPlan())), undefined);
  const renamed = { ...s, candidates: s.candidates.map((c) => c.candidateId === "cand:t2" ? { ...c, targetId: "gone" } : c) };
  assert.deepEqual(advancedRankAllowlist(renamed), { "prop:0": ["t1", "gone"] });
}

// Unsupported scopes never invoke acquisition, including session/plan mismatch.
{
  const s = boundSession(advancedPlan());
  let calls = 0;
  for (const scope of ["selected", "cohort"] as const) {
    for (const restricted of [{ ...s, scope }, { ...s, plan: { ...s.plan!, scope } }]) {
      await assert.rejects(runAdvancedMatching(restricted, {
        execution: {} as never, targetRef: "dim", isContextCurrent: () => true,
        acquire: async () => { calls++; return snapshot(); }, latest: () => restricted,
      }), /selected\/cohort scope is unsupported/);
    }
  }
  assert.equal(calls, 0, "unsupported scope must not read the broader dataset");
}

// Delayed retrieval consults latest semantic ownership, not only generation.
{
  const s = boundSession(advancedPlan());
  const ctx = {
    execution: {} as never, targetRef: "dim", isContextCurrent: () => true,
    acquire: async (args: { runId: string }) => ({ ...snapshot(), runId: args.runId }),
    latest: () => s,
  };
  for (const latest of [
    { ...s, plan: { ...s.plan!, semanticRevision: 3 } },
    { ...s, scope: "selected" as const },
    { ...s, joinBinding: { ...s.joinBinding!, joinStepIndex: 4 } },
    { ...s, commitLifecycle: { status: "stale" as const, reason: "A → B → A" } },
    { ...s, commitLifecycle: { status: "pending" as const, runId: "other" } },
  ]) {
    await assert.rejects(runAdvancedMatching(s, { ...ctx, latest: () => latest }), /context changed while retrieving/);
  }
  for (const patch of [{ sessionId: "foreign" }, { runId: "old" }, { evidenceRevision: 2 },
    { plan: { ...snapshot().plan, scope: "selected" as const } }]) {
    await assert.rejects(runAdvancedMatching(s, {
      ...ctx, acquire: async args => ({ ...snapshot(), runId: args.runId, ...patch }),
    }), /different session, run or scope/);
  }
  // Acknowledged review is allowed to refresh explicitly, but not automatically.
  const acked = { ...s, commitLifecycle: { status: "acknowledged" as const, runId: "prior", receipt: receipt2("prior") } };
  assert.ok((await runAdvancedMatching(acked, { ...ctx, latest: () => acked })).advancedRun);
}

// Exact tuple enrichment must not alias embedded NUL delimiters.
{
  const snap = snapshot();
  const keys = [["a\0b", "c"], ["a", "b\0c"]];
  snap.acquisition.sourceRows = keys.map((mapKey, i) => ({ mapKey, fields: { context: `row-${i}` }, affectedSourceRows: i + 1 }));
  snap.retrieval.proposals = keys.map((mapKey, i) => ({ ...retrieval().proposals[0]!, proposalId: `prop:${i}`, mapKey }));
  const out = adaptAdvancedSnapshot(boundSession(advancedPlan()), snap);
  assert.deepEqual(out.proposals.map(p => p.sourceValues), [{ context: "row-0" }, { context: "row-1" }]);
  assert.deepEqual(out.proposals.map(p => p.affectedSourceRows), [1, 2]);
}

// A verification reply cannot write a changed ledger/run, even if the caller's
// project predicate is permissive. Count-only materialization checks are unsafe.
{
  const s = adapted;
  const decided = applyDecision(s, s.proposals[0]!.proposalId, "confirm_proposed", "cand:t1");
  const pending: MatchingTabSession = { ...decided, commitLifecycle: { status: "pending", runId: s.advancedRun!.id } };
  const verified = { sessionId: s.id, runId: s.advancedRun!.id, evidenceRevision: 1,
    materialized: [{ candidateId: "cand:t1", sourceParts: ["Acme", "US"], outputValues: ["Acme Inc", "United States"] }] };
  let writes = 0;
  const ctx = {
    execution: {} as never, isContextCurrent: () => true, verify: async () => verified,
    write: async () => { writes++; return { result: "error" as const, message: "not reached" }; },
    identity: () => "project:0", fingerprint: () => "next", navigationTarget: () => null, latest: () => pending,
  };
  for (const latest of [
    { ...pending, generation: pending.generation + 1 },
    { ...pending, advancedRun: { ...pending.advancedRun!, id: "other" } },
    { ...pending, joinBinding: { ...pending.joinBinding!, joinStepIndex: 4 } },
    { ...pending, scope: "selected" as const },
    { ...pending, decisions: [] },
    { ...pending, commitLifecycle: { status: "stale" as const, reason: "ABA" } },
    { ...pending, commitLifecycle: { status: "pending" as const, runId: "other" } },
  ]) assert.equal((await commitAdvancedMatching(pending, { ...ctx, latest: () => latest })).status, "refused");
  for (const patch of [{ candidateId: "other" }, { sourceParts: ["other", "US"] }, { outputValues: ["forged", "US"] }]) {
    assert.equal((await commitAdvancedMatching(pending, { ...ctx,
      verify: async () => ({ ...verified, materialized: [{ ...verified.materialized[0]!, ...patch }] }),
    })).status, "refused");
  }
  assert.equal(writes, 0);

  const receipt = { ...receipt2(s.advancedRun!.id), contextFingerprint: "next", joinStepIndex: 2 };
  let after = pending;
  const interleaved = await commitAdvancedMatching(pending, {
    ...ctx,
    latest: () => after,
    write: async () => {
      // A same-count individual edit must not be cleared by the old receipt.
      after = { ...pending, decisions: pending.decisions.map(d => ({ ...d, candidateId: "cand:t2" })) };
      return { result: "applied" as const, message: "Applied 1", receipt };
    },
  });
  assert.equal(interleaved.status, "refused");
  assert.match(interleaved.message, /draft was not cleared/);
  assert.equal(after.decisions[0]!.candidateId, "cand:t2");
  for (const bad of [{ ...receipt, appliedCount: 0 }, { ...receipt, appliedCount: 2 },
    { ...receipt, joinStepIndex: -1 }, { ...receipt, joinStepIndex: 1.5 }]) {
    assert.ok("error" in acknowledgeAdvancedReceipt(pending, bad, "project:0", "next", null));
    assert.equal(reconcileAdvancedContext(pending, "project:0", "next", bad).commitLifecycle?.status, "stale");
  }
  const acknowledged = acknowledgeAdvancedReceipt(pending, receipt, "project:0", "next", null);
  assert.ok(!("error" in acknowledged));
  assert.equal(reconcileAdvancedContext(acknowledged, "project:0", "next"), acknowledged);
  const stale = reconcileAdvancedContext(acknowledged, "project:0", "unrelated");
  assert.equal(stale.commitLifecycle?.status, "stale", "summary is invalidated even without a producer run");
  assert.equal(reconcileAdvancedContext(stale, "project:0", "next"), stale, "summary cannot revive after ABA");
  const staleDraft = reconcileAdvancedContext(pending, "project:0", "unrelated");
  assert.deepEqual(staleDraft.decisions, pending.decisions, "stale decisions stay inspectable");
  assert.ok("error" in collectAdvancedDecisions(staleDraft), "inspectable does not mean writable");
  assert.equal(applyDecision(staleDraft, "prop:0", "reject", null), staleDraft);
  assert.ok("error" in collectAdvancedDecisions({ ...pending, scope: "cohort" }), "old broadened runs cannot commit");
}

console.log("advanced.test.ts: ok");
