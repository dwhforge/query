/** Pure, explicit Query edits (ADR-0032). No UI or execution ownership. */
import { pairsToOn, type JoinKeyPair } from "../../lib/joinKeys";
import { directUpstreamQueryIds, extractQueryPlaceholders } from "../mappingCreate/service";
import { QUALITY_JOIN } from "../../lib/mappingQuality";
import {
  isExternalTarget, localTargetId, newQueryId, syncSourcesFromQueries, targetKey,
  type JoinType, type ObjectTarget, type Project, type QueryDef, type TransformationStep,
} from "../../types/pipeline";

export type QuerySelection = { queryId: string | null; stepIndex: number | null };
export type QueryEditError = {
  code: "invalid_query_id" | "duplicate_query_id" | "query_not_found" |
    "invalid_reference" | "self_join" | "invalid_step_index" | "root_required" | "stale_query" | "query_in_use";
  message: string;
};
export type QueryEditResult =
  | { ok: true; project: Project; changed: boolean; navigation?: QuerySelection }
  | { ok: false; project: Project; error: QueryEditError };

function validId(id: string) {
  return Boolean(id.trim()) && id === id.trim() && !id.startsWith("xref:");
}

function queryError(project: Project, id: string): QueryEditError | null {
  const seen = new Set<string>();
  for (const q of project.workspace.queries) {
    if (!validId(q.id)) return { code: "invalid_query_id", message: "Query IDs must be nonempty local IDs." };
    if (seen.has(q.id)) return { code: "duplicate_query_id", message: `Duplicate Query ID: ${q.id}` };
    seen.add(q.id);
  }
  if (!validId(id)) return { code: "invalid_query_id", message: "Choose a valid local Query ID." };
  return null;
}

function failure(project: Project, code: QueryEditError["code"], message: string): QueryEditResult {
  return { ok: false, project, error: { code, message } };
}

function success(project: Project, next = project, navigation?: QuerySelection): QueryEditResult {
  return { ok: true, project: next, changed: next !== project, ...(navigation ? { navigation } : {}) };
}

function withQueries(project: Project, queries: QueryDef[]): Project {
  const focus = project.workspace.focus_query_id;
  return {
    ...project,
    sources: syncSourcesFromQueries(project.sources, queries),
    workspace: {
      ...project.workspace, queries,
      focus_query_id: queries.some(q => q.id === focus) ? focus : queries[0]?.id ?? "",
    },
  };
}

export function isQueryRoot(step: TransformationStep): boolean {
  return step.type === "LoadCsv" || step.type === "LoadParquet" ||
    step.type === "LoadPostgres" || step.type === "LoadDuckdb" ||
    step.type === "FromQuery" || step.type === "SqlModel";
}

