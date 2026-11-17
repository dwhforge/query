import assert from "node:assert/strict";
import type { Workspace } from "../../types/pipeline";
import { emptyMatchingSession } from "./types";
import { fullJoinContext } from "./fullJoinContext";

// Keep tests independent of Help Lab, live DB connection and arbitrary UI pages.
const ws = {
  queries: [
    { id: "fact", name: "fact", steps: [
      {type: "LoadCsv", payload: {path: "/tmp/fact.csv"}},
      {type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: ["code"], right_on: ["erp_code"] }},
      {type: "SortBy", payload: {column: "code", descending: false}},
    ]},
    { id: "dim", name: "dim", steps: [{type: "LoadCsv", payload: {path: "/tmp/dim.csv"}}]},
  ],
  focus_query_id: "fact",
  key_maps: [],
} as unknown as Workspace;
const session = emptyMatchingSession({
  id: "matching-test", title: "Matching", entry: "lens", scope: "full",
  chatCollapsed: false, instructionText: "", hasUnsavedDecisions: false,
  joinBinding: {
    projectIdentity: "local", contextFingerprint: "frozen-context",
    hostQueryId: "fact", rightQueryId: "dim", joinStepIndex: 1,
    leftOn: ["code"], rightOn: ["erp_code"],
  },
  plan: {
    sourceRef: "fact", targetRef: "dim", mapKeyFields: ["code"],
    targetIdentityFields: ["id"], outputs: ["erp_code"],
    comparisons: [{sourceField: "name", targetField: "name", role: "soft_signal"}],
    normalization: ["trim", "casefold"], ambiguity: "leave_for_manual",
    scope: "full", semanticRevision: 2, uiRevision: 0,
  },
});
const context = fullJoinContext(ws, session);
assert.ok(context);
assert.equal(context.workspace.queries[0]?.steps.length, 1, "LEFT is original pre-JOIN input");
assert.equal(ws.queries[0]?.steps.length, 3, "original project is not mutated");
assert.deepEqual(context.plan.comparisons, [{sourceField: "name", targetField: "name", role: "soft_signal"}]);
assert.deepEqual(context.locked.mapKeyFields, ["code"]);
assert.deepEqual(context.locked.outputs, ["erp_code"]);
assert.equal(context.plan.scope, "full");
assert.strictEqual(fullJoinContext(ws, session), context, "stable schema context between App renders");
assert.equal(fullJoinContext(ws, {...session, joinBinding: {...session.joinBinding!, rightQueryId: "fact"}}), null, "self-JOIN requires a distinct target");
assert.equal(fullJoinContext(ws, {...session, joinBinding: {...session.joinBinding!, joinStepIndex: 2}}), null, "wrong Join step is refused");
assert.equal(fullJoinContext(ws, {...session, executionMode: "demo"}), null, "fixtures cannot become live authority");
const foreignRight = structuredClone(ws);
const foreignJoin = foreignRight.queries.find(q => q.id === "fact")?.steps[1];
assert.equal(foreignJoin?.type, "Join");
if (foreignJoin?.type !== "Join") throw new Error("test requires a JOIN step");
foreignJoin.payload.right_query_id = {scope: "reference", reference_id: "foreign", kind: "query", id: "dim"};
assert.equal(fullJoinContext(foreignRight, session), null, "external RIGHT reference cannot be silently rebound to local dim");
console.log("Full JOIN context: pre-JOIN isolation, immutable keys/outputs, validation passed");
