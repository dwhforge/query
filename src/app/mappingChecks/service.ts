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
  normalizeAttrsProjection,
  upsertAllowDecision,
  type FrozenRemapPreview,
  type MappingCheck,
} from "../../lib/mappingCheck";
import {
  findApplyKeyMapIdForJoin,
  fromColumnsEff,
  fromPartsEff,
  outputColumnsEff,
  outputValuesEff,
  primaryTo,
} from "../../lib/keyMap";
import type { KeyMapDirtyBaseline, KeyMapDirtyDelta } from "../../lib/bridge";
import {
  QUALITY_SAMPLE_COLUMN,
  type QualityCell,
} from "../../lib/mappingQuality";
import type { KeyMapDef, Project, QueryDef, Workspace } from "../../types/pipeline";
import { targetKey } from "../../types/pipeline";
import type { CheckRun, MappingCheckProjection } from "../../types/mappingCheck";
import { keyMapBindingFingerprint, upsertKeyMapIntoProject } from "../keyMap";

export function resolveActiveMappingCheck(
  checks: MappingCheck[] | undefined,
): MappingCheck | null {
  const list = checks ?? [];
  // Prefer the latest user check so Create/Change after a Help lab still lands
  // on the project KeyMap overview (ADR-0035). Lab only when it is the sole check.
  const user = [...list]
    .reverse()
    .find((c) => c.id !== "check_lab_quality");
  if (user) return user;
  return list.find((c) => c.id === "check_lab_quality") ?? null;
}

export type NewCheckInput = {
  checks: MappingCheck[];
  keyMaps: KeyMapDef[];
  queries: QueryDef[];
  /** Required: map the check measures — not “first in list”. */
  mapId: string;
  /** Required: Join-host query that ApplyKeyMap-wires this map. */
  hostQueryId: string;
  /**
   * Required when the host has more than one Join wired to this map.
   * Ambiguous hostQueryId alone is refused.
   */
  joinStepIndex?: number;
  /** Prefer arrays (ADR-0035); singular fields soft-fill from first element. */
  leftAttrs?: string[];
  rightAttrs?: string[];
  sampleColumns?: string[];
  leftAttr?: string;
  rightAttr?: string;
  sampleColumn?: string;
};

export type InferredCheckAttrs = {
  leftAttrs: string[];
  rightAttrs: string[];
  sampleColumns: string[];
  /** low when we could only suggest ON×ON or missing name-like right. */
  confidence: "high" | "low";
  reason: string;
  /** True when both axes fell back to Join ON keys (tautology risk). */
  onOnFallback: boolean;
};

const NAME_LIKE =
  /(^|_)(name|label|title|company|product|desc|description)(_|$)|name$|label$|title$/i;
const BARE_KEY = /^(id|key|code|sku|uuid|pk|nr|no)$/i;

function foldCol(s: string): string {
  return s.trim().toLowerCase();
}

