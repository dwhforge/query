import { emptyProject, externalTarget, type KeyMapDef, type Project, type QueryDef, type TransformationStep } from "../../types/pipeline";
import type { MappingCheck } from "../../types/mappingCheck";
import { createQueryEditingService, type QueryEditResult } from "./service";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function eq(a: unknown, b: unknown, message: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), message);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const root = (): TransformationStep => ({ type: "SqlModel", payload: { raw_sql: "select 1 as id" } });
const from = (id: string): TransformationStep => ({ type: "FromQuery", payload: { query_id: id } });
const join = (id: string): TransformationStep =>
  ({ type: "Join", payload: { right_query_id: id, join_type: "left", left_on: ["id"], right_on: ["id"] } });
const filter = (): TransformationStep => ({ type: "Filter", payload: { condition: "id > 0" } });
const q = (id: string, steps: TransformationStep[] = [root()]): QueryDef => ({ id, name: id, steps });
const seed: KeyMapDef = { id: "keep", name: "Keep", storage: { kind: "seed" },
  from_columns: ["ext"], output_columns: ["id"], entries: [{ from: "K", from_parts: ["K"], output_values: ["1"] }],
  authoring_context: { source_query_id: "a", source_columns: ["id"], target_query_id: "b",
    target_column: "id", target_columns: ["id"] } };
function p(queries = [q("a"), q("b")], extra: Partial<Project> = {}): Project {
  return freeze({ ...emptyProject("Integrity"), project_uid: "p", ...extra,
    workspace: { queries, focus_query_id: "a", key_maps: [seed] } });
}
function ok(result: QueryEditResult) { assert(result.ok, "Expected success"); return result; }
function refuse(result: QueryEditResult, before: Project, code = "query_in_use") {
  assert(!result.ok, "Must refuse unsafe edit");
  eq(result.error.code, code, "controlled error");
  assert(result.project === before, "refusal preserves exact snapshot");
  assert(!("navigation" in result), "no refusal navigation");
}
function check(input: Partial<MappingCheck> = {}): MappingCheck {
  return { id: "check", name: "Check", map_id: "keep", input_refs: ["a"],
    group_attributes: [], cohort_predicate: "", allow_decisions: [],
    projection: { kind: "attrs", host_query_id: "b", left_attr: "id", right_attr: "id",
      sample_column: "id", left_attrs: ["id"], right_attrs: ["id"], sample_columns: ["id"] },
    ...input };
}

{
  const before = p();
  const first = ok(createQueryEditingService(before).deriveQuery({ queryId: "a" }));
  assert(first.project.workspace.key_maps === before.workspace.key_maps, "derive preserves map identity");
  assert(first.project.workspace.queries[0] === before.workspace.queries[0], "derive retains old Queries");
  eq(first.project.workspace.queries[2]!.steps, [from("a")], "derived root references original");
  eq(first.navigation, { queryId: first.project.workspace.queries[2]!.id, stepIndex: 0 }, "derive selection");
  const second = ok(createQueryEditingService(first.project).deriveQuery({ queryId: "a" }));
  assert(second.project.workspace.queries[2]!.id !== second.project.workspace.queries[3]!.id,
    "batched derives use current IDs");
  assert(second.project.workspace.queries[2]!.name !== second.project.workspace.queries[3]!.name,
    "batched derives use current names");
  eq(second.project.workspace.key_maps, [seed], "all derives preserve full Mapping");
  eq(before.workspace.queries.length, 2, "old snapshot immutable");
  refuse(createQueryEditingService(before).deriveQuery({ queryId: "missing" }), before, "query_not_found");
}

