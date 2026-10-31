import type { TransformationStep, Workspace } from "../types/pipeline";
import type { JoinPrepareStatus } from "./bridge";

/** Per-side row cap for auto-running Probe diagnostics. */
export const AUTO_DIAG_MAX_SIDE_ROWS = 100_000;

const EXPENSIVE = new Set([
  "GroupBy",
  "Join",
  "Append",
  "SqlModel",
  "CustomSql",
  "DeriveColumn",
]);

function stepExpensive(step: TransformationStep): boolean {
  return EXPENSIVE.has(step.type);
}

function stepHasHeavyFile(step: TransformationStep): boolean {
  return step.type === "LoadParquet";
}

function directDeps(steps: TransformationStep[]): string[] {
  const deps: string[] = [];
  for (const step of steps) {
    if (step.type === "FromQuery") deps.push(step.payload.query_id);
    else if (step.type === "Join") deps.push(step.payload.right_query_id);
    else if (step.type === "Append") deps.push(...step.payload.other_query_ids);
  }
  return deps;
}

function queryClosure(
  workspace: Workspace,
  rootId: string,
): TransformationStep[] {
  const byId = new Map(workspace.queries.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const stack = [rootId];
  const steps: TransformationStep[] = [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const q = byId.get(id);
    if (!q) continue;
    steps.push(...q.steps);
    for (const d of directDeps(q.steps)) stack.push(d);
  }
  return steps;
}

function joinSideSteps(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
): { left: TransformationStep[]; right: TransformationStep[] } | null {
  const host = workspace.queries.find((q) => q.id === hostQueryId);
  if (!host || joinStepIndex < 1 || joinStepIndex >= host.steps.length) {
    return null;
  }
  const join = host.steps[joinStepIndex];
  if (join?.type !== "Join") return null;
  const prefix = host.steps.slice(0, joinStepIndex);
  const left: TransformationStep[] = [...prefix];
  for (const d of directDeps(prefix)) {
    left.push(...queryClosure(workspace, d));
  }
  const right = queryClosure(workspace, join.payload.right_query_id);
  return { left, right };
}

/**
 * Graph looks like a tiny CSV fixture (known local files).
 * Do NOT treat LoadPostgres / LoadDuckdb as small — row counts are unknown.
 */
export function joinLooksFixtureSmall(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
): boolean {
  const sides = joinSideSteps(workspace, hostQueryId, joinStepIndex);
  if (!sides) return false;
  const all = [...sides.left, ...sides.right];
  if (all.length === 0) return false;
  if (all.some(stepExpensive) || all.some(stepHasHeavyFile)) return false;
  // Only local CSV — PG/DuckDB tables may be huge with no size hint.
  return all.every((s) => s.type === "LoadCsv");
}

/**
 * Whether Probe may auto-run diagnostics without a multi-minute scan.
 * Prefer prepared TEMP row counts; fall back to CSV-shaped fixture graphs.
 */
export function shouldAutoRunJoinDiagnostics(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  prepare: Pick<
    JoinPrepareStatus,
    | "prepared"
    | "left_rows"
    | "right_rows"
    | "left_materialized"
    | "right_materialized"
  > | null,
): boolean {
  if (
    prepare?.prepared &&
    prepare.left_materialized &&
    prepare.right_materialized
  ) {
    const L = Number(prepare.left_rows ?? 0);
    const R = Number(prepare.right_rows ?? 0);
    return L <= AUTO_DIAG_MAX_SIDE_ROWS && R <= AUTO_DIAG_MAX_SIDE_ROWS;
  }
  return joinLooksFixtureSmall(workspace, hostQueryId, joinStepIndex);
}
