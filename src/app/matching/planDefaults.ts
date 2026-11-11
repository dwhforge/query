/**
 * Matching plan defaults from Join Lens context (ADR-0044).
 * Prefer id-like target identity; seed one soft comparison per Join ON pair.
 */
import { localTargetId, type Workspace } from "../../types/pipeline";
import type { MatchingPlanDraft, MatchingScopeKind } from "./types";

/** Prefer vendor_id / *_id / id over bare labels like vendor_name. */
export function preferIdentityFields(columns: string[]): string[] {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of columns) {
    const l = c.toLowerCase();
    let score = 0;
    if (l === "id") score = 3;
    else if (l.endsWith("_id") || l.endsWith("_sk") || l.endsWith("_pk"))
      score = 4;
    else if (/(^|_)id($|_)/.test(l) && !l.includes("name")) score = 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) return [best];
  return columns[0] ? [columns[0]] : [];
}

/** Walk steps before the Join for the nearest FromQuery parent. */
export function resolveLeftSourceQueryId(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
): string {
  const q = workspace.queries.find((x) => x.id === hostQueryId);
  if (!q) return hostQueryId;
  for (let i = joinStepIndex - 1; i >= 0; i--) {
    const step = q.steps[i];
    if (step?.type === "FromQuery") {
      return localTargetId(step.payload.query_id) ?? hostQueryId;
    }
  }
  return hostQueryId;
}

export function buildLensMatchingPlan(args: {
  leftOn: string[];
  rightOn: string[];
  sourceRef: string;
  targetRef: string;
  sourceColumns?: string[];
  targetColumns?: string[];
  scope: MatchingScopeKind;
}): MatchingPlanDraft {
  const n = Math.min(args.leftOn.length, args.rightOn.length);
  const comparisons = Array.from({ length: Math.max(n, 1) }, (_, i) => ({
    sourceField: args.leftOn[i] ?? "",
    targetField: args.rightOn[i] ?? "",
    role: "soft_signal" as const,
  }));
  const targetCols =
    args.targetColumns && args.targetColumns.length > 0
      ? args.targetColumns
      : [...args.rightOn];
  const identity = preferIdentityFields(targetCols);
  return {
    sourceRef: args.sourceRef,
    targetRef: args.targetRef,
    mapKeyFields: args.leftOn.length ? [...args.leftOn] : [],
    targetIdentityFields: identity,
    comparisons,
    normalization: ["trim", "casefold"],
    outputs: [...identity],
    ambiguity: "leave_for_manual",
    scope: args.scope,
    semanticRevision: 1,
    uiRevision: 0,
  };
}