function pickNameLike(
  columns: string[],
  avoid: Set<string>,
): string | undefined {
  const scored = columns
    .filter((c) => c.trim() && !avoid.has(foldCol(c)))
    .map((c) => {
      const f = foldCol(c);
      let score = 0;
      if (NAME_LIKE.test(f)) score += 3;
      if (BARE_KEY.test(f)) score -= 2;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.localeCompare(b.c));
  return scored[0]?.c;
}

function pickFirstNonOn(
  columns: string[],
  avoid: Set<string>,
): string | undefined {
  return columns.find((c) => c.trim() && !avoid.has(foldCol(c)) && !BARE_KEY.test(foldCol(c)))
    ?? columns.find((c) => c.trim() && !avoid.has(foldCol(c)));
}

/**
 * Suggest overview axes from Join + KeyMap + side schemas (ADR-0035).
 * Composite From/ON → full left tuple (date included). Never prefer bare ON×ON.
 */
export function inferCheckAttrsFromJoin(args: {
  map: KeyMapDef;
  leftOn: string[];
  rightOn: string[];
  leftColumns: string[];
  rightColumns: string[];
}): InferredCheckAttrs {
  const leftOnSet = new Set(args.leftOn.map(foldCol));
  const rightOnSet = new Set(args.rightOn.map(foldCol));
  const fromCols = fromColumnsEff(args.map);

  const resolveOnLeft = (cols: string[]): string[] =>
    cols
      .map((c) => {
        const hit = args.leftColumns.find((x) => foldCol(x) === foldCol(c));
        return hit ?? "";
      })
      .filter(Boolean);

  const composite =
    fromCols.length > 1 || args.leftOn.length > 1 || args.rightOn.length > 1;

  let leftAttrs: string[];
  if (composite) {
    const fromOnLeft = resolveOnLeft(fromCols.length > 1 ? fromCols : args.leftOn);
    leftAttrs =
      fromOnLeft.length > 0
        ? fromOnLeft
        : resolveOnLeft(args.leftOn).length
          ? resolveOnLeft(args.leftOn)
          : args.leftOn.filter(Boolean);
  } else {
    const suggested =
      pickNameLike(args.leftColumns, leftOnSet) ??
      pickFirstNonOn(args.leftColumns, leftOnSet);
    leftAttrs = suggested
      ? [suggested]
      : args.leftOn[0]
        ? [args.leftOn[0]]
        : args.leftColumns[0]
          ? [args.leftColumns[0]]
          : ["key"];
  }

  const rightSuggested =
    pickNameLike(args.rightColumns, rightOnSet) ??
    pickFirstNonOn(args.rightColumns, rightOnSet);
  let rightAttrs: string[];
  let onOnFallback = false;
  if (rightSuggested) {
    rightAttrs = [rightSuggested];
  } else if (args.rightOn[0] && foldCol(args.rightOn[0]) !== foldCol(leftAttrs[0] ?? "")) {
    rightAttrs = [args.rightOn[0]];
    onOnFallback = leftAttrs.every((c) => leftOnSet.has(foldCol(c)));
  } else if (args.rightColumns[0]) {
    rightAttrs = [args.rightColumns[0]];
  } else {
    rightAttrs = args.rightOn[0] ? [args.rightOn[0]] : ["id"];
    onOnFallback = true;
  }

  // Guard: if left is pure ON and right is pure ON → flag low confidence.
  if (
    leftAttrs.every((c) => leftOnSet.has(foldCol(c))) &&
    rightAttrs.every((c) => rightOnSet.has(foldCol(c)))
  ) {
    onOnFallback = true;
  }

  const sampleColumns = leftAttrs.slice();
  const confidence: "high" | "low" = onOnFallback ? "low" : "high";
  const reason = onOnFallback
    ? "Could not find a non-key label on the right — review before confirming (ON×ON is a tautology)."
    : composite
      ? `Row axis = Join/From tuple (${leftAttrs.join(" · ")}); columns = ${rightAttrs.join(" · ")}.`
      : `Suggested ${leftAttrs[0]} × ${rightAttrs[0]} from side schemas.`;

  return {
    leftAttrs,
    rightAttrs,
    sampleColumns,
    confidence,
    reason,
    onOnFallback,
  };
}

export type AttrsJoinBinding = {
  host: QueryDef;
  joinStepIndex: number;
  leftOn: string[];
  rightOn: string[];
  rightQueryId: string;
};

/** Resolve Join binding for an attrs MappingCheck (ADR-0035 overview / Inspect). */
export function resolveAttrsJoinBinding(
  queries: QueryDef[],
  check: MappingCheck,
): AttrsJoinBinding | null {
  if (check.projection.kind !== "attrs") return null;
  const hostId = check.projection.host_query_id;
  const hosts = findJoinHostsForMap(queries, check.map_id).filter(
    (h) => h.host.id === hostId,
  );
  if (!hosts.length) return null;
  const hit = hosts.length === 1 ? hosts[0]! : hosts[hosts.length - 1]!;
  const step = hit.host.steps[hit.joinStepIndex];
  if (!step || step.type !== "Join") return null;
  return {
    host: hit.host,
    joinStepIndex: hit.joinStepIndex,
    leftOn: hit.leftOn,
    rightOn: hit.rightOn,
    rightQueryId: targetKey(step.payload.right_query_id),
  };
}

export function updateMappingCheckProjection(
  checks: MappingCheck[],
  checkId: string,
  projection: MappingCheckProjection,
): { ok: true; mapping_checks: MappingCheck[]; note: string } | { ok: false; error: string } {
  const idx = checks.findIndex((c) => c.id === checkId);
  if (idx < 0) return { ok: false, error: `Check “${checkId}” not found.` };
  const normalized =
    projection.kind === "attrs" ? normalizeAttrsProjection(projection) : projection;
  const next = checks.map((c, i) =>
    i === idx
      ? {
          ...c,
          projection: normalized,
          group_attributes:
            normalized.kind === "attrs"
              ? [...normalized.left_attrs, ...normalized.right_attrs]
              : c.group_attributes,
        }
      : c,
  );
  const label =
    normalized.kind === "attrs"
      ? `${normalized.left_attrs.join(" · ")} × ${normalized.right_attrs.join(" · ")}`
      : "lab";
  return {
    ok: true,
    mapping_checks: next,
    note: `Updated check attributes · ${label}`,
  };
}

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
      error: `Mapping “${input.mapId}” not found — pick a map that exists in the project.`,
    };
  }
  const leftAttrs = (
    input.leftAttrs?.length
      ? input.leftAttrs
      : input.leftAttr
        ? [input.leftAttr]
        : []
  )
    .map((s) => s.trim())
    .filter(Boolean);
  const rightAttrs = (
    input.rightAttrs?.length
      ? input.rightAttrs
      : input.rightAttr
        ? [input.rightAttr]
        : []
  )
    .map((s) => s.trim())
    .filter(Boolean);
  if (!leftAttrs.length || !rightAttrs.length) {
    return {
      ok: false,
      error: "Choose left and right check attributes (side labels or From/ON tuple).",
    };
  }
  const hosts = findJoinHostsForMap(input.queries, map.id);
  const onHost = hosts.filter((h) => h.host.id === input.hostQueryId);
  if (!onHost.length) {
    return {
      ok: false,
      error: `Query “${input.hostQueryId}” has no Apply Mapping for map “${map.name}”. Pick a Join host that uses this map.`,
    };
  }
  let hostHit = onHost[0]!;
  if (input.joinStepIndex != null) {
    const exact = onHost.find((h) => h.joinStepIndex === input.joinStepIndex);
    if (!exact) {
      return {
        ok: false,
        error: `Join step ${input.joinStepIndex} on “${input.hostQueryId}” is not wired to map “${map.name}”.`,
      };
    }
    hostHit = exact;
  } else if (onHost.length > 1) {
    return {
      ok: false,
      error: `Query “${input.hostQueryId}” has ${onHost.length} Joins wired to “${map.name}” — pick joinStepIndex explicitly.`,
    };
  }
  const sampleColumns = (
    input.sampleColumns?.length
      ? input.sampleColumns
      : input.sampleColumn
        ? [input.sampleColumn]
        : leftAttrs
  )
    .map((s) => s.trim())
    .filter(Boolean);
  const projection = normalizeAttrsProjection({
    kind: "attrs",
    host_query_id: hostHit.host.id,
    left_attr: leftAttrs[0]!,
    right_attr: rightAttrs[0]!,
    sample_column: sampleColumns[0] ?? leftAttrs[0]!,
    left_attrs: leftAttrs,
    right_attrs: rightAttrs,
    sample_columns: sampleColumns.length ? sampleColumns : leftAttrs,
  });
  const check: MappingCheck = {
    id: newCheckId(input.checks.map((c) => c.id)),
    name: `Check · ${map.name}`,
    map_id: map.id,
    input_refs: [hostHit.host.id],
    group_attributes: [...leftAttrs, ...rightAttrs],
    cohort_predicate: "",
    projection,
    allow_decisions: [],
  };
  const axis =
    leftAttrs.length > 1 || rightAttrs.length > 1
      ? `${leftAttrs.join(" · ")} × ${rightAttrs.join(" · ")}`
      : `${leftAttrs[0]} ↔ ${rightAttrs[0]}`;
  return {
    ok: true,
    check,
    note: `Created ${check.name} · ${hostHit.host.name} · ${axis}`,
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
  // Full matrices only; skip when definition moved (group axes may not be comparable).
  const cellNote =
    prev &&
    !prev.cells_incomplete &&
    !run.cells_incomplete &&
    attr !== "definition_changed" &&
    attr !== "limited"
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
  const attrsProj =
    check.projection.kind === "attrs"
      ? normalizeAttrsProjection(check.projection)
      : null;
  const sampleColumn =
    attrsProj && attrsProj.kind === "attrs"
      ? attrsProj.sample_columns[0] || attrsProj.sample_column
      : QUALITY_SAMPLE_COLUMN;
  const orderedKeys = [...new Set(payload.samples)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24);
  const predicate =
    payload.kind === "target"
      ? cohortPredicateForTarget(payload.targetKey)
      : attrsProj && attrsProj.kind === "attrs"
        ? cohortPredicateFromAttrCells(
            attrsProj.left_attrs,
            attrsProj.right_attrs,
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
        expected_map_revision: keyMapRevision(map, project.workspace),
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

/** Intent for projectBag `confirm_remap` — reducer returns applied/stale once. */
export type ConfirmRemapApplyIntent = {
  opId: string;
  nextMap: KeyMapDef;
  dirtyDelta: KeyMapDirtyDelta;
  message: string;
  projectIdAtStart: string;
  bindingAtStart: string;
  expectedMapRevision: string;
};

export type ConfirmRemapApplyResult =
  | {
      status: "applied";
      opId: string;
      mapId: string;
      nextMap: KeyMapDef;
      dirtyDelta: KeyMapDirtyDelta;
      message: string;
    }
  | { status: "stale"; opId: string; reason: string };

/**
 * Pure: fold Confirm nextMap into project only when identity still matches.
 * UI must react to `result`, not to a mutable flag outside the reducer.
 */
export function applyConfirmRemapOntoProject(
  project: Project,
  intent: ConfirmRemapApplyIntent,
): { project: Project; result: ConfirmRemapApplyResult } {
  if (project.id !== intent.projectIdAtStart) {
    return {
      project,
      result: {
        status: "stale",
        opId: intent.opId,
        reason:
          "Project changed before Confirm could apply — refresh and retry.",
      },
    };
  }
  const live = (project.workspace.key_maps ?? []).find(
    (m) => m.id === intent.nextMap.id,
  );
  if (!live) {
    return {
      project,
      result: {
        status: "stale",
        opId: intent.opId,
        reason: "Mapping missing before Confirm could apply — refresh and retry.",
      },
    };
  }
  if (keyMapBindingFingerprint(live) !== intent.bindingAtStart) {
    return {
      project,
      result: {
        status: "stale",
        opId: intent.opId,
        reason:
          "Mapping binding changed before Confirm could apply — refresh and retry.",
      },
    };
  }
  if (keyMapRevision(live, project.workspace) !== intent.expectedMapRevision) {
    return {
      project,
      result: {
        status: "stale",
        opId: intent.opId,
        reason:
          "Mapping changed before Confirm could apply — refresh the remap preview.",
      },
    };
  }
  return {
    project: upsertKeyMapIntoProject(project, intent.nextMap),
    result: {
      status: "applied",
      opId: intent.opId,
      mapId: intent.nextMap.id,
      nextMap: intent.nextMap,
      dirtyDelta: intent.dirtyDelta,
      message: intent.message,
    },
  };
}

function entryFromKey(entry: KeyMapDef["entries"][number]): string {
  return (fromPartsEff(entry)[0] ?? entry.from).trim();
}

/**
 * Dirty delta for Confirm: preserve attrs; freeze baselines for concurrency.
 *
 * `priorEntries` is the authoritative pre-image for baselines:
 * - seed/ref: typically `map.entries`
 * - source: warehouse rows for the remapped From keys (never infer absence
 *   from empty metadata-only `map.entries`)
 */
export function dirtyDeltaFromFrozenRemap(
  map: KeyMapDef,
  changes: FrozenRemapPreview["changes"],
  nextMap: KeyMapDef,
  priorEntries?: KeyMapDef["entries"],
): KeyMapDirtyDelta {
  const isSource = map.storage?.kind === "source";
  if (isSource && priorEntries === undefined) {
    throw new Error(
      "Source Mapping Confirm requires warehouse baselines for the remapped From keys.",
    );
  }
  const editable = map.editable_columns ?? [];
  const baselineRows = priorEntries ?? map.entries;
  const prevByFrom = new Map(
    baselineRows.map((e) => [entryFromKey(e), e] as const),
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
    const attrsFromPrior = prev?.attrs ? { ...prev.attrs } : {};
    if (next) {
      const nextAttrs =
        next.attrs && Object.keys(next.attrs).length > 0
          ? { ...next.attrs }
          : attrsFromPrior;
      upserts.push({ ...next, attrs: nextAttrs });
    } else {
      upserts.push({
        from,
        to: c.to,
        output_values: [c.to],
        attrs: attrsFromPrior,
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
        to: primaryTo(prev),
        outputs: Object.fromEntries(
          outputColumnsEff(map).map((c, i) => [c, outputValuesEff(prev)[i] ?? ""]),
        ),
        attrs,
      });
    } else {
      // Absence only after a real prior read (source) or seed entries scan.
      baselines.push({
        fromParts: [from],
        existed: false,
        to: "",
        outputs: Object.fromEntries(outputColumnsEff(map).map((c) => [c, ""])),
        attrs: {},
      });
    }
  }
  return { upserts, deletedFroms: [], baselines };
}

function dirtyDeltaHasLocalChanges(delta: KeyMapDirtyDelta): boolean {
  return (
    delta.upserts.length > 0 ||
    delta.deletedFroms.length > 0 ||
    (delta.deletedFromParts?.length ?? 0) > 0
  );
}

/** Stable identity of a frozen remap preview (for post-await stale checks). */
export function frozenRemapFingerprint(frozen: FrozenRemapPreview): string {
  return JSON.stringify({
    check_id: frozen.check_id,
    map_id: frozen.map_id,
    expected_map_revision: frozen.expected_map_revision,
    expected_input_revisions: frozen.expected_input_revisions,
    changes: frozen.changes,
  });
}

/**
 * After async warehouse reads, refuse Confirm if the live UI context moved.
 * Returns an error message, or null when still valid.
 */
export function confirmContextStillValid(args: {
  frozenAtStart: FrozenRemapPreview;
  liveFrozen: FrozenRemapPreview | null;
  projectIdAtStart: string;
  liveProjectId: string;
  bindingAtStart: string;
  liveMap: KeyMapDef | undefined;
  bindingOf: (map: KeyMapDef) => string;
  /** Needed for query-backed map revisions (ADR-0036). */
  workspace?: Workspace;
}): string | null {
  if (args.liveProjectId !== args.projectIdAtStart) {
    return "Project changed while reading baselines — Confirm cancelled.";
  }
  if (!args.liveFrozen) {
    return "Remap preview was cleared — Confirm cancelled.";
  }
  if (
    frozenRemapFingerprint(args.liveFrozen) !==
    frozenRemapFingerprint(args.frozenAtStart)
  ) {
    return "Remap preview changed while reading baselines — Confirm cancelled.";
  }
  if (!args.liveMap) {
    return "Mapping missing after baseline read — Confirm cancelled.";
  }
  if (args.bindingOf(args.liveMap) !== args.bindingAtStart) {
    return "Mapping binding changed while reading baselines — Confirm cancelled.";
  }
  if (
    keyMapRevision(args.liveMap, args.workspace) !==
    args.frozenAtStart.expected_map_revision
  ) {
    return "Mapping changed while reading baselines — refresh the remap preview.";
  }
  return null;
}

/**
 * Confirm applies only frozen changes — refuse when the open editor has
 * unrelated unsaved drafts (do not silently merge / publish them).
 */
export function unrelatedDraftBlocksConfirm(args: {
  frozenFroms: string[];
  dirtyDelta?: KeyMapDirtyDelta | null;
  localDraft?: boolean;
}): string | null {
  const frozen = new Set(args.frozenFroms.map((f) => f.trim()).filter(Boolean));
  const delta = args.dirtyDelta;
  if (delta && dirtyDeltaHasLocalChanges(delta)) {
    const draftFroms = new Set<string>();
    for (const u of delta.upserts) {
      draftFroms.add(entryFromKey(u));
    }
    for (const f of delta.deletedFroms) {
      draftFroms.add(f.trim());
    }
    for (const parts of delta.deletedFromParts ?? []) {
      draftFroms.add((parts[0] ?? "").trim());
    }
    for (const f of draftFroms) {
      if (!f) continue;
      if (!frozen.has(f)) {
        return `Mapping has unsaved edits outside the check preview (e.g. “${f}”). Save or discard them before Confirm.`;
      }
    }
  } else if (args.localDraft) {
    // Seed/ref draft without a dirty wire — cannot prove it is only frozen Froms.
    return "Save or discard Mapping editor drafts before confirming check remap.";
  }
  return null;
}

/**
 * Build the next map revision for Confirm.
 * Caller MUST apply via upsertKeyMapIntoProject (+ source Save with dirtyDelta) —
 * never patch `key_maps` alone (Apply snapshots / WH would stay stale).
 *
 * Confirm is literal: only frozen changes. Unrelated editor drafts → refuse.
 * Source maps require `priorEntries` from a warehouse read of affected From keys.
 */
export function confirmFrozenCheckRemap(args: {
  frozen: FrozenRemapPreview;
  workspace: Workspace;
  checks: MappingCheck[];
  /** Warehouse (or seed) pre-image rows for remapped From keys. */
  priorEntries?: KeyMapDef["entries"];
  /** Open tab dirty — must not contain From keys outside the freeze. */
  openTabDirty?: KeyMapDirtyDelta | null;
  openTabLocalDraft?: boolean;
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
    const blocked = unrelatedDraftBlocksConfirm({
      frozenFroms: frozen.changes.map((c) => c.from),
      dirtyDelta: args.openTabDirty,
      localDraft: args.openTabLocalDraft,
    });
    if (blocked) {
      return { ok: false, error: blocked };
    }
    const isSource = map!.storage?.kind === "source";
    const priorEntries = isSource
      ? args.priorEntries
      : (args.priorEntries ?? map!.entries);
    if (isSource && priorEntries === undefined) {
      return {
        ok: false,
        error:
          "Source Mapping Confirm needs warehouse baselines for remapped keys — refresh and retry.",
      };
    }
    const nextMap = applyFrozenRemapToMap(
      map!,
      frozen,
      workspace,
      check,
      priorEntries,
    );
    const dirtyDelta = dirtyDeltaFromFrozenRemap(
      map!,
      frozen.changes,
      nextMap,
      priorEntries,
    );
    return {
      ok: true,
      nextMap,
      dirtyDelta,
      message: `Check remap confirmed · ${frozen.changes.length} link(s) via Mapping`,
    };
  } catch (reason) {
    return { ok: false, error: String(reason) };
  }
}

/**
 * Compare aggregate cells by stable group id (row\\0column\\0signal).
 * Call only for complete, definition-compatible runs — missing keys are real zeros.
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
  // Full matrices: absence ≡ 0 (appear / disappear are real Δ).
  const keys = new Set([...prev.keys(), ...next.keys()]);
  const changes: Array<{ key: string; from: number; to: number; d: number }> =
    [];
  for (const k of keys) {
    const a = prev.get(k) ?? 0;
    const b = next.get(k) ?? 0;
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
