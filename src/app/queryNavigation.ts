import type { Project, QueryDef, TransformationStep, Workspace } from "../types/pipeline";
import { targetKey } from "../types/pipeline";

/** Renderer-only selection, never a project document or an execution scheduler. */
export type QueryContext = {
  projectUid: string | undefined;
  queryId: string | null;
  stepIndex: number | null;
  view: string;
  mode: string;
  workspace: Workspace;
  connections?: Project["connections"];
  sources?: Project["sources"];
  projectFile?: string;
  revision: number;
};
export type QueryContextInput = Omit<QueryContext, "revision">;

export function transitionQueryContext(previous: QueryContext | null, input: QueryContextInput, explicitNavigation = false): QueryContext {
  if (!explicitNavigation && previous && previous.projectUid === input.projectUid && previous.queryId === input.queryId &&
    previous.stepIndex === input.stepIndex && previous.view === input.view &&
    previous.mode === input.mode && previous.workspace === input.workspace &&
    previous.connections === input.connections && previous.sources === input.sources &&
    previous.projectFile === input.projectFile) return previous;
  return { ...input, revision: (previous?.revision ?? 0) + 1 };
}

export function isCurrentQueryContext(captured: QueryContext, current: QueryContext): boolean {
  return captured === current;
}

export type JoinNavigationTarget = {
  projectUid: string | undefined;
  hostQueryId: string;
  joinStepIndex: number;
  /** Structural input revision, not a new persisted step identifier. */
  inputRevision: string;
};

function joinInputRevision(workspace: Workspace, host: QueryDef, index: number): string | null {
  const step = host.steps[index];
  if (step?.type !== "Join") return null;
  const right = workspace.queries.find((q) => q.id === targetKey(step.payload.right_query_id));
  if (!right) return null;
  // Include transitive query inputs and all JOIN semantics, not just key names.
  // Exclude map bodies: acknowledged map edits should still allow result inspection.
  const definitions: [string, TransformationStep[]][] = [];
  const seen = new Set<string>([host.id]);
  function visit(steps: TransformationStep[]): boolean {
    for (const s of steps) {
      const targets = s.type === "FromQuery" ? [s.payload.query_id] :
        s.type === "Join" ? [s.payload.right_query_id] : s.type === "Append" ? s.payload.other_query_ids : [];
      for (const target of targets) {
        const id = targetKey(target);
        if (seen.has(id)) continue;
        const q = workspace.queries.find((q) => q.id === id);
        if (!q) return false;
        seen.add(id);
        definitions.push([id, q.steps]);
        if (!visit(q.steps)) return false;
      }
    }
    return true;
  }
  const steps = host.steps.slice(0, index + 1);
  return visit(steps) ? JSON.stringify([steps, definitions]) : null;
}

export function captureJoinTarget(project: Project, hostQueryId: string, joinStepIndex: number): JoinNavigationTarget | null {
  const host = project.workspace.queries.find((q) => q.id === hostQueryId);
  const inputRevision = host && joinInputRevision(project.workspace, host, joinStepIndex);
  return inputRevision ? { projectUid: project.project_uid, hostQueryId, joinStepIndex, inputRevision } : null;
}

export function joinTargetUnavailable(project: Project, target: JoinNavigationTarget | null | undefined): string | null {
  if (!target) return "Original Join unavailable: this session has no Lens target.";
  if (target.projectUid !== project.project_uid) return "Original Join unavailable: the project has changed.";
  const current = captureJoinTarget(project, target.hostQueryId, target.joinStepIndex);
  return current?.inputRevision === target.inputRevision ? null :
    "Original Join unavailable: its query or Join inputs were removed or changed. Open matching again from the intended Join.";
}

export type QueryDestination = {
  query: QueryDef;
  stepIndex: number | null;
  step: TransformationStep | undefined;
  view?: "data" | "model";
  lens?: boolean;
  focusLens?: boolean;
};
export type OpenQueryOptions = Pick<QueryDestination, "view" | "lens" | "focusLens"> & { stepIndex?: number | null };

export function resolveQueryDestination(workspace: Workspace, queryId: string, options: OpenQueryOptions = {}): QueryDestination | null {
  const query = workspace.queries.find((q) => q.id === queryId);
  if (!query) return null;
  const index = options.stepIndex === undefined ? (query.steps.length ? query.steps.length - 1 : null) : options.stepIndex;
  if (index !== null && (!Number.isInteger(index) || index < 0 || !query.steps[index])) return null;
  return { ...options, query, stepIndex: index, step: index === null ? undefined : query.steps[index] };
}

/** Explicit, tiny scenario owner. Ports apply effects; no bus/store/React dependency. */
export function createQueryNavigation(ports: {
  project: () => Project;
  select: (destination: QueryDestination) => void;
  openMapping: (mapId: string) => void;
  openMatching: (sessionId: string) => void;
}) {
  return {
    openQuery(queryId: string, options?: OpenQueryOptions): boolean {
      const destination = resolveQueryDestination(ports.project().workspace, queryId, options);
      if (!destination) return false;
      ports.select(destination);
      return true;
    },
    inspectJoin(target: JoinNavigationTarget | null | undefined, options: OpenQueryOptions = {}): boolean {
      const project = ports.project();
      if (joinTargetUnavailable(project, target) || !target) return false;
      const destination = resolveQueryDestination(project.workspace, target.hostQueryId,
        { ...options, stepIndex: target.joinStepIndex, view: "data", lens: true });
      if (!destination) return false;
      ports.select(destination);
      return true;
    },
    openMapping(mapId: string): boolean {
      if (!ports.project().workspace.key_maps?.some((m) => m.id === mapId)) return false;
      ports.openMapping(mapId);
      return true;
    },
    openMatching(sessionId: string) { ports.openMatching(sessionId); },
  };
}
