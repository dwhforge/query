import assert from "node:assert/strict";
import type { MatchingRetrieveResult } from "../../lib/bridge";
import { createMatchingDemoSession, matchingWriteRefusal } from "./executionPolicy";
import { loadFixtureTrial, runMatchingTrial } from "./runTrial";
import { applyDecision } from "./reviewLogic";
import { emptyMatchingSession } from "./types";

const session = emptyMatchingSession({
  id: "live", title: "Live", entry: "mapping", targetMapId: "user_map", scope: "selected",
  instructionText: "", hasUnsavedDecisions: true, chatCollapsed: false,
  plan: { sourceRef: "user_source", targetRef: "user_target", mapKeyFields: ["key"],
    targetIdentityFields: ["id"], outputs: ["id"], comparisons: [], normalization: ["trim"],
    ambiguity: "leave_for_manual", scope: "selected", semanticRevision: 7, uiRevision: 0 },
});
const live = {
  sourceRows: [{ mapKey: ["actual-key"], fields: { key: "actual-key" }, affectedSourceRows: 3 }],
  targetRows: [{ targetId: "actual-id", fields: { id: "actual-id" }, outputValues: ["actual-id"] }],
};
const snapshot = JSON.stringify(session);
let calls = 0;
const mustNotRetrieve = async (): Promise<MatchingRetrieveResult> => {
  calls++; throw new Error("Unexpected host call");
};
assert.equal(session.executionMode, "live");
assert.throws(() => loadFixtureTrial(session), /explicitly selected Demo/);
await assert.rejects(runMatchingTrial({ ...session, plan: null }, live, mustNotRetrieve), /confirm a plan/);
for (const input of [undefined, { ...live, sourceRows: [] }, { ...live, targetRows: [] },
  { sourceRows: [], targetRows: [] }]) {
  await assert.rejects(runMatchingTrial(session, input, mustNotRetrieve), /must both be non-empty/);
}
assert.equal(calls, 0);
for (const failure of [new Error("Host unavailable"), new Error("Cancelled"), "RPC rejected"]) {
  await assert.rejects(runMatchingTrial(session, live, async () => { throw failure; }),
    (error: unknown) => error === failure);
}
assert.equal(JSON.stringify(session), snapshot, "failed trials preserve the draft, plan and metrics");

const out: MatchingRetrieveResult = {
  candidates: [{ candidateId: "live-candidate", sessionId: session.id, targetId: "actual-id",
    outputValues: ["actual-id"], evidenceRevision: 1 }],
  proposals: [{ proposalId: "live-proposal", sessionId: session.id, mapKey: ["actual-key"],
    affectedSourceRows: 3, proposedCandidateId: "live-candidate", alternativeCandidateIds: [],
    state: "proposed", provenance: "fuzzy", semanticPlanRevision: 7, evidenceRevision: 1 }],
  metrics: { mode: "trial", keysRequested: 1, keysProcessed: 1, keysUnprocessed: 0,
    candidatesScored: 1, llmCalls: 0, llmRetries: 0, durationMs: 2, stopReason: "complete",
    keyCap: 20, shortlistPerKey: 40, llmPerKey: 10, maxLlmCalls: 220, localUniverse: 10000 },
  llmCandidateIdsByProposal: {},
};
const result = await runMatchingTrial(session, live, async (args) => {
  assert.deepEqual(args.sourceRows, live.sourceRows);
  assert.deepEqual(args.targetRows, live.targetRows);
  assert.deepEqual(args.plan, session.plan);
  assert.equal(args.sessionId, session.id);
  return out;
});
assert.equal(result.executionMode, "live");
assert.deepEqual(result.plan, session.plan);
assert.deepEqual(result.proposals.map((p) => p.proposalId), ["live-proposal"]);
assert.equal(result.proposals[0].provenance, "fuzzy");
assert.equal(result.runMetrics?.keysProcessed, 1);
const confirmed = applyDecision(result, "live-proposal", "confirm_proposed", "live-candidate");
const confirmedSnapshot = JSON.stringify(confirmed);
assert.equal(confirmed.hasUnsavedDecisions, true);
assert.equal(confirmed.decisions.length, 1);
await assert.rejects(runMatchingTrial(confirmed, undefined, mustNotRetrieve), /must both be non-empty/);
await assert.rejects(runMatchingTrial(confirmed, live, async () => { throw new Error("Host failed"); }), /Host failed/);
assert.equal(JSON.stringify(confirmed), confirmedSnapshot, "failed reruns retain real confirmed decisions and prior metrics");
const empty = await runMatchingTrial(session, live, async () => ({ ...out, candidates: [], proposals: [] }));
assert.deepEqual(empty.proposals, [], "an empty host result is never replaced with fixtures");

const demo = createMatchingDemoSession();
assert.equal(demo.executionMode, "demo");
assert.equal(demo.targetMapId, undefined);
assert.equal(demo.lensCtx, undefined);
assert.deepEqual(demo.mapBaseline, []);
const first = await runMatchingTrial(demo, undefined, mustNotRetrieve);
const second = await runMatchingTrial(demo, undefined, mustNotRetrieve);
assert.ok(first.proposals.length > 0);
assert.deepEqual(first, second, "offline demo is reproducible");
assert.equal(calls, 0, "explicit demo does not need a host");
assert.ok(matchingWriteRefusal(first));
assert.ok(matchingWriteRefusal({ ...first, targetMapId: "user_map",
  proposals: first.proposals.map((p) => ({ ...p, provenance: "llm" })) }), "ranking cannot authorize demo writes");
assert.ok(matchingWriteRefusal({ ...first, executionMode: "live" }), "fixture provenance independently refuses writes");
assert.equal(matchingWriteRefusal(result), null);
console.log("matching explicit demo/live trial tests ok");
