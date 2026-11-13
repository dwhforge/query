import assert from "node:assert/strict";
import { emptyProject, type Project, type QueryDef } from "../types/pipeline";
import {
  captureJoinTarget, createQueryNavigation, isCurrentQueryContext, joinTargetUnavailable,
  resolveQueryDestination, transitionQueryContext, type QueryContextInput, type QueryDestination,
} from "./queryNavigation";

const load: QueryDef = { id: "left", name: "Left", steps: [{ type: "LoadCsv", payload: { path: "left.csv" } }] };
const right: QueryDef = { ...load, id: "right", name: "Right" };
const host: QueryDef = { id: "host", name: "Host", steps: [
  { type: "FromQuery", payload: { query_id: "left" } },
  { type: "Join", payload: { right_query_id: "right", join_type: "left", left_on: ["key"], right_on: ["id"] } },
  { type: "Limit", payload: { n: 5 } },
] };
const base: Project = { ...emptyProject("navigation"), workspace: { queries: [load, right, host], focus_query_id: "left",
  key_maps: [{ id: "map", name: "Map", entries: [] }] } };
let project = base;
const target = captureJoinTarget(project, "host", 1)!;
assert.ok(target);
assert.equal(joinTargetUnavailable(project, target), null);
assert.equal(captureJoinTarget(project, "host", 0), null);
assert.equal(captureJoinTarget(project, "missing", 1), null);
assert.ok(joinTargetUnavailable(project, null));

let selected: QueryDestination | undefined;
let mapping = "";
let matching = "";
const commands = createQueryNavigation({ project: () => project, select: (next) => { selected = next; },
  openMapping: (id) => { mapping = id; }, openMatching: (id) => { matching = id; } });
assert.equal(commands.openQuery("left"), true);
assert.equal(selected?.query.id, "left");
assert.equal(commands.inspectJoin(target, { focusLens: true }), true);
assert.equal(selected?.query.id, "host", "return never uses whichever query is now selected");
assert.equal(selected?.step, host.steps[1], "hydrate exactly the original JOIN draft");
assert.equal(selected?.view, "data");
assert.equal(selected?.lens, true);
assert.equal(selected?.focusLens, true);
assert.equal(project, base, "navigation never mutates/replaces project");
assert.equal(project.workspace.focus_query_id, "left", "export focus stays independent");
assert.equal(commands.openMapping("map"), true);
assert.equal(mapping, "map");
assert.equal(commands.openMapping("missing"), false);
commands.openMatching("session");
assert.equal(matching, "session");
for (const index of [-1, 20, 0.5]) assert.equal(resolveQueryDestination(project.workspace, "host", { stepIndex: index }), null);
assert.equal(resolveQueryDestination(project.workspace, "host")?.stepIndex, 2);
assert.equal(resolveQueryDestination(project.workspace, "host", { stepIndex: 1 })?.step, host.steps[1]);
assert.equal(commands.openQuery("missing"), false);

// Missing/replaced/moved JOIN, same-key right-side/type changes, upstream changes,
// and another project must refuse rather than redirect to a surviving current JOIN.
const mutations = [
  { ...base, project_uid: "replacement" },
  { ...base, workspace: { ...base.workspace, queries: [load, right] } },
  { ...base, workspace: { ...base.workspace, queries: [right, host] } },
  ...[
    [host.steps[0], { type: "Limit", payload: { n: 1 } }],
    [host.steps[0], host.steps[2], host.steps[1]],
    [host.steps[0], { type: "Join", payload: { right_query_id: "left", join_type: "left", left_on: ["key"], right_on: ["id"] } }],
    [host.steps[0], { type: "Join", payload: { right_query_id: "right", join_type: "inner", left_on: ["key"], right_on: ["id"] } }],
  ].map((steps) => ({ ...base, workspace: { ...base.workspace,
    queries: [load, right, { ...host, steps: steps as QueryDef["steps"] }] } })),
  { ...base, workspace: { ...base.workspace, queries: [{ ...load, steps: [{ type: "LoadCsv" as const, payload: { path: "new.csv" } }] }, right, host] } },
];
for (const changed of mutations) {
  project = changed;
  const before: QueryDestination | undefined = selected;
  assert.ok(joinTargetUnavailable(project, target));
  assert.equal(commands.inspectJoin(target), false);
  assert.equal(selected, before, "refusal has no selection effect");
}
project = { ...base, workspace: { ...base.workspace, key_maps: [{ id: "map", name: "Map", entries: [{ from: "a", to: "b" }] }] } };
assert.equal(joinTargetUnavailable(project, target), null, "map Save must not disable result inspection");
project = { ...base, workspace: { ...base.workspace, queries: [load, right,
  { ...host, steps: [...host.steps.slice(0, 2), { type: "Limit", payload: { n: 10 } }] }] } };
assert.equal(joinTargetUnavailable(project, target), null, "downstream changes do not change original Join inputs");
const transitive = { ...base, workspace: { ...base.workspace, queries: [load,
  { ...right, steps: [{ type: "FromQuery" as const, payload: { query_id: "left" } }] }, host] } };
const transitiveTarget = captureJoinTarget(transitive, "host", 1)!;
assert.ok(transitiveTarget);
assert.ok(joinTargetUnavailable({ ...transitive, workspace: { ...transitive.workspace,
  queries: transitive.workspace.queries.map((q) => q.id === "left" ?
    { ...q, steps: [{ type: "LoadCsv", payload: { path: "changed.csv" } }] } : q),
} }, transitiveTarget), "transitive side changes invalidate the captured target");

const input: QueryContextInput = { projectUid: base.project_uid, queryId: "host", stepIndex: 1,
  view: "query:data", mode: "lens", workspace: base.workspace };
const initial = transitionQueryContext(null, input);
assert.equal(transitionQueryContext(initial, input), initial, "render-only changes preserve revision");
const reentry = transitionQueryContext(initial, input, true);
assert.equal(reentry.revision, initial.revision + 1);
assert.equal(isCurrentQueryContext(initial, reentry), false, "explicit same-target navigation invalidates earlier panel work");
for (const patch of [ { projectUid: "new" }, { queryId: "right" }, { stepIndex: 2 },
  { view: "matching:data" }, { mode: "preview" }, { workspace: { ...base.workspace } },
  { connections: [] }, { sources: [] }, { projectFile: "/new/project.json" } ]) {
  const next = transitionQueryContext(initial, { ...input, ...patch });
  assert.equal(next.revision, initial.revision + 1);
  assert.equal(isCurrentQueryContext(initial, next), false, "late success/error/progress is stale");
  const back = transitionQueryContext(next, input);
  assert.equal(isCurrentQueryContext(initial, back), false, "away/back must not revive a captured operation");
}
console.log("queryNavigation tests passed (commands, targets, dependencies, context and ABA staleness)");