{
  for (const steps of [[from("a")], [from("a"), filter()],
    [{ type: "SqlModel", payload: { raw_sql: "select * from {{query: a }}" } } as TransformationStep],
    [root(), { type: "CustomSql", payload: { raw_sql: "select * from {{query:a}}" } } as TransformationStep]]) {
    const before = p([q("a"), q("dependent", steps)]);
    refuse(createQueryEditingService(before).removeQuery({ queryId: "a" }), before);
  }
  const before = p([q("a"), q("b", [root(), join("a"),
    { type: "Append", payload: { other_query_ids: ["a"] } }])], { outputs: ["a", "b", "a"] });
  const removed = ok(createQueryEditingService(before).removeQuery({ queryId: "a" }));
  eq(removed.project.workspace.queries[0]!.steps, [root()], "safe Join/Append scrub");
  eq(removed.project.outputs, ["b"], "deleted publications removed");
  eq(removed.project.workspace.key_maps, [seed], "seed authoring context is provenance, not a live binding");
  assert(removed.project.workspace.key_maps === before.workspace.key_maps, "Mapping object untouched");
}

{
  for (const mapQuery of ["a", "b"]) {
    const original = p([q("a"), q("b", [root(), join("a")])]);
    const before = freeze({ ...original, workspace: { ...original.workspace, key_maps: [
      seed, { id: "computed", name: "Computed", storage: { kind: "query" as const, query_id: mapQuery },
        from_columns: ["id"], output_columns: ["out"], entries: [] },
    ] } });
    refuse(createQueryEditingService(before).removeQuery({ queryId: "a" }), before);
  }
  for (const definition of [check(), check({ input_refs: [], projection: {
    kind: "attrs", host_query_id: "a", left_attr: "id", right_attr: "id", sample_column: "id",
    left_attrs: ["id"], right_attrs: ["id"], sample_columns: ["id"] } }),
    check({ input_refs: ["b"] })]) {
    const before = p([q("a"), q("b", [root(), join("a")])], { mapping_checks: [definition] });
    refuse(createQueryEditingService(before).removeQuery({ queryId: "a" }), before);
  }
  const lab = p([q("quality_joined"), q("b")], { mapping_checks: [check({
    input_refs: [], projection: { kind: "lab_v1" },
  })] });
  refuse(createQueryEditingService(lab).removeQuery({ queryId: "quality_joined" }), lab);
}

{
  const ext = externalTarget("lib", "query", "a");
  const before = p([q("a"), q("b", [root(), join("a"), join("a"),
    { type: "Join", payload: { right_query_id: ext, join_type: "left", left_on: [], right_on: [] } },
    { type: "Append", payload: { other_query_ids: ["a", ext] } }])]);
  const service = createQueryEditingService(before);
  const removed = ok(service.removeEdge({ queryId: "b", kind: "join", other: "a", stepIndex: 1,
    selection: { queryId: "b", stepIndex: 2 } }));
  assert(removed.project.workspace.queries[1]!.steps.length === 4, "indexed edge removes only one JOIN");
  eq(removed.navigation, { queryId: "b", stepIndex: 1 }, "selection follows surviving JOIN");
  eq(removed.project.workspace.queries[1]!.steps[2], before.workspace.queries[1]!.steps[3],
    "external target with same object ID retained");
  const append = ok(service.removeEdge({ queryId: "b", kind: "append", other: "a" }));
  eq(append.project.workspace.queries[1]!.steps[4],
    { type: "Append", payload: { other_query_ids: [ext] } }, "Append target identity preserved");
  const noOp = ok(service.removeEdge({ queryId: "b", kind: "join", other: "missing" }));
  assert(!noOp.changed && noOp.project === before, "missing edge is no-op");
  const wrongIndex = ok(service.removeEdge({ queryId: "b", kind: "join", other: "a", stepIndex: 0 }));
  assert(!wrongIndex.changed, "stale edge never falls back to another JOIN");
  refuse(service.removeEdge({ queryId: "b", kind: "join", other: "a", stepIndex: 99 }), before, "invalid_step_index");
  const externalRemoved = ok(service.removeEdge({ queryId: "b", kind: "join", other: ext }));
  eq(externalRemoved.project.workspace.queries[1]!.steps.filter(s => s.type === "Join").length, 2,
    "external edge removed without local edges");
}

