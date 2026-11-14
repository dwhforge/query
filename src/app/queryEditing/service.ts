/** Snapshot-bound Query mutations for UI or future tool adapters (ADR-0032). */
import type { Project } from "../../types/pipeline";
import {
  appendStep, applyJoin, deriveQuery, moveStep, removeEdge, removeQuery, removeStep, replaceStep,
  type QueryEditResult,
} from "./operations";
export type { QueryEditResult } from "./operations";

type ExpectedRevision = { expectedRevision?: string };
type Input<F extends (...args: never[]) => unknown> = Parameters<F>[1] & ExpectedRevision;

/** Target definition token, not a whole-workspace or warehouse freshness claim. */
function queryRevision(project: Project, queryId: string): string | null {
  const matches = project.workspace.queries.filter(q => q.id === queryId);
  return matches.length === 1
    ? JSON.stringify([project.id, project.project_uid, matches[0]]) : null;
}

/**
 * No commit or mutable current-project port. Bind the reducer's latest snapshot;
 * standalone callers explicitly use result.project to bind their next edit.
 */
export function createQueryEditingService(project: Project) {
  function run(input: { queryId: string } & ExpectedRevision,
    operation: () => QueryEditResult): QueryEditResult {
    const result = operation();
    // Domain validation is authoritative; never duplicate its graph rules here.
    if (!result.ok) return result;
    if (input.expectedRevision !== undefined &&
      input.expectedRevision !== queryRevision(project, input.queryId)) {
      return { ok: false, project, error: {
        code: "stale_query",
        message: "Query changed since this edit was prepared. Refresh the target and retry.",
      } };
    }
    return result;
  }
  return Object.freeze({
    revision: (queryId: string) => queryRevision(project, queryId),
    deriveQuery: (input: Input<typeof deriveQuery>) => run(input, () => deriveQuery(project, input)),
    removeEdge: (input: Input<typeof removeEdge>) => run(input, () => removeEdge(project, input)),
    removeQuery: (input: Input<typeof removeQuery>) => run(input, () => removeQuery(project, input)),
    applyJoin: (input: Input<typeof applyJoin>) => run(input, () => applyJoin(project, input)),
    replaceStep: (input: Input<typeof replaceStep>) => run(input, () => replaceStep(project, input)),
    moveStep: (input: Input<typeof moveStep>) => run(input, () => moveStep(project, input)),
    appendStep: (input: Input<typeof appendStep>) => run(input, () => appendStep(project, input)),
    removeStep: (input: Input<typeof removeStep>) => run(input, () => removeStep(project, input)),
  });
}

export type QueryEditingService = ReturnType<typeof createQueryEditingService>;
