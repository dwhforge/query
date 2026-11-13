import type { Workspace } from "../types/pipeline";

/** Scenario instructions, not catalog discovery metadata (ADR-0046). */
export const RECON_TASK = {
  title: "Why don't these SKUs match?",
  problem: "Sales uses commercial SKU codes; the product reference uses plant product IDs. The original join leaves keys unmatched.",
  action: "Inspect the Join step, then open Join Lens → No match to see the evidence.",
  next: "The lab includes a partially prepared mapped example. Extend map_sku with the existing Mapping tools, then inspect the monthly reconciliation. The example is not a verified fix.",
};

export type LabTaskSession = { projectUid: string; visible: boolean; hints?: boolean; completed?: boolean };
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

export function reconHintPhase(task: LabTaskSession | null, workspace: Workspace,
  activeQueryId: string | null, selectedStepIndex: number | null): "off" | "find_join" | "open_no_match" | "done" {
  if (!task?.visible || !task.hints) return "off";
  if (task.completed) return "done";
  const target = reconJoinTarget(workspace);
  return target && activeQueryId === target.queryId && selectedStepIndex === target.stepIndex
    ? "open_no_match" : "find_join";
}

export type ReconView = "original" | "mapped" | "monthly";
export function reconComparisonTargets(workspace: Workspace) {
  return ([
    { view: "original", queryId: "dirty_recon", label: "Inspect original join" },
    { view: "mapped", queryId: "sales_mapped", label: "Inspect mapped example" },
    { view: "monthly", queryId: "recon_by_month", label: "Inspect monthly reconciliation" },
  ] as const).map((item) => {
    const query = workspace.queries.find((q) => q.id === item.queryId);
    const stepIndex = item.view === "original" ? reconJoinTarget(workspace)?.stepIndex ?? -1 : (query?.steps.length ?? 0) - 1;
    return { ...item, stepIndex, available: !!query && stepIndex >= 0 };
  });
}
