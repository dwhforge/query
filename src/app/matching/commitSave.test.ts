import assert from "node:assert/strict";
import { FIXTURE_CANDIDATES, FIXTURE_PLAN, fixtureProposals } from "./fixtures";
import {
  applyDecision,
  buildFinalDiff,
  materializedFromSession,
  summarizeFinalDiff,
} from "./reviewLogic";
import { emptyMatchingSession, mapKeyToken } from "./types";

{
  let s = emptyMatchingSession({
    id: "s1",
    title: "Matching: Client → A",
    entry: "mapping",
    scope: "cohort",
    instructionText: "",
    plan: FIXTURE_PLAN,
    hasUnsavedDecisions: false,
    chatCollapsed: true,
  });
  s = {
    ...s,
    candidates: FIXTURE_CANDIDATES,
    proposals: fixtureProposals(1),
  };
  s = applyDecision(s, "prop:a1-eurpope", "choose_alternative", "cand:2");
  const mat = materializedFromSession(s);
  assert.equal(mat.length, 1);
  assert.deepEqual(mat[0]!.outputValues, ["2"]);
  assert.equal(mat[0]!.affectedSourceRows, 24);

  const diff = buildFinalDiff({ ...s, mapLive: [], mapBaseline: [] });
  const row = diff.find(
    (r) => mapKeyToken(r.mapKey) === mapKeyToken(["a1", "Eurpope"]),
  );
  assert.equal(row?.kind, "add");
  assert.deepEqual(row?.newOutputs, ["2"]);
  const sum = summarizeFinalDiff(diff);
  assert.ok(sum.adds >= 1);
  assert.ok(sum.unresolved >= 1);
}

console.log("matching commitSave materialize ok");
