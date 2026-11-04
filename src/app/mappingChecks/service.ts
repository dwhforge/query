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
  findApplyKeyMapIdForJoin,
  fromPartsEff,
} from "../../lib/keyMap";
import type { KeyMapDirtyBaseline, KeyMapDirtyDelta } from "../../lib/bridge";
import {
  QUALITY_SAMPLE_COLUMN,
  type QualityCell,
} from "../../lib/mappingQuality";
import type { KeyMapDef, Project, QueryDef, Workspace } from "../../types/pipeline";
import { targetKey } from "../../types/pipeline";
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
  /** Required: map the check measures — not “first in list”. */
  mapId: string;
  /** Required: Join-host query that ApplyKeyMap-wires this map. */
  hostQueryId: string;
  leftAttr: string;
  rightAttr: string;
  sampleColumn?: string;
};

export type NewCheckResult =
  | { ok: true; check: MappingCheck; note: string }
  | { ok: false; error: string };

/**
 * Candidate Join hosts where ApplyKeyMap for `mapId` remaps a column that is
 * an input to that Join's left_on (same integrity as findApplyKeyMapIdForJoin).
 * Not a full cross-query right-side resolver — creation flow must still pick
 * explicitly among candidates.
 */
export function findJoinHostsForMap(
  queries: QueryDef[],
  mapId: string,
): Array<{
  host: QueryDef;
  joinStepIndex: number;
  leftOn: string[];
  rightOn: string[];
}> {
  const workspace: Workspace = {
    queries,
    focus_query_id: queries[0]?.id ?? "",
    key_maps: [],
  };
  const out: Array<{
    host: QueryDef;
    joinStepIndex: number;
    leftOn: string[];
    rightOn: string[];
  }> = [];
  for (const q of queries) {
    for (let i = 0; i < q.steps.length; i++) {
      const s = q.steps[i];
      if (s?.type !== "Join") continue;
      const bound = findApplyKeyMapIdForJoin(workspace, {
        hostQueryId: q.id,
        joinStepIndex: i,
        rightQueryId: targetKey(s.payload.right_query_id),
        leftOn: s.payload.left_on,
        rightOn: s.payload.right_on,
        probeSide: "left",
      });
      if (bound !== mapId) continue;
      out.push({
        host: q,
        joinStepIndex: i,
        leftOn: s.payload.left_on,
        rightOn: s.payload.right_on,
      });
    }
  }
  return out;
}

/**
 * Build an attrs MappingCheck for an explicit map ↔ Join-host ↔ attribute triple.
 * Refuses first-of-list heuristics (ADR-0027 binding integrity).
 */
export function createMappingCheck(input: NewCheckInput): NewCheckResult {
  const map = input.keyMaps.find((m) => m.id === input.mapId);
  if (!map) {
    return {
      ok: false,
      error: `KeyMap “${input.mapId}” not found — pick a map that exists in the project.`,
    };
  }
  const left = input.leftAttr.trim();
  const right = input.rightAttr.trim();
  if (!left || !right) {
    return {
      ok: false,
      error: "Choose left and right check attributes (Join keys or mapped columns).",
    };
  }
  const hosts = findJoinHostsForMap(input.queries, map.id);
  const hostHit = hosts.find((h) => h.host.id === input.hostQueryId);
  if (!hostHit) {
    return {
      ok: false,
      error: `Query “${input.hostQueryId}” has no ApplyKeyMap for map “${map.name}”. Pick a Join host that uses this map.`,
    };
  }
  const sample = (input.sampleColumn ?? left).trim() || left;
  const check: MappingCheck = {
    id: newCheckId(input.checks.map((c) => c.id)),
    name: `Check · ${map.name}`,
    map_id: map.id,
    input_refs: [hostHit.host.id],
    group_attributes: [left, right],
    cohort_predicate: "",
    projection: {
      kind: "attrs",
      host_query_id: hostHit.host.id,
      left_attr: left,
      right_attr: right,
      sample_column: sample,
    },
    allow_decisions: [],
  };
  return {
    ok: true,
    check,
    note: `Created ${check.name} · ${hostHit.host.name} · attrs ${left} ↔ ${right}`,
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
  cellsIncomplete?: boolean;
  groupCount?: number;
  coveredPositions?: number;
  unmappedPositions?: number;
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
    cellsIncomplete: args.cellsIncomplete,
    groupCount: args.groupCount,
    coveredPositions: args.coveredPositions,
    unmappedPositions: args.unmappedPositions,
  });
  const prev = (project.mapping_check_runs ?? [])
    .filter((r) => r.check_id === check.id)
    .at(-1);
  const attr = prev ? attributeDelta(prev, run) : null;
  // Truncated top-N cells must not invent zero for groups that fell out of budget.
  const cellNote =
    prev && !prev.cells_incomplete && !run.cells_incomplete
      ? summarizeCellDeltas(prev.cells, run.cells)
      : null;
  const truncNote =
    run.cells_incomplete && run.group_count != null
      ? ` · top ${run.cells.length}/${run.group_count} groups`
      : "";
  const deltaNote = prev
    ? `${deltaLabel(attr!)}${
        run.comparability.kind === "limited"
          ? ` (${run.comparability.reason})`
          : ""
      } · positions ${prev.total_positions} → ${run.total_positions}${
        cellNote ? ` · ${cellNote}` : ""
      }${truncNote}`
    : `CheckRun recorded · ${run.total_positions.toLocaleString()} positions${truncNote}`;

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
  | {
      ok: true;
      nextMap: KeyMapDef;
      /** Full-row upserts (attrs preserved) + baselines for source Save. */
      dirtyDelta: KeyMapDirtyDelta;
      message: string;
    }
  | { ok: false; error: string };

