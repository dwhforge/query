import type { Workspace } from "../types/pipeline";

export type PreviewPhase = "idle" | "queued" | "running" | "ready" | "cancelled" | "error";
export function previewStateMessage(phase: PreviewPhase): string {
  switch (phase) {
    case "queued": case "running": return "Computing preview…";
    case "cancelled": return "Preview cancelled. Recompute when ready.";
    case "error": return "Preview failed. See the error above, then recompute.";
    case "ready": return "No rows returned for this preview.";
    default: return "Select a query to preview its result.";
  }
}
export function previewScopeLabel(workspace: Workspace | null, activeQueryId: string | null, selectedStepIndex: number | null): string {
  const query = workspace?.queries.find((q) => q.id === activeQueryId);
  return query && selectedStepIndex !== null && query.steps[selectedStepIndex]?.type === "Join" && query.steps.length === selectedStepIndex + 1
    ? `${query.name} · through s${selectedStepIndex} Join` : `${query?.name ?? "Select a query"} · final output`;
}
