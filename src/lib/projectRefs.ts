import type {
  ObjectKind,
  ObjectTarget,
  Project,
  ProjectReference,
  QueryDef,
  TransformationStep,
  Workspace,
} from "../types/pipeline";
import {
  externalTarget,
  isExternalTarget,
  newQueryId,
  targetKey,
} from "../types/pipeline";
import type { ReferenceState } from "./bridge";

/** Ephemeral local id for preview/describe of an external right/parent. */
export const EXT_FOCUS_QUERY_ID = "__ext_focus__";

/**
 * Focus a workspace on a local query id, or wrap an external ObjectTarget in a
 * temporary FromQuery so `focus_query_id` stays a real local compiler id
 * (never the display key `xref:…`).
 */
export function workspaceFocusingObject(
  workspace: Workspace,
  target: ObjectTarget,
): Workspace {
  if (typeof target === "string") {
    const parsed = parseTargetKey(target);
    if (parsed && isExternalTarget(parsed)) {
      return workspaceFocusingObject(workspace, parsed);
    }
    return { ...workspace, focus_query_id: target };
  }
  if (!isExternalTarget(target)) {
    return workspace;
  }
  const wrap: QueryDef = {
    id: EXT_FOCUS_QUERY_ID,
    name: targetKey(target),
    steps: [{ type: "FromQuery", payload: { query_id: target } }],
  };
  return {
    ...workspace,
    focus_query_id: EXT_FOCUS_QUERY_ID,
    queries: [
      ...workspace.queries.filter((q) => q.id !== EXT_FOCUS_QUERY_ID),
      wrap,
    ],
  };
}

/** Resolve a reference locator against the consumer project file. */
export function resolveOwnerPath(
  projectFile: string,
  locator: string,
): string {
  const trimmed = locator.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  const sep = projectFile.includes("\\") ? "\\" : "/";
  const parts = projectFile.split(/[/\\]/);
  parts.pop();
  for (const seg of trimmed.split(/[/\\]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join(sep);
}

export function referenceStateLabel(state: ReferenceState): string {
  switch (state) {
    case "ready":
      return "ready";
    case "update_available":
      return "update available";
    case "missing":
      return "missing";
    case "identity_mismatch":
      return "identity mismatch";
    case "incompatible_format":
      return "incompatible";
    case "invalid_dependency_graph":
      return "invalid graph";
    default:
      return state;
  }
}

export function referenceStateTone(state: ReferenceState): string {
  switch (state) {
    case "ready":
      return "text-teal-300";
    case "update_available":
      return "text-amber-300";
    default:
      return "text-rose-300";
  }
}

export type ExternalBoundary = {
  key: string;
  referenceId: string;
  alias: string;
  kind: ObjectKind;
  objectId: string;
  label: string;
};

/** External targets cited by local queries (canvas boundary nodes). */
export function collectExternalBoundaries(
  project: Project,
): ExternalBoundary[] {
  const refs = new Map(
    (project.references ?? []).map((r) => [r.id, r] as const),
  );
  const out = new Map<string, ExternalBoundary>();
  for (const q of project.workspace.queries) {
    for (const step of q.steps) {
      for (const t of stepExternalTargets(step)) {
        if (!isExternalTarget(t)) continue;
        const key = targetKey(t);
        if (out.has(key)) continue;
        const alias = refs.get(t.reference_id)?.alias ?? t.reference_id;
        out.set(key, {
          key,
          referenceId: t.reference_id,
          alias,
          kind: t.kind,
          objectId: t.id,
          label: `${alias}.${t.id}`,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function stepExternalTargets(step: TransformationStep): ObjectTarget[] {
  switch (step.type) {
    case "FromQuery":
      return [step.payload.query_id];
    case "Join":
      return [step.payload.right_query_id];
    case "Append":
      return step.payload.other_query_ids;
    case "ApplyKeyMap":
      return [step.payload.map_id];
    default:
      return [];
  }
}

/** Owner local targets become External on the same reference; keep nested external as-is. */
export function rewriteStepsForLocalCopy(
  steps: TransformationStep[],
  referenceId: string,
): TransformationStep[] {
  return steps.map((step) => rewriteStepForLocalCopy(step, referenceId));
}

function rewriteStepForLocalCopy(
  step: TransformationStep,
  referenceId: string,
): TransformationStep {
  switch (step.type) {
    case "FromQuery":
      return {
        ...step,
        payload: {
          query_id: localToExternal(step.payload.query_id, referenceId, "query"),
        },
      };
    case "Join":
      return {
        ...step,
        payload: {
          ...step.payload,
          right_query_id: localToExternal(
            step.payload.right_query_id,
            referenceId,
            "query",
          ),
        },
      };
    case "Append":
      return {
        ...step,
        payload: {
          other_query_ids: step.payload.other_query_ids.map((id) =>
            localToExternal(id, referenceId, "query"),
          ),
        },
      };
    case "ApplyKeyMap":
      return {
        ...step,
        payload: {
          ...step.payload,
          map_id: localToExternal(step.payload.map_id, referenceId, "mapping"),
          entries: [],
        },
      };
    default:
      return step;
  }
}

function localToExternal(
  target: ObjectTarget,
  referenceId: string,
  kind: ObjectKind,
): ObjectTarget {
  if (isExternalTarget(target)) return target;
  return externalTarget(referenceId, kind, target);
}

export function newQueryFromExternal(
  project: Project,
  target: ObjectTarget,
  nameHint: string,
): QueryDef {
  if (!isExternalTarget(target)) {
    throw new Error("expected an external target");
  }
  const refs = project.references ?? [];
  const alias =
    refs.find((r) => r.id === target.reference_id)?.alias ?? target.reference_id;
  const name = nameHint.trim() || `${alias}_${target.id}`;
  const id = newQueryId(name, project.workspace.queries.map((q) => q.id));
  return {
    id,
    name,
    steps: [{ type: "FromQuery", payload: { query_id: target } }],
  };
}

export function findReference(
  project: Project,
  referenceId: string,
): ProjectReference | undefined {
  return (project.references ?? []).find((r) => r.id === referenceId);
}

/** Inverse of [`targetKey`] for `xref:…` keys. */
export function parseTargetKey(key: string): ObjectTarget | null {
  if (!key.startsWith("xref:")) return null;
  const body = key.slice("xref:".length);
  const m = body.match(/^(.*?):(source|query|mapping):(.*)$/);
  if (!m) return null;
  const [, referenceId, kind, id] = m;
  if (!referenceId || !kind || !id) return null;
  return externalTarget(referenceId, kind as ObjectKind, id);
}
