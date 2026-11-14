import { emptyProject, externalTarget, type Project, type QueryDef, type TransformationStep } from "../../types/pipeline";
import { appendStep, applyJoin, moveStep, removeQuery, removeStep, replaceStep, type QueryEditResult } from "./operations";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
const root = (): TransformationStep => ({ type: "LoadCsv", payload: { path: "/data/a.csv" } });
const filter = (condition = "true"): TransformationStep => ({ type: "Filter", payload: { condition } });
const query = (id: string, steps: TransformationStep[] = [root()]): QueryDef => ({ id, name: id, steps });
function project(queries: QueryDef[] = [query("a"), query("b")]): Project {
  return {
    ...emptyProject("operations"), id: "p", project_uid: "uid",
    sources: [{ id: "catalog", name: "Independent source", kind: "csv", path: "/independent.csv" }],
    workspace: { queries, focus_query_id: queries[0]?.id ?? "", key_maps: [] },
    canvas: { positions: { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } } },
  };
}
function ok(result: QueryEditResult) {
  assert(result.ok, `Unexpected error: ${!result.ok && result.error.message}`);
  return result;
}
function error(result: QueryEditResult, code: string, original: Project) {
  assert(!result.ok, `Expected error ${code}`);
  equal(result.error.code, code, "controlled error");
  assert(result.project === original, "error preserves original snapshot");
}

{
  const ext = externalTarget("lib", "query", "a");
  const original = freeze(project([
    query("a"),
    query("b", [
      { type: "FromQuery", payload: { query_id: "a" } },
      { type: "Join", payload: { right_query_id: "a", join_type: "left", left_on: [], right_on: [] } },
      { type: "Append", payload: { other_query_ids: ["a", "c", ext] } },
      filter(),
    ]),
    query("c", [{ type: "FromQuery", payload: { query_id: "b" } },
      { type: "Append", payload: { other_query_ids: ["a"] } }]),
    query("d", [{ type: "FromQuery", payload: { query_id: "c" } },
      { type: "Join", payload: { right_query_id: ext, join_type: "inner", left_on: ["k"], right_on: ["k"] } },
      { type: "Append", payload: { other_query_ids: ["a", "c"] } }]),
  ]));
  const before = JSON.stringify(original);
  const result = ok(removeQuery(original, { queryId: "a", selection: { queryId: "a", stepIndex: 0 } }));
  equal(result.project.workspace.queries.map(q => q.id), ["b", "c", "d"], "no cascade deletion");
  equal(result.project.workspace.queries[0]!.steps, [
    { type: "Append", payload: { other_query_ids: ["c", ext] } }, filter(),
  ], "scrub local From/Join/Append only");
  equal(result.project.workspace.queries[1]!.steps,
    [{ type: "FromQuery", payload: { query_id: "b" } }], "remove empty Append at depth");
  equal(result.project.workspace.queries[2]!.steps[2],
    { type: "Append", payload: { other_query_ids: ["c"] } }, "deep references scrubbed");
  equal(result.project.workspace.queries[2]!.steps[1], original.workspace.queries[3]!.steps[1],
    "same external object ID is not a local dependency");
  equal(result.project.workspace.focus_query_id, "b", "focus repaired");
  equal(result.navigation, { queryId: "b", stepIndex: 1 }, "selection goes to survivor");
  assert(!result.project.canvas!.positions.a && !!result.project.canvas!.positions.b, "canvas cleanup");
  assert(result.project.sources.some(s => s.id === "catalog"), "independent Sources retained");
  assert(result.project.workspace.key_maps === original.workspace.key_maps, "Mapping owner retained");
  equal(JSON.stringify(original), before, "frozen original unchanged");
  const selected = ok(removeQuery(original, { queryId: "a", selection: { queryId: "b", stepIndex: 3 } }));
  equal(selected.navigation, { queryId: "b", stepIndex: 1 }, "selection follows retained step after scrub");
  const final = ok(removeQuery(freeze(project([query("a")])), {
    queryId: "a", selection: { queryId: "a", stepIndex: 0 },
  }));
  equal(final.navigation, { queryId: null, stepIndex: null }, "empty project selection");
  equal(final.project.workspace.focus_query_id, "", "empty focus");
}

{
  const original = freeze(project());
  const absent = ok(removeQuery(original, { queryId: "missing" }));
  assert(!absent.changed && absent.project === original && !absent.navigation, "missing deletion is no-op");
  error(removeQuery(original, { queryId: "" }), "invalid_query_id", original);
  const duplicate = freeze(project([query("a"), query("a")]));
  error(removeQuery(duplicate, { queryId: "a" }), "duplicate_query_id", duplicate);
  error(applyJoin(duplicate, { queryId: "a", right: "b", pairs: [] }), "duplicate_query_id", duplicate);
  error(replaceStep(duplicate, { queryId: "a", index: 0, step: root() }), "duplicate_query_id", duplicate);
  const invalid = freeze(project([query(" "), query("b")]));
  error(moveStep(invalid, { queryId: "b", index: 0, direction: 1 }), "invalid_query_id", invalid);
}

