import assert from "node:assert/strict";
import { emptyProject, migrateProject, type Project, type Workspace } from "../../types/pipeline";
import { buildApplyReviewState, confirmApplyReview } from "../../lib/keyMap";
import { confirmTupleMapping } from "../../lib/joinLensConfirm";
import { planBatchTupleMapping, planTupleMapping } from "./tupleMapping";
import { resolveApplyPlan, intentFromApplyPlan } from "./applyPlan";
import { applyKeyMapOntoProject } from "./service";
import type { KeyMapJoinCtx } from "./types";

for (let n = 1; n <= 5; n++) {
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

// Batch preparation is a pure transaction: a late error cannot publish early rows.
for (let n = 1; n <= 6; n++) {
  const leftOn = Array.from({ length: n }, (_, i) => `source_${i}`);
  const rightOn = Array.from({ length: n }, (_, i) => `target_${i}`);
  const ctx: KeyMapJoinCtx = { hostQueryId: "fact", rightQueryId: "dim", joinStepIndex: 0,
    leftOn, rightOn, joinType: "left", probeSide: "left" };
  const project = { ...emptyProject("Batch"), workspace: { focus_query_id: "fact", key_maps: [], queries: [
    { id: "fact", name: "Fact", steps: [{ type: "Join", payload: {
      right_query_id: "dim", left_on: leftOn, right_on: rightOn, join_type: "left",
    } }] }, { id: "dim", name: "Dim", steps: [] },
  ] } } as Project;
  const selections = Array.from({ length: 3 }, (_, row) => ({ leftOn, rightOn,
    fromParts: leftOn.map((_, i) => i === n - 1 ? `context ${row}` : " ABC · ∅ "),
    outputValues: rightOn.map((_, i) => i === n - 1 ? `canonical ${row}` : " target · ∅ "),
  }));
  const before = JSON.stringify(project);
  const selectedBefore = JSON.stringify(selections);
  const batch = planBatchTupleMapping(project.workspace, ctx, selections);
  assert.ok(!("error" in batch));
  assert.equal(batch.map.entries.length, 3);
  assert.deepEqual(batch.map.entries.map((entry) => entry.from_parts), selections.map((s) => s.fromParts));
  assert.deepEqual(batch.map.entries.map((entry) => entry.output_values), selections.map((s) => s.outputValues));
  assert.equal(JSON.stringify(project), before, "preparation must not mutate the project");
  assert.equal(JSON.stringify(selections), selectedBefore, "preparation must not mutate selections");

  const withMap = { ...project, workspace: { ...project.workspace, key_maps: [batch.map] } };
  const plan = resolveApplyPlan(batch.map, batch.joinCtx, "left", {
    side: "left", bindings: batch.joinCtx.outputBindingsLeft!,
  }, withMap.workspace);
  assert.ok(!("error" in plan));
  const folded = applyKeyMapOntoProject(withMap, intentFromApplyPlan(plan));
  assert.equal(folded.result.status, "ok");
  const steps = folded.project.workspace.queries[0]!.steps;
  assert.equal(steps.length, 2, "one batch inserts one Apply, not one per tuple");
  assert.equal(steps[0]!.type, "ApplyKeyMap");
  if (steps[0]!.type === "ApplyKeyMap") {
    assert.deepEqual(steps[0].payload.columns, leftOn);
    assert.deepEqual(steps[0].payload.output_bindings,
      rightOn.map((column, i) => ({ map_column: `to_${i + 1}_${column}`, destination_column: leftOn[i]! })));
  }
  assert.deepEqual(steps[1], project.workspace.queries[0]!.steps[0], "batch must not rewrite Join ON");
  const reopened = migrateProject(JSON.parse(JSON.stringify(folded.project)) as Project);
  assert.deepEqual(reopened.workspace.key_maps![0]!.entries.map((e) => e.from_parts), selections.map((s) => s.fromParts));
  assert.deepEqual(reopened.workspace.key_maps![0]!.entries.map((e) => e.output_values), selections.map((s) => s.outputValues));

  const liveCtx = { ...ctx, joinStepIndex: 1 };
  const again = planBatchTupleMapping(folded.project.workspace, liveCtx, selections);
  assert.ok(!("error" in again));
  assert.equal(again.map.id, batch.map.id, "reuse the compatible applied Mapping");
  assert.equal(again.map.entries.length, 3, "reapplying identical choices is idempotent");
  const applyAgain = resolveApplyPlan(again.map, again.joinCtx, "left", {
    side: "left", bindings: again.joinCtx.outputBindingsLeft!,
  }, folded.project.workspace);
  assert.ok(!("error" in applyAgain));
  const foldedAgain = applyKeyMapOntoProject(folded.project, intentFromApplyPlan(applyAgain));
  assert.equal(foldedAgain.result.status, "ok");
  assert.equal(foldedAgain.project.workspace.queries[0]!.steps.length, 2);

  const assertRefused = (workspace: Workspace, context: KeyMapJoinCtx, choices = selections) => {
    const snapshot = JSON.stringify(workspace);
    assert.ok("error" in planBatchTupleMapping(workspace, context, choices));
    assert.equal(JSON.stringify(workspace), snapshot, "refusal must leave every row and step intact");
  };
  assertRefused(project.workspace, ctx, []);
  assertRefused(project.workspace, ctx, [...selections, selections[0]!]);
  assertRefused(project.workspace, ctx, [...selections, { ...selections[0]!, outputValues: rightOn.map(() => "conflict") }]);
  assertRefused(project.workspace, { ...ctx, joinStepIndex: 1 });
  assertRefused(project.workspace, ctx, [selections[0]!, { ...selections[1]!, leftOn: [...leftOn].reverse().concat("wrong") }]);
  assertRefused(project.workspace, ctx, [selections[0]!, { ...selections[1]!, outputValues: [] }]);
  assertRefused(project.workspace, ctx, [selections[0]!, { ...selections[1]!, fromParts: leftOn.map(() => " ") }]);
  assertRefused(project.workspace, ctx, [selections[0]!, { ...selections[1]!, outputValues: rightOn.map(() => "") }]);
  const whitespaceCollision = planBatchTupleMapping(project.workspace, ctx, [
    { ...selections[0]!, fromParts: leftOn.map(() => "ABC") },
    { ...selections[1]!, fromParts: leftOn.map(() => " ABC ") },
  ]);
  assert.ok("error" in whitespaceCollision, "block existing KeyMap trim collisions, never silently merge distinct tuple identities");
  assert.ok(whitespaceCollision.error.includes("No tuple values were normalized or written"));
  assert.equal(JSON.stringify(project), before);
  // A late conflict after an otherwise valid new row still leaves no partial batch.
  assertRefused(withMap.workspace, ctx, [
    { ...selections[0]!, fromParts: leftOn.map(() => "brand new") },
    { ...selections[2]!, outputValues: rightOn.map(() => "conflicting target") },
  ]);
  const conflict = planBatchTupleMapping(withMap.workspace, ctx, [
    { ...selections[2]!, outputValues: rightOn.map(() => "conflicting target") },
  ]);
  assert.ok("error" in conflict);
  assert.ok(conflict.error.includes(JSON.stringify(selections[2]!.fromParts)), "identify the exact offending tuple");
  const corrupt = (map: typeof batch.map): Workspace => ({ ...withMap.workspace, key_maps: [map] });
  assertRefused(corrupt({ ...batch.map, entries: [...batch.map.entries, batch.map.entries[2]!] }), ctx, [selections[0]!]);
  assertRefused(corrupt({ ...batch.map, entries: [...batch.map.entries, {
    from: "unfinished", from_parts: leftOn.map(() => "unfinished"), to: "", output_values: rightOn.map(() => ""),
  }] }), ctx, [selections[0]!]);
  // An applied scalar / external / temporal map must not be silently replaced by a new seed.
  for (const incompatible of [
    { ...batch.map, from_columns: ["legacy_from"], output_columns: ["legacy_to"] },
    { ...batch.map, storage: { kind: "query" as const, query_id: "dim" } },
    { ...batch.map, time_mode: "range_scd" as const },
  ]) {
    assertRefused({ ...folded.project.workspace, key_maps: [incompatible] }, liveCtx);
  }
  assert.equal(JSON.stringify(project), before);
}
console.log("tupleMapping batch/project tests: ok");