/** Durable owners must be rebound explicitly, never deleted as collateral. */
function protectedInputOwner(project: Project, queryId: string): string | null {
  const workspace = project.workspace;
  const byId = new Map(workspace.queries.map(q => [q.id, q]));
  function needs(id: string, seen = new Set<string>()): boolean {
    if (id === queryId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const query = byId.get(id);
    return !!query && directUpstreamQueryIds(query, workspace.key_maps).some(dep => needs(dep, seen));
  }
  for (const map of workspace.key_maps ?? []) {
    if (map.storage?.kind === "query" && needs(map.storage.query_id.trim())) {
      return `Mapping "${map.name}" needs this Query. Rebind or remove the Mapping first.`;
    }
  }
  for (const check of project.mapping_checks ?? []) {
    const host = check.projection.kind === "attrs" ? check.projection.host_query_id : QUALITY_JOIN;
    if ([...check.input_refs, host].some(id => needs(id))) {
      return `Mapping Check "${check.name}" needs this Query. Rebind or remove the check first.`;
    }
  }
  return null;
}

function selectionAfterSteps(before: QueryDef, after: QueryDef,
  selection?: QuerySelection): QuerySelection | undefined {
  if (selection?.queryId !== before.id || selection.stepIndex === null) return undefined;
  const oldIndex = selection.stepIndex;
  const retained = after.steps.indexOf(before.steps[oldIndex]!);
  return { queryId: after.id, stepIndex: retained >= 0 ? retained :
    after.steps.length ? Math.max(0, Math.min(oldIndex, after.steps.length - 1)) : null };
}

export function deriveQuery(project: Project, input: { queryId: string }): QueryEditResult {
  const error = queryError(project, input.queryId);
  if (error) return { ok: false, project, error };
  const source = project.workspace.queries.find(q => q.id === input.queryId);
  if (!source) return failure(project, "query_not_found", "Source Query no longer exists.");
  const used = new Set(project.workspace.queries.map(q => q.name));
  let name = `${source.name}_derived`;
  if (used.has(name)) {
    let n = 2;
    while (used.has(`${source.name}_${n}`)) n += 1;
    name = `${source.name}_${n}`;
  }
  const id = newQueryId(name, project.workspace.queries.map(q => q.id));
  const query: QueryDef = {
    id, name, steps: [{ type: "FromQuery", payload: { query_id: source.id } }],
  };
  return success(project, withQueries(project, [...project.workspace.queries, query]),
    { queryId: id, stepIndex: 0 });
}

export type QueryRemovalConsequence = {
  queryId: string; queryName: string; stepIndex: number;
  operation: "Join" | "Append"; action: "remove_step" | "remove_input";
};

/** Deletion confirmation covers the graph, not just the deleted definition. */
function removalRevision(project: Project, queryId: string): string {
  return JSON.stringify([project.id, project.project_uid, queryId, project.workspace.queries,
    project.workspace.key_maps, project.mapping_checks, project.outputs]);
}

/** Pure inspection; no proposed mutation is committed and hard blocks still win. */
export function prepareRemoveQuery(project: Project, input: { queryId: string }):
  | { ok: true; queryName: string; consequences: QueryRemovalConsequence[]; revision: string }
  | Extract<QueryEditResult, { ok: false }> {
  const result = removeQuery(project, input);
  if (!result.ok) return result;
  const consequences: QueryRemovalConsequence[] = [];
  for (const query of project.workspace.queries) {
    if (query.id === input.queryId) continue;
    query.steps.forEach((step, stepIndex) => {
      if (step.type === "Join" && localTargetId(step.payload.right_query_id) === input.queryId) {
        consequences.push({ queryId: query.id, queryName: query.name, stepIndex,
          operation: "Join", action: "remove_step" });
      } else if (step.type === "Append" &&
        step.payload.other_query_ids.some(id => localTargetId(id) === input.queryId)) {
        consequences.push({ queryId: query.id, queryName: query.name, stepIndex,
          operation: "Append", action: step.payload.other_query_ids.every(id => localTargetId(id) === input.queryId)
            ? "remove_step" : "remove_input" });
      }
    });
  }
  return { ok: true, queryName: project.workspace.queries.find(q => q.id === input.queryId)?.name ?? input.queryId,
    consequences, revision: removalRevision(project, input.queryId) };
}

export function removeQuery(project: Project, input: {
  queryId: string;
  selection?: QuerySelection;
  expectedRemovalRevision?: string;
}): QueryEditResult {
  const error = queryError(project, input.queryId);
  if (error) return { ok: false, project, error };
  if (!project.workspace.queries.some(q => q.id === input.queryId)) return success(project);
  for (const query of project.workspace.queries) {
    if (query.id === input.queryId) continue;
    const needsRoot = query.steps.some(step =>
      step.type === "FromQuery" && localTargetId(step.payload.query_id) === input.queryId);
    const needsSql = query.steps.some(step =>
      (step.type === "SqlModel" || step.type === "CustomSql") &&
      extractQueryPlaceholders(step.payload.raw_sql).includes(input.queryId));
    if (needsRoot || needsSql) return failure(project, "query_in_use",
      `Query "${query.name}" uses this Query ${needsRoot ? "as its From input" : "in SQL"}. Rebind or remove that Query first.`);
  }
  const owner = protectedInputOwner(project, input.queryId);
  if (owner) return failure(project, "query_in_use", owner);
  if (input.expectedRemovalRevision !== undefined && input.expectedRemovalRevision !== removalRevision(project, input.queryId)) {
    return failure(project, "stale_query", "Query graph changed since deletion was prepared. Review the consequences and retry.");
  }
  const queries = project.workspace.queries.filter(q => q.id !== input.queryId).map(q => {
    const steps = q.steps.flatMap((step): TransformationStep[] => {
      if (step.type === "Join" && localTargetId(step.payload.right_query_id) === input.queryId) return [];
      if (step.type === "Append") {
        const ids = step.payload.other_query_ids.filter(id => localTargetId(id) !== input.queryId);
        if (!ids.length) return [];
        if (ids.length !== step.payload.other_query_ids.length) {
          return [{ type: "Append", payload: { other_query_ids: ids } }];
        }
      }
      return [step];
    });
    return steps.length === q.steps.length && steps.every((s, i) => s === q.steps[i])
      ? q : { ...q, steps };
  });
  const positions = { ...(project.canvas?.positions ?? {}) };
  delete positions[input.queryId];
  const next = { ...withQueries(project, queries), canvas: { ...project.canvas, positions },
    ...(project.outputs?.includes(input.queryId)
      ? { outputs: project.outputs.filter(id => id !== input.queryId) } : {}) };
  const selected = input.selection;
  let navigation: QuerySelection | undefined;
  if (selected?.queryId === input.queryId) {
    const first = queries[0];
    navigation = { queryId: first?.id ?? null, stepIndex: first?.steps.length ? first.steps.length - 1 : null };
  } else if (selected?.queryId) {
    const before = project.workspace.queries.find(q => q.id === selected.queryId);
    const after = queries.find(q => q.id === selected.queryId);
    if (before && after && before !== after && selected.stepIndex !== null) {
      navigation = selectionAfterSteps(before, after, selected);
    }
  }
  return success(project, next, navigation);
}

export function removeEdge(project: Project, input: {
  queryId: string; kind: "join" | "from" | "append"; other: ObjectTarget;
  stepIndex?: number; selection?: QuerySelection;
}): QueryEditResult {
  return editSteps(project, input.queryId, query => {
    if (input.stepIndex !== undefined && !validIndex(query, input.stepIndex)) {
      return failure(project, "invalid_step_index", "Edge step no longer exists.");
    }
    const otherKey = targetKey(input.other);
    const steps = query.steps.flatMap((step, index): TransformationStep[] => {
      if (input.stepIndex !== undefined && index !== input.stepIndex) return [step];
      if (input.kind === "join" && step.type === "Join" && targetKey(step.payload.right_query_id) === otherKey) return [];
      if (input.kind === "from" && step.type === "FromQuery" && targetKey(step.payload.query_id) === otherKey) return [];
      if (input.kind === "append" && step.type === "Append") {
        const ids = step.payload.other_query_ids.filter(id => targetKey(id) !== otherKey);
        if (ids.length !== step.payload.other_query_ids.length) {
          return ids.length ? [{ type: "Append", payload: { other_query_ids: ids } }] : [];
        }
      }
      return [step];
    });
    if (steps.length === query.steps.length && steps.every((s, i) => s === query.steps[i])) return success(project);
    if (input.kind === "from" && steps.length && !isQueryRoot(steps[0]!)) {
      return failure(project, "root_required", "Cannot remove FromQuery while later steps remain — delete those steps first.");
    }
    const owner = protectedInputOwner(project, query.id);
    if (owner) return failure(project, "query_in_use", owner);
    if (!steps.length && (project.outputs?.includes(query.id) ||
      project.workspace.queries.some(q => q.id !== query.id &&
        directUpstreamQueryIds(q, project.workspace.key_maps).includes(query.id)))) {
      return failure(project, "query_in_use", "Other Queries or published outputs need this Query. Rebind them before clearing its input.");
    }
    return commitSteps(project, query, steps, selectionAfterSteps(query, { ...query, steps }, input.selection));
  });
}

export function applyJoin(project: Project, input: {
  queryId: string; right: ObjectTarget; pairs: JoinKeyPair[]; joinType?: JoinType;
}): QueryEditResult {
  const error = queryError(project, input.queryId);
  if (error) return { ok: false, project, error };
  const host = project.workspace.queries.find(q => q.id === input.queryId);
  if (!host) return failure(project, "query_not_found", "Host Query no longer exists.");
  if (isExternalTarget(input.right)) {
    const right = input.right;
    if (right.kind !== "query" || !right.id.trim() ||
      !project.references?.some(ref => ref.id === right.reference_id)) {
      return failure(project, "invalid_reference", "Referenced Query is not available in this project.");
    }
  } else {
    if (!validId(input.right)) return failure(project, "invalid_query_id", "Choose a valid right Query.");
    if (input.right === host.id) return failure(project, "self_join", "Cannot join a query to itself");
    if (!project.workspace.queries.some(q => q.id === input.right)) {
      return failure(project, "query_not_found", "Right Query no longer exists.");
    }
  }
  // Empty ON keys are intentional editable IR, never fabricated "id" keys.
  const step: TransformationStep = { type: "Join", payload: {
    right_query_id: input.right, join_type: input.joinType ?? "inner", ...pairsToOn(input.pairs),
  } };
  const existing = host.steps.findIndex(s =>
    s.type === "Join" && targetKey(s.payload.right_query_id) === targetKey(input.right));
  const index = existing >= 0 ? existing : host.steps.length;
  const navigation = { queryId: host.id, stepIndex: index };
  if (existing >= 0 && JSON.stringify(host.steps[existing]) === JSON.stringify(step)) {
    return success(project, project, navigation);
  }
  const steps = existing >= 0
    ? host.steps.map((s, i) => i === existing ? step : s) : [...host.steps, step];
  return success(project, withQueries(project, project.workspace.queries.map(q =>
    q === host ? { ...q, steps } : q)), navigation);
}

function editSteps(project: Project, queryId: string,
  edit: (query: QueryDef) => QueryEditResult): QueryEditResult {
  const error = queryError(project, queryId);
  if (error) return { ok: false, project, error };
  const query = project.workspace.queries.find(q => q.id === queryId);
  return query ? edit(query) : failure(project, "query_not_found", "Query no longer exists.");
}

function commitSteps(project: Project, query: QueryDef, steps: TransformationStep[],
  navigation?: QuerySelection): QueryEditResult {
  if (steps === query.steps) return success(project, project, navigation);
  return success(project, withQueries(project, project.workspace.queries.map(q =>
    q === query ? { ...q, steps } : q)), navigation);
}

function validIndex(query: QueryDef, index: number) {
  return Number.isInteger(index) && index >= 0 && index < query.steps.length;
}

export function replaceStep(project: Project, input: {
  queryId: string; index: number; step: TransformationStep;
}): QueryEditResult {
  return editSteps(project, input.queryId, query => {
    if (!validIndex(query, input.index)) return failure(project, "invalid_step_index", "Step no longer exists.");
    if (JSON.stringify(query.steps[input.index]) === JSON.stringify(input.step)) return success(project);
    return commitSteps(project, query, query.steps.map((s, i) => i === input.index ? input.step : s));
  });
}

export function moveStep(project: Project, input: {
  queryId: string; index: number; direction: -1 | 1;
}): QueryEditResult {
  return editSteps(project, input.queryId, query => {
    if (!validIndex(query, input.index)) return failure(project, "invalid_step_index", "Step no longer exists.");
    const nextIndex = input.index + input.direction;
    if (nextIndex < 0 || nextIndex >= query.steps.length ||
      (isQueryRoot(query.steps[0]!) && (input.index === 0 || nextIndex === 0))) return success(project);
    const steps = [...query.steps];
    [steps[input.index], steps[nextIndex]] = [steps[nextIndex]!, steps[input.index]!];
    return commitSteps(project, query, steps, { queryId: query.id, stepIndex: nextIndex });
  });
}

export function appendStep(project: Project, input: {
  queryId: string; step: TransformationStep;
}): QueryEditResult {
  return editSteps(project, input.queryId, query =>
    commitSteps(project, query, [...query.steps, input.step],
      { queryId: query.id, stepIndex: query.steps.length }));
}

export function removeStep(project: Project, input: {
  queryId: string; index: number; selectedIndex?: number | null;
}): QueryEditResult {
  return editSteps(project, input.queryId, query => {
    if (!validIndex(query, input.index)) return failure(project, "invalid_step_index", "Step no longer exists.");
    if (isQueryRoot(query.steps[input.index]!) && query.steps.length > 1) {
      return failure(project, "root_required", "Remove later steps first, or clear the query — root step is required.");
    }
    const steps = query.steps.filter((_, i) => i !== input.index);
    const selected = input.selectedIndex ?? null;
    const nextIndex = selected === null || !steps.length ? null :
      Math.min(selected >= input.index ? Math.max(0, selected - 1) : selected, steps.length - 1);
    return commitSteps(project, query, steps, { queryId: query.id, stepIndex: nextIndex });
  });
}