{
  const original = freeze(project());
  error(applyJoin(original, { queryId: "missing", right: "b", pairs: [] }), "query_not_found", original);
  error(applyJoin(original, { queryId: "a", right: "missing", pairs: [] }), "query_not_found", original);
  error(applyJoin(original, { queryId: "a", right: "a", pairs: [] }), "self_join", original);
  error(applyJoin(original, { queryId: "a", right: externalTarget("missing", "query", "b"), pairs: [] }),
    "invalid_reference", original);
  const appended = ok(applyJoin(original, { queryId: "a", right: "b", pairs: [{ left: "", right: "" }] }));
  equal(appended.navigation, { queryId: "a", stepIndex: 1 }, "new JOIN index");
  equal(appended.project.workspace.queries[0]!.steps[1],
    { type: "Join", payload: { right_query_id: "b", join_type: "inner", left_on: [], right_on: [] } },
    "empty keys remain editable, not fabricated");
  const updated = ok(applyJoin(freeze(appended.project), {
    queryId: "a", right: "b", pairs: [{ left: " id ", right: " " }], joinType: "full",
  }));
  equal(updated.navigation, { queryId: "a", stepIndex: 1 }, "existing JOIN selected");
  assert(updated.project.workspace.queries[0]!.steps.length === 2, "JOIN upsert is not duplicate append");
  equal(updated.project.workspace.queries[0]!.steps[1],
    { type: "Join", payload: { right_query_id: "b", join_type: "full", left_on: ["id"], right_on: ["id"] } },
    "existing normalization reused");
  const same = ok(applyJoin(updated.project, {
    queryId: "a", right: "b", pairs: [{ left: "id", right: "id" }], joinType: "full",
  }));
  assert(!same.changed && same.project === updated.project, "same JOIN is explicit no-op");
  equal(same.navigation, { queryId: "a", stepIndex: 1 }, "no-op JOIN still identifies edit target");
  const external = freeze({ ...updated.project,
    references: [{ id: "lib", alias: "Lib", locator: "lib.json", expected_project_uid: "lib", locked_revision: "r" }] });
  const second = ok(applyJoin(external, {
    queryId: "a", right: externalTarget("lib", "query", "a"), pairs: [],
  }));
  equal(second.navigation, { queryId: "a", stepIndex: 2 }, "second distinct JOIN appended");
  assert(second.project.workspace.queries[0]!.steps[1] === external.workspace.queries[0]!.steps[1],
    "other JOIN retained");
  equal(original.workspace.queries[0]!.steps, [root()], "old snapshot untouched");
}

{
  const roots: TransformationStep[] = [root(),
    { type: "LoadParquet", payload: { path: "/a.parquet" } },
    { type: "LoadPostgres", payload: { schema: "public", table_name: "a" } },
    { type: "LoadDuckdb", payload: { path: "/a.db", schema: "main", table_name: "a" } },
    { type: "FromQuery", payload: { query_id: "b" } },
    { type: "SqlModel", payload: { raw_sql: "select 1" } }];
  for (const start of roots) {
    const original = freeze(project([query("a", [start, filter(), filter("false")]), query("b")]));
    for (const [index, direction] of [[0, 1], [1, -1], [2, 1]] as const) {
      const result = ok(moveStep(original, { queryId: "a", index, direction }));
      assert(!result.changed && result.project === original && !result.navigation, "guarded move does not navigate");
    }
    error(removeStep(original, { queryId: "a", index: 0, selectedIndex: 1 }), "root_required", original);
    const moved = ok(moveStep(original, { queryId: "a", index: 1, direction: 1 }));
    equal(moved.navigation, { queryId: "a", stepIndex: 2 }, "move intent");
    equal(moved.project.workspace.queries[0]!.steps, [start, filter("false"), filter()], "swap transforms");
  }
  const original = freeze(project([query("a", [root(), filter()]), query("b")]));
  for (const index of [-1, 2, 1.5, NaN]) {
    error(replaceStep(original, { queryId: "a", index, step: filter() }), "invalid_step_index", original);
    error(moveStep(original, { queryId: "a", index, direction: 1 }), "invalid_step_index", original);
    error(removeStep(original, { queryId: "a", index, selectedIndex: 1 }), "invalid_step_index", original);
  }
  error(appendStep(original, { queryId: "gone", step: filter() }), "query_not_found", original);
  const same = ok(replaceStep(original, { queryId: "a", index: 1, step: filter() }));
  assert(!same.changed && same.project === original, "identical replacement no-op");
  const replaced = ok(replaceStep(original, { queryId: "a", index: 1, step: filter("id > 0") }));
  assert(!replaced.navigation, "replace does not reset Inspector selection/drafts");
  const removed = ok(removeStep(original, { queryId: "a", index: 1, selectedIndex: 1 }));
  equal(removed.navigation, { queryId: "a", stepIndex: 0 }, "remove selected step");
  const empty = ok(removeStep(freeze(project([query("a")])), { queryId: "a", index: 0, selectedIndex: 0 }));
  equal(empty.navigation, { queryId: "a", stepIndex: null }, "remove only root yields empty query");
}

{
  // The reducer invokes each operation on its current project, not a captured graph.
  let current = freeze(project());
  const first = ok(appendStep(current, { queryId: "a", step: filter("newest") }));
  current = freeze(first.project);
  const second = ok(applyJoin(current, { queryId: "a", right: "b", pairs: [] }));
  equal(second.project.workspace.queries[0]!.steps.map(s => s.type), ["LoadCsv", "Filter", "Join"],
    "queued edit retains preceding edit");
  equal(second.navigation, { queryId: "a", stepIndex: 2 }, "index computed from latest snapshot");
  const third = ok(removeQuery(second.project, { queryId: "b" }));
  equal(third.project.workspace.queries[0]!.steps.map(s => s.type), ["LoadCsv", "Filter"],
    "deletion retains intervening edit while scrubbing new dependency");
  assert(first.project.workspace.queries.length === 2, "later deletion did not mutate old snapshot");
}
console.log("Query editing operation tests passed (delete/JOIN/steps/guards/snapshots)");
