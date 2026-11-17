/** Lossless JOIN-bound entry into full-scope dataset Matching.
 * LEFT is the original host query truncated immediately BEFORE its captured JOIN.
 * No UI-page, Basic tuple cap, or post-JOIN rows are accepted as LEFT evidence.
 * This is a read-only plan adapter; Mapping persistence stays in App's guarded path.
 */
import type { Workspace } from "../../types/pipeline";
import type { DatasetMatchingPlan } from "../../lib/bridge";
import type { MatchingTabSession } from "./types";

export type FullJoinContext = {
  workspace: Workspace;
  plan: DatasetMatchingPlan;
  locked: { sourceRef: string; targetRef: string; mapKeyFields: string[]; outputs: string[] };
};

// Project workspaces are immutable in App; a stable projection prevents repeated
// schema RPCs whenever unrelated App state re-renders a Matching tab.
const contextCache = new WeakMap<Workspace, Map<string, FullJoinContext>>();

export function fullJoinContext(workspace: Workspace, session: MatchingTabSession): FullJoinContext | null {
  const b = session.joinBinding;
  if (!b || session.executionMode !== "live") return null;
  // A self-JOIN needs a distinct preserved RIGHT query identity. Do not silently
  // replace its target with the pre-JOIN source representation.
  if (b.hostQueryId === b.rightQueryId) return null;
  const fingerprint = JSON.stringify([b, session.plan]);
  const cached = contextCache.get(workspace)?.get(fingerprint);
  if (cached) return cached;
  const query = workspace.queries.find(q => q.id === b.hostQueryId);
  if (!query || b.joinStepIndex <= 0 || b.joinStepIndex >= query.steps.length) return null;
  const step = query.steps[b.joinStepIndex];
  if (step?.type !== "Join" ||
      JSON.stringify(step.payload.left_on) !== JSON.stringify(b.leftOn) ||
      JSON.stringify(step.payload.right_on) !== JSON.stringify(b.rightOn)) return null;
  // External reference IDs are not interchangeable with local query IDs.
  // Falling back to a same-named local query would silently match the wrong RIGHT.
  if (typeof step.payload.right_query_id !== "string" || step.payload.right_query_id !== b.rightQueryId) return null;
  const target = workspace.queries.find(q => q.id === b.rightQueryId);
  if (!target) return null;
  // No output or identity rewriting: the JOIN's ordered keys and outputs
  // determine the Mapping shape even when similarity uses descriptive columns.
  const plan: DatasetMatchingPlan = {
    sourceRef: b.hostQueryId,
    targetRef: b.rightQueryId,
    mapKeyFields: [...b.leftOn],
    targetIdentityFields: session.plan?.targetIdentityFields.length
      ? [...session.plan.targetIdentityFields] : [...b.rightOn],
    outputs: [...b.rightOn],
    comparisons: session.plan?.comparisons.length
      ? session.plan.comparisons.map(c => ({ ...c }))
      : b.leftOn.map((sourceField, i) => ({sourceField, targetField: b.rightOn[i]!, role: "soft_signal" as const})),
    normalization: session.plan?.normalization.length ? [...session.plan.normalization] : ["trim", "casefold"],
    ambiguity: session.plan?.ambiguity ?? "leave_for_manual",
    scope: "full",
    semanticRevision: session.plan?.semanticRevision || 1,
    uiRevision: session.plan?.uiRevision ?? 0,
  };
  const trimmed = {...query, steps: query.steps.slice(0, b.joinStepIndex)};
  const context: FullJoinContext = {
    workspace: {...workspace, queries: workspace.queries.map(q => q.id === query.id ? trimmed : q), focus_query_id: query.id},
    plan,
    locked: {sourceRef: b.hostQueryId, targetRef: b.rightQueryId, mapKeyFields: [...b.leftOn], outputs: [...b.rightOn]},
  };
  const byPlan = contextCache.get(workspace) ?? new Map<string, FullJoinContext>();
  byPlan.set(fingerprint, context);
  contextCache.set(workspace, byPlan);
  return context;
}