{
  const dependent = p([q("a"), q("b", [from("a"), filter()])]);
  refuse(createQueryEditingService(dependent).removeEdge({ queryId: "b", kind: "from", other: "a" }),
    dependent, "root_required");
  const leaf = p([q("a"), q("b", [from("a")])]);
  const empty = ok(createQueryEditingService(leaf).removeEdge({ queryId: "b", kind: "from", other: "a",
    selection: { queryId: "b", stepIndex: 0 } }));
  eq(empty.project.workspace.queries[1]!.steps, [], "unreferenced root-only leaf becomes editing draft");
  eq(empty.navigation, { queryId: "b", stepIndex: null }, "empty draft selection");
  for (const before of [p([q("a"), q("b", [from("a")]), q("c", [from("b")])]),
    p([q("a"), q("b", [from("a")])], { outputs: ["b"] }),
    p([q("a"), q("b", [root(), join("a")])], { mapping_checks: [check({ input_refs: ["b"] })] })]) {
    refuse(createQueryEditingService(before).removeEdge({
      queryId: "b", kind: before.workspace.queries[1]!.steps[0]!.type === "FromQuery" ? "from" : "join", other: "a",
    }), before);
  }
}

{
  // Every exposed successful non-Mapping operation preserves the same map list.
  const before = p([q("a", [root(), filter(), { type: "Limit", payload: { n: 5 } }]), q("b")]);
  const editing = createQueryEditingService(before);
  for (const result of [
    editing.deriveQuery({ queryId: "a" }),
    editing.applyJoin({ queryId: "a", right: "b", pairs: [] }),
    editing.appendStep({ queryId: "a", step: filter() }),
    editing.replaceStep({ queryId: "a", index: 1, step: filter() }),
    editing.moveStep({ queryId: "a", index: 1, direction: 1 }),
    editing.removeStep({ queryId: "a", index: 1 }),
    editing.removeEdge({ queryId: "a", kind: "join", other: "b" }),
    editing.removeQuery({ queryId: "b" }),
  ]) assert(ok(result).project.workspace.key_maps === before.workspace.key_maps, "KeyMap invariant for all operations");
}
{
  const ext = externalTarget("lib", "query", "a");
  const before = p([q("a"), q("b", [root(), join("a"), join("a"),
    { type: "Append", payload: { other_query_ids: ["a", "a"] } },
    { type: "Append", payload: { other_query_ids: ["a", "b", ext] } },
    { type: "Join", payload: { right_query_id: ext, join_type: "left", left_on: [], right_on: [] } }])]);
  const service = createQueryEditingService(before);
  const prepared = service.prepareRemoveQuery({ queryId: "a" });
  assert(prepared.ok, "unprotected deletion can be prepared");
  eq(prepared.consequences, [
    { queryId: "b", queryName: "b", stepIndex: 1, operation: "Join", action: "remove_step" },
    { queryId: "b", queryName: "b", stepIndex: 2, operation: "Join", action: "remove_step" },
    { queryId: "b", queryName: "b", stepIndex: 3, operation: "Append", action: "remove_step" },
    { queryId: "b", queryName: "b", stepIndex: 4, operation: "Append", action: "remove_input" },
  ], "every local operation and partial Append listed, external targets excluded");
  eq(before.workspace.queries[1]!.steps.length, 6, "inspection never commits the proposed edit");
  const removed = ok(service.removeQuery({ queryId: "a", expectedRemovalRevision: prepared.revision }));
  eq(removed.project.workspace.queries[0]!.steps, [root(),
    { type: "Append", payload: { other_query_ids: ["b", ext] } }, before.workspace.queries[1]!.steps[5]],
  "confirmed deletion retains existing cleanup semantics");
  const independent = service.prepareRemoveQuery({ queryId: "b" });
  assert(independent.ok && independent.consequences.length === 0, "no affected operations needs no confirmation");
  refuse(service.removeQuery({ queryId: "b", expectedRemovalRevision: prepared.revision }), before, "stale_query");
  const layoutOnly = freeze({ ...before, canvas: { positions: { a: { x: 1, y: 2 } } } });
  ok(createQueryEditingService(layoutOnly).removeQuery({ queryId: "a", expectedRemovalRevision: prepared.revision }));
}

