import type { Workspace } from "../types/pipeline";

/** Scenario instructions, not catalog discovery metadata (ADR-0046). */
export const RECON_TASK = {
  title: "Why don't these SKUs match?",
  problem: "Sales uses commercial SKU codes; the product reference uses plant product IDs. The original join leaves keys unmatched.",
  action: "Inspect the Join step, then open Join Lens → No match to see the evidence.",
  next: "The lab includes a partially prepared mapped example. Extend map_sku with the existing Mapping tools, then inspect the monthly reconciliation. The example is not a verified fix.",
};

export type LabTaskSession = { projectUid: string; visible: boolean };
export function startLabTask(labId: string, projectUid: string | undefined): LabTaskSession | null {
  return labId === "recon_ship_sales" && projectUid ? { projectUid, visible: true } : null;
}
export function ownsLabTask(task: LabTaskSession | null, projectUid: string | undefined): boolean {
  return !!task && task.projectUid === projectUid;
}
export function reconJoinTarget(workspace: Workspace): { queryId: string; stepIndex: number } | null {
  const query = workspace.queries.find((q) => q.id === "dirty_recon");
  const stepIndex = query?.steps.findIndex((s) => s.type === "Join") ?? -1;
  return query && stepIndex >= 0 ? { queryId: query.id, stepIndex } : null;
}
