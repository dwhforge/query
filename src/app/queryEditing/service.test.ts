import { emptyProject, type Project } from "../../types/pipeline";
import { resolveQueryDestination } from "../queryNavigation";
import { createQueryEditingService, type QueryEditResult } from "./service";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function fixture(): Project {
  return freeze({
    ...emptyProject("Service"), id: "p", project_uid: "uid", sources: [],
    workspace: { focus_query_id: "a", key_maps: [],
      queries: [
        { id: "a", name: "A", steps: [
          { type: "SqlModel", payload: { raw_sql: "select 1 as id" } },
          { type: "Filter", payload: { condition: "true" } },
          { type: "Limit", payload: { n: 10 } },
        ] },
        { id: "b", name: "B", steps: [{ type: "SqlModel", payload: { raw_sql: "select 2 as id" } }] },
      ] },
  } as Project);
}
function ok(result: QueryEditResult) {
  assert(result.ok, "Expected successful standalone operation");
  return result;
}
function rejected(result: QueryEditResult, project: Project, code: string) {
  assert(!result.ok, "Expected controlled refusal");
  equal(result.error.code, code, "error code");
  assert(result.project === project, "refused operation retains exact original snapshot");
  assert(!("navigation" in result), "refused operation cannot navigate");
}

{
  const original = fixture();
  const service = createQueryEditingService(original);
  equal(Object.keys(service).sort(), [
    "appendStep", "applyJoin", "deriveQuery", "moveStep", "removeEdge", "removeQuery", "removeStep", "replaceStep", "revision",
  ], "only existing operations and revision, no UI/store ports");
  const revision = service.revision("a");
  assert(revision !== null, "revision available for target");
  const joined = ok(service.applyJoin({ queryId: "a", right: "b",
    pairs: [{ left: "id", right: "id" }], expectedRevision: revision }));
  const destination = joined.navigation;
  assert(destination?.queryId && destination.stepIndex !== null, "JOIN navigation intent");
  const resolved = resolveQueryDestination(joined.project.workspace, destination.queryId,
    { stepIndex: destination.stepIndex });
  assert(resolved?.step?.type === "Join", "existing semantic navigation resolves committed JOIN");
  assert(resolveQueryDestination(original.workspace, destination.queryId,
    { stepIndex: destination.stepIndex }) === null, "intent is for result graph, not original graph");
  assert(original.workspace.queries[0]!.steps.length === 3, "original snapshot unchanged");
  const repeated = ok(service.applyJoin({ queryId: "a", right: "b",
    pairs: [{ left: "id", right: "id" }], expectedRevision: revision }));
  equal(repeated.project, joined.project, "same bound input has same output, not hidden accumulated state");
  assert(service.revision("a") === revision, "service did not advance its snapshot");
  const rebound = createQueryEditingService(freeze(joined.project));
  assert(rebound.revision("a") !== revision, "new snapshot has new revision");
  const same = ok(rebound.applyJoin({ queryId: "a", right: "b", pairs: [{ left: "id", right: "id" }] }));
  assert(!same.changed && same.project === joined.project, "repeated committed operation is no-op");
}