{
  const before = p();
  const service = createQueryEditingService(before);
  const prepared = service.prepareRemoveQuery({ queryId: "a" });
  assert(prepared.ok, "independent target prepared");
  // The target definition/revision stays unchanged while its consumers change.
  for (const steps of [[root(), join("a")], [root(), { type: "Append", payload: { other_query_ids: ["a"] } } as TransformationStep],
    [from("a")], [root(), { type: "CustomSql", payload: { raw_sql: "select * from {{query:a}}" } } as TransformationStep]]) {
    const current = p([q("a"), q("b", steps)]);
    const editing = createQueryEditingService(current);
    eq(editing.revision("a"), service.revision("a"), "target-only token cannot detect new consumers");
    refuse(editing.removeQuery({ queryId: "a", expectedRemovalRevision: prepared.revision }), current,
      steps[0]!.type === "FromQuery" || steps.some(s => s.type === "CustomSql") ? "query_in_use" : "stale_query");
    const retry = editing.prepareRemoveQuery({ queryId: "a" });
    if (retry.ok) ok(editing.removeQuery({ queryId: "a", expectedRemovalRevision: retry.revision }));
    else refuse(retry, current);
  }
  const mapped = freeze({ ...before, workspace: { ...before.workspace, key_maps: [
    { ...seed, id: "computed", storage: { kind: "query" as const, query_id: "a" } },
  ] } });
  for (const current of [mapped, p(undefined, { mapping_checks: [check()] })]) {
    const editing = createQueryEditingService(current);
    const blocked = editing.prepareRemoveQuery({ queryId: "a" });
    assert(!blocked.ok, "hard blocks exposed before prompting");
    refuse(blocked, current);
    refuse(editing.removeQuery({ queryId: "a", expectedRemovalRevision: prepared.revision }), current);
  }
}

{
  const queries = [q("a"), q("b", [root(), join("a")]), q("c", [from("b")]), q("unrelated")];
  for (const queryId of ["b", "c", "unrelated"]) {
    const before = freeze({ ...p(queries), workspace: { queries, focus_query_id: "b", key_maps: [
      seed, { ...seed, id: "computed", storage: { kind: "query" as const, query_id: queryId } },
    ] } });
    const editing = createQueryEditingService(before);
    const removed = editing.removeEdge({ queryId: "b", kind: "join", other: "a" });
    if (queryId === "unrelated") {
      assert(ok(removed).project.workspace.key_maps === before.workspace.key_maps,
        "unrelated live Mapping does not block safe edge removal");
    } else refuse(removed, before);
    const absent = ok(editing.removeEdge({ queryId: "b", kind: "join", other: "missing" }));
    assert(!absent.changed && absent.project === before, "protected inputs still allow no-op edge removal");
  }
  const seedOnly = p(queries);
  ok(createQueryEditingService(seedOnly).removeEdge({ queryId: "b", kind: "join", other: "a" }));
  const unrelatedCheck = p(queries, { mapping_checks: [check({ input_refs: ["unrelated"], projection: {
    kind: "attrs", host_query_id: "unrelated", left_attr: "id", right_attr: "id", sample_column: "id",
    left_attrs: ["id"], right_attrs: ["id"], sample_columns: ["id"] } })] });
  ok(createQueryEditingService(unrelatedCheck).removeEdge({ queryId: "b", kind: "join", other: "a" }));
}
console.log("Query editing integrity tests passed (derive/maps/dependencies/outputs/edges/deletion preparation)");
