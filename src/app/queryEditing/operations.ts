/** Pure, explicit Query edits (ADR-0032). No UI or execution ownership. */
import { pairsToOn, type JoinKeyPair } from "../../lib/joinKeys";
import {
  isExternalTarget, localTargetId, syncSourcesFromQueries, targetKey,
  type JoinType, type ObjectTarget, type Project, type QueryDef, type TransformationStep,
} from "../../types/pipeline";

export type QuerySelection = { queryId: string | null; stepIndex: number | null };
export type QueryEditError = {
  code: "invalid_query_id" | "duplicate_query_id" | "query_not_found" |
    "invalid_reference" | "self_join" | "invalid_step_index" | "root_required" | "stale_query";
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

export function removeQuery(project: Project, input: {
  queryId: string;
  selection?: QuerySelection;
}): QueryEditResult {
  const error = queryError(project, input.queryId);
  if (error) return { ok: false, project, error };
  if (!project.workspace.queries.some(q => q.id === input.queryId)) return success(project);
  const queries = project.workspace.queries.filter(q => q.id !== input.queryId).map(q => {
    const steps = q.steps.flatMap((step): TransformationStep[] => {
      if (step.type === "Join" && localTargetId(step.payload.right_query_id) === input.queryId) return [];
      if (step.type === "FromQuery" && localTargetId(step.payload.query_id) === input.queryId) return [];
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
  const next = { ...withQueries(project, queries), canvas: { ...project.canvas, positions } };
  const selected = input.selection;
  let navigation: QuerySelection | undefined;
  if (selected?.queryId === input.queryId) {
    const first = queries[0];
    navigation = { queryId: first?.id ?? null, stepIndex: first?.steps.length ? first.steps.length - 1 : null };
  } else if (selected?.queryId) {
    const before = project.workspace.queries.find(q => q.id === selected.queryId);
    const after = queries.find(q => q.id === selected.queryId);
    if (before && after && before !== after && selected.stepIndex !== null) {
      const oldStep = before.steps[selected.stepIndex];
      const retained = oldStep ? after.steps.indexOf(oldStep) : -1;
      navigation = {
        queryId: after.id,
        stepIndex: retained >= 0 ? retained : after.steps.length
          ? Math.min(selected.stepIndex, after.steps.length - 1) : null,
      };
    }
  }
  return success(project, next, navigation);
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
