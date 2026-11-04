/**
 * Mapping-check application use-cases (ADR-0027 / ADR-0032).
 * Pure IR / plan helpers — React applies the returned patches.
 */
import {
  applyFrozenRemapToMap,
  assertRemapConfirmable,
  attributeDelta,
  buildCheckRun,
  cohortInspectionQuery,
  cohortPredicateForTarget,
  cohortPredicateFromAttrCells,
  cohortPredicateFromCells,
  collectInputRevisions,
  deltaLabel,
  ensureLabCheck,
  keyMapRevision,
  labMappingCheck,
  newCheckId,
  upsertAllowDecision,
  type FrozenRemapPreview,
  type MappingCheck,
} from "../../lib/mappingCheck";
import {
  QUALITY_SAMPLE_COLUMN,
  type QualityCell,
} from "../../lib/mappingQuality";
import type { KeyMapDef, Project, QueryDef, Workspace } from "../../types/pipeline";
import type { CheckRun } from "../../types/mappingCheck";

export function resolveActiveMappingCheck(
  checks: MappingCheck[] | undefined,
): MappingCheck | null {
  const list = checks ?? [];
  return list.find((c) => c.id === "check_lab_quality") ?? list.at(-1) ?? null;
}

export type NewCheckInput = {
  checks: MappingCheck[];
  keyMaps: KeyMapDef[];
  queries: QueryDef[];
};

export type NewCheckResult =
  | { ok: true; check: MappingCheck; note: string }
  | { ok: false; error: string };

/** Build a new attrs MappingCheck for the first KeyMap + Join host. */
export function createMappingCheck(input: NewCheckInput): NewCheckResult {
  const map = input.keyMaps[0];
  if (!map) {
    return { ok: false, error: "Add a KeyMap before creating a mapping check." };
  }
  const host =
    input.queries.find(
      (q) => q.steps.length > 0 && q.steps[q.steps.length - 1]?.type === "Join",
    ) ?? null;
  const join = host?.steps[host.steps.length - 1];
  if (!host || join?.type !== "Join") {
    return {
      ok: false,
      error: "Need a query whose last step is Join (ApplyKeyMap host).",
    };
  }
  const left = join.payload.left_on[0] ?? "key";
  const right = join.payload.right_on[0] ?? "id";
  const check: MappingCheck = {
    id: newCheckId(input.checks.map((c) => c.id)),
    name: `Check · ${map.name}`,
    map_id: map.id,
    input_refs: [host.id],
    group_attributes: [left, right],
    cohort_predicate: "",
    projection: {
      kind: "attrs",
      host_query_id: host.id,
      left_attr: left,
      right_attr: right,
      sample_column: left,
    },
    allow_decisions: [],
  };
  return {
    ok: true,
    check,
    note: `Created ${check.name} · attrs ${left} ↔ ${right}`,
  };
}

export function appendMappingCheck(project: Project, check: MappingCheck): Project {
  return {
    ...project,
    mapping_checks: [...(project.mapping_checks ?? []), check],
  };
}

export type OverviewCell = Pick<
  QualityCell,
  "sourceFamily" | "targetFamily" | "signal" | "positions" | "revenue" | "samples"
>;

export type RecordCheckRunResult = {
  run: CheckRun;
  deltaNote: string;
  mapping_checks: MappingCheck[];
  mapping_check_runs: CheckRun[];
};

export function recordCheckRun(args: {
  project: Project;
  check: MappingCheck;
  cells: OverviewCell[];
  totalPositions: number;
}): RecordCheckRunResult {
  const { project, check, cells, totalPositions } = args;
  const map = (project.workspace.key_maps ?? []).find((m) => m.id === check.map_id);
  const run = buildCheckRun({
    check,
    workspace: project.workspace,
    map,
    cells: cells.map((c) => ({
      row: c.sourceFamily,
      column: c.targetFamily,
      signal: c.signal,
      positions: c.positions,
      revenue: c.revenue,
      samples: c.samples,
    })),
    totalPositions,
  });
  const prev = (project.mapping_check_runs ?? [])
    .filter((r) => r.check_id === check.id)
    .at(-1);
  const deltaNote = prev
    ? `${deltaLabel(attributeDelta(prev, run))}${
        run.comparability.kind === "limited"
          ? ` (${run.comparability.reason})`
          : ""
      } · positions ${prev.total_positions} → ${run.total_positions}`
    : `CheckRun recorded · ${run.total_positions.toLocaleString()} positions`;

  const mapping_checks =
    check.id === "check_lab_quality"
      ? ensureLabCheck(project.mapping_checks ?? [])
      : project.mapping_checks?.some((c) => c.id === check.id)
        ? (project.mapping_checks ?? [])
        : [...(project.mapping_checks ?? []), check];

  return {
    run,
    deltaNote,
    mapping_checks,
    mapping_check_runs: [...(project.mapping_check_runs ?? []), run].slice(-20),
  };
}