{
  const original = fixture();
  const service = createQueryEditingService(original);
  const expectedRevision = service.revision("a")!;
  const edited = ok(service.replaceStep({ queryId: "a", index: 1,
    step: { type: "Filter", payload: { condition: "id > 0" } } }));
  const current = freeze(edited.project);
  const bound = createQueryEditingService(current);
  const before = JSON.stringify(current);
  const stale: QueryEditResult[] = [
    bound.deriveQuery({ queryId: "a", expectedRevision }),
    bound.removeEdge({ queryId: "a", kind: "join", other: "b", expectedRevision }),
    bound.removeQuery({ queryId: "a", expectedRevision }),
    bound.applyJoin({ queryId: "a", right: "b", pairs: [], expectedRevision }),
    bound.replaceStep({ queryId: "a", index: 1, step: { type: "Filter", payload: { condition: "false" } }, expectedRevision }),
    bound.moveStep({ queryId: "a", index: 1, direction: 1, expectedRevision }),
    bound.appendStep({ queryId: "a", step: { type: "Limit", payload: { n: 5 } }, expectedRevision }),
    bound.removeStep({ queryId: "a", index: 1, selectedIndex: 1, expectedRevision }),
  ];
  for (const result of stale) rejected(result, current, "stale_query");
  equal(JSON.stringify(current), before, "stale calls did not mutate new snapshot");
  equal(original.workspace.queries[0]!.steps[1], { type: "Filter", payload: { condition: "true" } },
    "stale calls did not mutate older snapshot either");
  // Unrelated Query changes do not falsely invalidate this target token.
  const peerEdit = ok(service.replaceStep({ queryId: "b", index: 0,
    step: { type: "SqlModel", payload: { raw_sql: "select 3 as id" } } }));
  const peerService = createQueryEditingService(peerEdit.project);
  assert(peerService.revision("a") === expectedRevision, "revision is target-local");
  ok(peerService.appendStep({ queryId: "a", step: { type: "Limit", payload: { n: 7 } }, expectedRevision }));
  const otherProject = freeze({ ...original, project_uid: "replacement" });
  rejected(createQueryEditingService(otherProject).appendStep({
    queryId: "a", step: { type: "Limit", payload: { n: 5 } }, expectedRevision,
  }), otherProject, "stale_query");
}

{
  const original = fixture();
  const service = createQueryEditingService(original);
  assert(service.revision("missing") === null, "missing revision unavailable");
  rejected(service.replaceStep({ queryId: "missing", index: 0,
    step: { type: "Limit", payload: { n: 1 } } }), original, "query_not_found");
  rejected(service.applyJoin({ queryId: "a", right: "missing", pairs: [] }), original, "query_not_found");
  rejected(service.removeQuery({ queryId: "" }), original, "invalid_query_id");
  const withoutUiSelection = ok(service.removeStep({ queryId: "a", index: 1 }));
  assert(withoutUiSelection.project.workspace.queries[0]!.steps.length === 2,
    "tool operation does not require an editor selection");
  const absent = ok(service.removeQuery({ queryId: "missing" }));
  assert(!absent.changed && absent.project === original, "unguarded absent deletion keeps domain no-op");
  rejected(service.removeQuery({ queryId: "missing", expectedRevision: "previous target" }), original, "stale_query");
  const duplicate = freeze({ ...original, workspace: { ...original.workspace,
    queries: [...original.workspace.queries, original.workspace.queries[0]!] } });
  const ambiguous = createQueryEditingService(duplicate);
  assert(ambiguous.revision("a") === null, "ambiguous revision unavailable");
  rejected(ambiguous.appendStep({ queryId: "a", step: { type: "Limit", payload: { n: 1 } } }),
    duplicate, "duplicate_query_id");
}

{
  // Minimal non-React adapter: explicitly rebind after each acknowledged commit.
  const original = fixture();
  const added = ok(createQueryEditingService(original).appendStep({
    queryId: "a", step: { type: "Filter", payload: { condition: "id = 1" } },
  }));
  const joined = ok(createQueryEditingService(added.project).applyJoin({
    queryId: "a", right: "b", pairs: [],
  }));
  equal(joined.navigation, { queryId: "a", stepIndex: 4 }, "latest result drives selection");
  const removed = ok(createQueryEditingService(joined.project).removeQuery({ queryId: "b" }));
  assert(removed.project.workspace.queries[0]!.steps.length === 4, "delete scrub retains prior append");
  assert(joined.project.workspace.queries[0]!.steps.length === 5, "later edit cannot mutate old output");
  assert(original.workspace.queries[0]!.steps.length === 3, "original never changed");
}
console.log("QueryEditingService standalone tests passed (revision/errors/navigation/immutable snapshots)");
