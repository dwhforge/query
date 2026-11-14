import assert from "node:assert/strict";
import type { Project, Workspace } from "../../types/pipeline";
import { buildApplyReviewState, confirmApplyReview } from "../../lib/keyMap";
import { confirmTupleMapping } from "../../lib/joinLensConfirm";
import { planTupleMapping } from "./tupleMapping";
import { resolveApplyPlan, intentFromApplyPlan } from "./applyPlan";
import { applyKeyMapOntoProject } from "./service";
import type { KeyMapJoinCtx } from "./types";

for (let n = 1; n <= 4; n++) {
  const ctx: KeyMapJoinCtx = { hostQueryId: "fact", rightQueryId: "dim", joinStepIndex: 0,
    leftOn: Array.from({ length: n }, (_, i) => `left_${i}`),
    rightOn: Array.from({ length: n }, (_, i) => `right_${i}`), joinType: "left" };
  const workspace: Workspace = { focus_query_id: "fact", key_maps: [], queries: [
    { id: "fact", name: "Fact", steps: [{ type: "Join", payload: { right_query_id: "dim", left_on: ctx.leftOn, right_on: ctx.rightOn, join_type: "left" } }] },
    { id: "dim", name: "Dim", steps: [] },
  ] };
  const from = ctx.leftOn.map((_, i) => ` from · ${i} `);
  const outputs = ctx.rightOn.map((_, i) => i === n - 1 ? "∅" : `target ${i}`);
  const selected = confirmTupleMapping(ctx.leftOn, ctx.rightOn, from, outputs);
  assert.ok(!("error" in selected));
  const planned = planTupleMapping(workspace, ctx, selected);
  assert.ok(!("error" in planned));
  assert.deepEqual(planned.map.entries[0]!.from_parts, from);
  assert.deepEqual(planned.map.entries[0]!.output_values, outputs);
  assert.equal(planned.map.output_columns!.length, n);
  assert.equal(planned.map.from_columns!.length, n);
  const binding = planned.joinCtx.outputBindingsLeft!;
  assert.deepEqual(binding.map((b) => b.destination_column), ctx.leftOn);
  const review = buildApplyReviewState({ side: "left", outCols: planned.map.output_columns!,
    leftOnCols: ctx.leftOn, rightOnCols: ctx.rightOn,
    outputBindingsLeft: binding, outputBindingsRight: planned.joinCtx.outputBindingsRight });
  const choice = confirmApplyReview(review);
  assert.equal(choice.error, null);
  assert.deepEqual(choice.bindings, binding, "review must not send outputs 2..N to new columns");
  workspace.key_maps = [planned.map];
  const apply = resolveApplyPlan(planned.map, planned.joinCtx, "left", { side: "left", bindings: choice.bindings }, workspace);
  assert.ok(!("error" in apply));
  const project = { id: "p", name: "P", connections: [], sources: [], dbt_target: "v1", workspace } as Project;
  const folded = applyKeyMapOntoProject(project, intentFromApplyPlan(apply));
  assert.equal(folded.result.status, "ok");
  const steps = folded.project.workspace.queries[0]!.steps;
  assert.equal(steps[0]!.type, "ApplyKeyMap");
  if (steps[0]!.type === "ApplyKeyMap") {
    assert.deepEqual(steps[0].payload.columns, ctx.leftOn);
    assert.deepEqual(steps[0].payload.output_bindings, binding);
  }
  assert.deepEqual(steps[1], workspace.queries[0]!.steps[0], "exact Join ON must remain unchanged");
  const again = planTupleMapping(workspace, ctx, selected);
  assert.ok(!("error" in again));
  assert.equal(again.map.id, planned.map.id, "reuse compatible contextual seed");
  assert.equal(again.map.entries.length, 1, "do not duplicate From rows");
  const conflict = planTupleMapping(workspace, ctx, { ...selected, outputValues: outputs.map(() => "different") });
  assert.ok("error" in conflict, "do not overwrite a conflicting output");
  const stale = planTupleMapping(workspace, { ...ctx, joinStepIndex: 1 }, selected);
  assert.ok("error" in stale, "refuse shifted Join before handoff");
  assert.ok("error" in planTupleMapping(workspace, ctx, { ...selected, leftOn: ["wrong"] }));
  assert.ok("error" in planTupleMapping(workspace, ctx, { ...selected, outputValues: outputs.slice(1) }));
  // Map output order is irrelevant once explicit bindings have been captured.
  const reorderedReview = buildApplyReviewState({ side: "left", outCols: [...planned.map.output_columns!].reverse(),
    leftOnCols: ctx.leftOn, rightOnCols: ctx.rightOn, outputBindingsLeft: binding,
    outputBindingsRight: planned.joinCtx.outputBindingsRight });
  assert.deepEqual(reorderedReview.outputs.map((o) => o.destination), [...ctx.leftOn].reverse());
  assert.deepEqual(reorderedReview.outputs.map((o) => o.rightCol), [...ctx.rightOn].reverse());
}
console.log("tupleMapping.test.ts: ok");