export type AllowResult =
  | { ok: true; mapping_checks: MappingCheck[]; allowNote: string }
  | { ok: false; error: string };

export function allowCheckDifference(args: {
  checks: MappingCheck[];
  checkId: string;
  groupKey: string;
  explanation: string;
}): AllowResult {
  try {
    const checks =
      args.checkId === "check_lab_quality"
        ? ensureLabCheck(args.checks)
        : args.checks;
    const mapping_checks = checks.map((c) =>
      c.id === args.checkId
        ? upsertAllowDecision(c, args.groupKey, args.explanation)
        : c,
    );
    return {
      ok: true,
      mapping_checks,
      allowNote: `Allowed · ${args.groupKey}`,
    };
  } catch (reason) {
    return { ok: false, error: String(reason) };
  }
}

export type InspectPayload =
  | {
      kind: "matrix";
      cohortCells: QualityCell[];
      samples: string[];
    }
  | { kind: "target"; targetKey: string; samples: string[] };

export type InspectPlan = {
  mapping_checks: MappingCheck[];
  sampleQuery: QueryDef;
  sampleColumn: string;
  orderedKeys: string[];
  frozenRemap: FrozenRemapPreview | null;
  progressPhase: string;
};

export function planCheckInspect(args: {
  project: Project;
  check: MappingCheck;
  payload: InspectPayload;
}): InspectPlan {
  const { project, check, payload } = args;
  const sampleColumn =
    check.projection.kind === "attrs"
      ? check.projection.sample_column
      : QUALITY_SAMPLE_COLUMN;
  const orderedKeys = [...new Set(payload.samples)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24);
  const predicate =
    payload.kind === "target"
      ? cohortPredicateForTarget(payload.targetKey)
      : check.projection.kind === "attrs"
        ? cohortPredicateFromAttrCells(
            check.projection.left_attr,
            check.projection.right_attr,
            payload.cohortCells,
          )
        : cohortPredicateFromCells(payload.cohortCells);

  const baseChecks =
    check.id === "check_lab_quality"
      ? ensureLabCheck(project.mapping_checks ?? [])
      : (project.mapping_checks ?? []);
  const mapping_checks = baseChecks.map((c) =>
    c.id === check.id ? { ...c, cohort_predicate: predicate } : c,
  );
  const checkWithPred = { ...check, cohort_predicate: predicate };
  const sampleQuery = cohortInspectionQuery(project.workspace, checkWithPred);
  const map = (project.workspace.key_maps ?? []).find((m) => m.id === check.map_id);
  const frozenRemap: FrozenRemapPreview | null = map
    ? {
        check_id: check.id,
        map_id: map.id,
        expected_map_revision: keyMapRevision(map),
        expected_input_revisions: collectInputRevisions(
          project.workspace,
          checkWithPred,
        ),
        changes: [],
        previewed_at: new Date().toISOString(),
      }
    : null;

  return {
    mapping_checks,
    sampleQuery,
    sampleColumn,
    orderedKeys,
    frozenRemap,
    progressPhase: `Opening check cohort${
      orderedKeys.length ? ` (${orderedKeys.length} sample keys)` : ""
    }…`,
  };
}

export type ConfirmRemapResult =
  | { ok: true; nextMap: KeyMapDef; message: string }
  | { ok: false; error: string };

export function confirmFrozenCheckRemap(args: {
  frozen: FrozenRemapPreview;
  workspace: Workspace;
  checks: MappingCheck[];
}): ConfirmRemapResult {
  const { frozen, workspace, checks } = args;
  try {
    const map = (workspace.key_maps ?? []).find((m) => m.id === frozen.map_id);
    const check =
      checks.find((c) => c.id === frozen.check_id) ?? labMappingCheck();
    assertRemapConfirmable(frozen, map, workspace, check);
    if (!frozen.changes.length) {
      return {
        ok: false,
        error: "Stage at least one From→To in Join Lens before confirming.",
      };
    }
    const nextMap = applyFrozenRemapToMap(map!, frozen, workspace, check);
    return {
      ok: true,
      nextMap,
      message: `Check remap confirmed · ${frozen.changes.length} link(s) via KeyMap`,
    };
  } catch (reason) {
    return { ok: false, error: String(reason) };
  }
}

/** Stage From→To pairs onto a frozen remap preview (Join Lens). */
export function stageFrozenRemapChanges(
  prev: FrozenRemapPreview,
  fromValues: string[],
  toValues: string[],
): FrozenRemapPreview {
  const staged = [...prev.changes];
  for (let i = 0; i < fromValues.length; i++) {
    const from = fromValues[i]?.trim();
    const to = toValues[i]?.trim();
    if (!from || to == null || to === "") continue;
    const idx = staged.findIndex((c) => c.from === from);
    if (idx >= 0) staged[idx] = { from, to };
    else staged.push({ from, to });
  }
  return { ...prev, changes: staged };
}