function entryFromKey(entry: KeyMapDef["entries"][number]): string {
  return (fromPartsEff(entry)[0] ?? entry.from).trim();
}

/** Dirty delta for Confirm: preserve attrs; freeze baselines for concurrency. */
export function dirtyDeltaFromFrozenRemap(
  map: KeyMapDef,
  changes: FrozenRemapPreview["changes"],
  nextMap: KeyMapDef,
): KeyMapDirtyDelta {
  const editable = map.editable_columns ?? [];
  const prevByFrom = new Map(
    map.entries.map((e) => [entryFromKey(e), e] as const),
  );
  const nextByFrom = new Map(
    nextMap.entries.map((e) => [entryFromKey(e), e] as const),
  );
  const upserts: KeyMapDef["entries"] = [];
  const baselines: KeyMapDirtyBaseline[] = [];
  for (const c of changes) {
    const from = c.from.trim();
    const next = nextByFrom.get(from);
    const prev = prevByFrom.get(from);
    if (next) {
      upserts.push({ ...next });
    } else {
      upserts.push({
        from,
        to: c.to,
        attrs: prev?.attrs ? { ...prev.attrs } : {},
      });
    }
    if (prev) {
      const attrs: Record<string, string | null> = {};
      for (const col of editable) {
        attrs[col] = prev.attrs?.[col] ?? null;
      }
      for (const [k, v] of Object.entries(prev.attrs ?? {})) {
        attrs[k] = v;
      }
      baselines.push({
        fromParts: fromPartsEff(prev),
        existed: true,
        to: prev.to,
        attrs,
      });
    } else {
      baselines.push({
        fromParts: [from],
        existed: false,
        to: "",
        attrs: {},
      });
    }
  }
  return { upserts, deletedFroms: [], baselines };
}

/** Merge Confirm delta into an open editor delta without dropping unrelated drafts. */
export function mergeRemapDirtyIntoTab(
  existing: KeyMapDirtyDelta | null | undefined,
  remap: KeyMapDirtyDelta,
): KeyMapDirtyDelta {
  if (!existing || !dirtyDeltaHasLocalChanges(existing)) {
    return remap;
  }
  const remapFroms = new Set(
    remap.upserts.map((u) => entryFromKey(u)),
  );
  const upserts = [
    ...existing.upserts.filter((u) => !remapFroms.has(entryFromKey(u))),
    ...remap.upserts,
  ];
  const baselines = [
    ...(existing.baselines ?? []).filter(
      (b) => !remapFroms.has((b.fromParts[0] ?? "").trim()),
    ),
    ...(remap.baselines ?? []),
  ];
  return {
    upserts,
    deletedFroms: existing.deletedFroms,
    deletedFromParts: existing.deletedFromParts,
    baselines,
  };
}

function dirtyDeltaHasLocalChanges(delta: KeyMapDirtyDelta): boolean {
  return (
    delta.upserts.length > 0 ||
    delta.deletedFroms.length > 0 ||
    (delta.deletedFromParts?.length ?? 0) > 0
  );
}

/**
 * Build the next map revision for Confirm.
 * Caller MUST apply via upsertKeyMapIntoProject (+ source Save with dirtyDelta) —
 * never patch `key_maps` alone (Apply snapshots / WH would stay stale).
 */
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
    const dirtyDelta = dirtyDeltaFromFrozenRemap(map!, frozen.changes, nextMap);
    return {
      ok: true,
      nextMap,
      dirtyDelta,
      message: `Check remap confirmed · ${frozen.changes.length} link(s) via KeyMap`,
    };
  } catch (reason) {
    return { ok: false, error: String(reason) };
  }
}

/**
 * Compare aggregate cells by stable group id (row\\0column\\0signal).
 * Only call for complete (non-top-N) runs — missing keys are treated as real zeros.
 */
export function summarizeCellDeltas(
  prevCells: Array<{
    row: string;
    column: string;
    signal: string;
    positions: number;
  }>,
  nextCells: Array<{
    row: string;
    column: string;
    signal: string;
    positions: number;
  }>,
  focusGroupKey?: string,
): string | null {
  const keyOf = (c: {
    row: string;
    column: string;
    signal: string;
  }) => `${c.row}\0${c.column}\0${c.signal}`;
  const prev = new Map(prevCells.map((c) => [keyOf(c), c.positions]));
  const next = new Map(nextCells.map((c) => [keyOf(c), c.positions]));
  // Intersection-only: do not invent 0 for a group absent from one side.
  const keys = [...prev.keys()].filter((k) => next.has(k));
  const changes: Array<{ key: string; from: number; to: number; d: number }> =
    [];
  for (const k of keys) {
    const a = prev.get(k)!;
    const b = next.get(k)!;
    if (a === b) continue;
    changes.push({ key: k, from: a, to: b, d: b - a });
  }
  if (!changes.length) return null;
  changes.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  const label = (k: string) => {
    const [row, col, signal] = k.split("\0");
    return `${row}→${col} (${signal})`;
  };
  if (focusGroupKey) {
    const hit = changes.find((c) => label(c.key).startsWith(focusGroupKey));
    if (hit) {
      return `${label(hit.key)} ${hit.from} → ${hit.to}`;
    }
  }
  const top = changes.slice(0, 3).map((c) => {
    const sign = c.d > 0 ? "+" : "";
    return `${label(c.key)} ${c.from}→${c.to} (${sign}${c.d})`;
  });
  const more = changes.length > 3 ? ` (+${changes.length - 3} groups)` : "";
  return `groups ${top.join("; ")}${more}`;
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
