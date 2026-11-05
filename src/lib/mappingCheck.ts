/**
 * MappingCheck / CheckRun helpers (ADR-0027).
 * KeyMap remains the only link SoT — checks never invent a second map store.
 */
import type {
  CheckAggregateCell,
  CheckComparability,
  CheckDeltaAttribution,
  CheckInputRevision,
  CheckRun,
  FrozenRemapPreview,
  MappingCheck,
  MappingCheckProjection,
} from "../types/mappingCheck";
import type {
  JoinType,
  KeyMapDef,
  QueryDef,
  Workspace,
} from "../types/pipeline";
import { targetKey } from "../types/pipeline";
import {
  QUALITY_INSPECTION,
  QUALITY_JOIN,
  QUALITY_MAP,
  QUALITY_SAMPLE_COLUMN,
  isMappingQualityLab,
  parseQualitySummaryDetailed,
  type QualityCell,
} from "./mappingQuality";
import type { PreviewResult } from "../types/pipeline";
import { fromColumnsEff, fromPartsEff } from "./keyMap";

export type {
  CheckAggregateCell,
  CheckComparability,
  CheckDeltaAttribution,
  CheckInputRevision,
  CheckRun,
  FrozenRemapPreview,
  MappingAllowDecision,
  MappingCheck,
  MappingCheckProjection,
} from "../types/mappingCheck";

export function newCheckId(existing: string[]): string {
  const base = "check_mapping";
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function newCheckRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Semantic map fingerprint — links, attrs, SCD bounds, schema, storage (ADR-0027/0028). */
export function keyMapRevision(map: KeyMapDef | undefined | null): string {
  if (!map) return "missing_map";
  const rows = [...map.entries]
    .map((e) => {
      const from = (e.from_parts?.length ? e.from_parts.join("\0") : e.from).trim();
      const attrs = Object.entries(e.attrs ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      return `${from}\t${e.to.trim()}\t${attrs}`;
    })
    .sort();
  const schema = JSON.stringify({
    from_columns: fromColumnsEff(map),
    to_column: map.to_column ?? "to",
    editable_columns: map.editable_columns ?? [],
    time_mode: map.time_mode ?? "none",
    valid_from_column: map.valid_from_column ?? null,
    valid_to_column: map.valid_to_column ?? null,
    storage: map.storage ?? { kind: "seed" },
  });
  return `map:${map.id}:n=${rows.length}:h=${fnv1a(rows.join("\n") + "|" + schema)}`;
}

export function checkDefinitionRevision(check: MappingCheck): string {
  const payload = JSON.stringify({
    map_id: check.map_id,
    input_refs: check.input_refs,
    group_attributes: check.group_attributes,
    projection: check.projection,
    cohort_predicate: check.cohort_predicate,
  });
  return `def:${fnv1a(payload)}`;
}

/**
 * Honest input versioning (ADR-0027).
 * Path-only file loads and live Postgres cannot prove content identity → limited.
 * Known upstream revisions are folded into the digest (not only null-checked).
 */
export function inputRevisionForQuery(
  workspace: Workspace,
  queryId: string,
  seen = new Set<string>(),
): CheckInputRevision {
  if (seen.has(queryId)) {
    return { ref_id: queryId, revision: `cycle:${queryId}` };
  }
  seen.add(queryId);
  const q = workspace.queries.find((x) => x.id === queryId);
  if (!q) {
    return {
      ref_id: queryId,
      revision: null,
      unknown_reason: "query missing",
    };
  }
  const depRevs: string[] = [];
  const noteLimited = (reason: string): CheckInputRevision => ({
    ref_id: queryId,
    revision: null,
    unknown_reason: reason,
  });

  const takeDep = (dep: CheckInputRevision): CheckInputRevision | null => {
    if (dep.revision == null) {
      return noteLimited(
        dep.unknown_reason ??
          `dependency ${dep.ref_id} has no reliable version`,
      );
    }
    depRevs.push(`${dep.ref_id}=${dep.revision}`);
    return null;
  };

  for (const step of q.steps) {
    if (step.type === "LoadCsv" || step.type === "LoadParquet") {
      return noteLimited(
        `${step.type} content version not tracked (path-only)`,
      );
    }
    if (step.type === "LoadPostgres") {
      return noteLimited("postgres relation version not tracked");
    }
    if (step.type === "LoadDuckdb") {
      return noteLimited("duckdb file content version not tracked");
    }
    if (step.type === "FromQuery") {
      const fail = takeDep(
        inputRevisionForQuery(
          workspace,
          String(step.payload.query_id),
          seen,
        ),
      );
      if (fail) return fail;
    }
    if (step.type === "Join") {
      const fail = takeDep(
        inputRevisionForQuery(
          workspace,
          String(step.payload.right_query_id),
          seen,
        ),
      );
      if (fail) return fail;
    }
    if (step.type === "Append") {
      for (const oid of step.payload.other_query_ids ?? []) {
        const fail = takeDep(
          inputRevisionForQuery(workspace, String(oid), seen),
        );
        if (fail) return fail;
      }
    }
    if (step.type === "SqlModel") {
      const sql = step.payload.raw_sql ?? "";
      const placeholders = [
        ...sql.matchAll(/\{\{\s*query:([a-zA-Z0-9_]+)\s*\}\}/g),
      ].map((m) => m[1]!);
      // Unresolved / non-query placeholders → limited rather than silent miss.
      if (/\{\{/.test(sql) && placeholders.length === 0) {
        return noteLimited(
          "SqlModel has placeholders that are not {{query:id}}",
        );
      }
      for (const pid of placeholders) {
        const fail = takeDep(inputRevisionForQuery(workspace, pid, seen));
        if (fail) return fail;
      }
    }
  }
  depRevs.sort();
  return {
    ref_id: queryId,
    revision: `steps:${fnv1a(JSON.stringify(q.steps))}|deps:${fnv1a(depRevs.join("|"))}`,
  };
}

export function collectInputRevisions(
  workspace: Workspace,
  check: MappingCheck,
): CheckInputRevision[] {
  return check.input_refs.map((id) => inputRevisionForQuery(workspace, id));
}

export function runComparability(
  inputRevisions: CheckInputRevision[],
): CheckComparability {
  const unknown = inputRevisions.find((r) => r.revision == null);
  if (unknown) {
    return {
      kind: "limited",
      reason:
        unknown.unknown_reason ??
        `input ${unknown.ref_id} has no reliable version`,
    };
  }
  return { kind: "full" };
}

export function attributeDelta(
  prev: CheckRun,
  next: CheckRun,
): CheckDeltaAttribution {
  if (
    prev.comparability.kind === "limited" ||
    next.comparability.kind === "limited"
  ) {
    return "limited";
  }
  if (prev.check_definition_revision !== next.check_definition_revision) {
    return "definition_changed";
  }
  const mapChanged = prev.map_revision !== next.map_revision;
  const inputsChanged =
    JSON.stringify(prev.input_revisions) !==
    JSON.stringify(next.input_revisions);
  if (mapChanged && inputsChanged) return "both_changed";
  if (mapChanged) return "mapping_changed";
  if (inputsChanged) return "inputs_changed";
  return "unchanged";
}

export function deltaLabel(a: CheckDeltaAttribution): string {
  switch (a) {
    case "mapping_changed":
      return "Mapping changed";
    case "inputs_changed":
      return "Inputs changed";
    case "both_changed":
      return "Mapping and inputs changed";
    case "definition_changed":
      return "Check definition changed";
    case "unchanged":
      return "No map/input/definition revision change";
    case "limited":
      return "Limited comparability";
  }
}

export function assertRemapConfirmable(
  freeze: FrozenRemapPreview,
  map: KeyMapDef | undefined,
  workspace?: Workspace,
  check?: MappingCheck,
): void {
  if (!map || map.id !== freeze.map_id) {
    throw new Error("KeyMap missing or mismatched — refresh the remap preview.");
  }
  const current = keyMapRevision(map);
  if (current !== freeze.expected_map_revision) {
    throw new Error(
      "KeyMap changed since preview — run a new preview before confirming.",
    );
  }
  if (workspace && check && freeze.expected_input_revisions?.length) {
    const now = collectInputRevisions(workspace, check);
    const hadKnown = freeze.expected_input_revisions.some((r) => r.revision != null);
    // When versions were known at preview, refuse if they moved. Path-only/unknown
    // inputs stay mapping-gated only (comparability already limited on CheckRun).
    if (
      hadKnown &&
      JSON.stringify(now) !== JSON.stringify(freeze.expected_input_revisions)
    ) {
      throw new Error(
        "Inputs changed since preview — run a new preview before confirming.",
      );
    }
  }
  if (!freeze.changes.length) {
    throw new Error("No From→To changes in the frozen preview.");
  }
}

/** v1 batch remap: static arity-1 only (ADR-0027 review — refuse composite/SCD). */
export function applyFrozenRemapToMap(
  map: KeyMapDef,
  freeze: FrozenRemapPreview,
  workspace?: Workspace,
  check?: MappingCheck,
  /**
   * Rows known before Confirm (seed: map.entries; source: warehouse read).
   * Source maps must not invent rows from empty workspace.entries.
   */
  priorEntries?: KeyMapDef["entries"],
): KeyMapDef {
  assertRemapConfirmable(freeze, map, workspace, check);
  const arity = fromColumnsEff(map).length;
  if (arity > 1 || map.time_mode === "range_scd") {
    throw new Error(
      "Frozen batch remap v1 supports only static arity-1 maps (not composite / range SCD).",
    );
  }
  const isSource = map.storage?.kind === "source";
  if (isSource && priorEntries === undefined) {
    throw new Error(
      "Source KeyMap Confirm requires warehouse baselines for the remapped From keys.",
    );
  }
  const base = isSource ? priorEntries! : map.entries;
  const byFrom = new Map(freeze.changes.map((c) => [c.from.trim(), c.to]));
  const entries = base.map((e) => {
    const fromKey = fromPartsEff(e)[0]?.trim() || e.from.trim();
    const hit = byFrom.get(fromKey);
    if (hit == null) return e;
    byFrom.delete(fromKey);
    return { ...e, to: hit };
  });
  for (const [from, to] of byFrom) {
    entries.push({ from, to, attrs: {} });
  }
  return { ...map, entries };
}

export function upsertAllowDecision(
  check: MappingCheck,
  groupKey: string,
  explanation: string,
): MappingCheck {
  const trimmed = explanation.trim();
  if (!trimmed) {
    throw new Error("Allow-difference requires an explanation.");
  }
  const rest = check.allow_decisions.filter((d) => d.group_key !== groupKey);
  return {
    ...check,
    allow_decisions: [
      ...rest,
      {
        id: `allow_${fnv1a(groupKey + trimmed).toString(16)}`,
        group_key: groupKey,
        explanation: trimmed,
        created_at: new Date().toISOString(),
      },
    ],
  };
}

export function labMappingCheck(): MappingCheck {
  return {
    id: "check_lab_quality",
    name: "Lab · commercial → catalog structure",
    map_id: QUALITY_MAP,
    input_refs: ["quality_commercial", "quality_catalog", QUALITY_JOIN],
    group_attributes: [
      "source_family",
      "target_family",
      "source_grade",
      "target_grade",
    ],
    cohort_predicate: "",
    projection: { kind: "lab_v1" },
    allow_decisions: [],
  };
}

export function ensureLabCheck(checks: MappingCheck[]): MappingCheck[] {
  if (checks.some((c) => c.id === "check_lab_quality")) return checks;
  return [...checks, labMappingCheck()];
}

export function buildCheckRun(args: {
  check: MappingCheck;
  workspace: Workspace;
  map: KeyMapDef | undefined;
  cells: CheckAggregateCell[];
  totalPositions: number;
  cellsIncomplete?: boolean;
  groupCount?: number;
  coveredPositions?: number;
  unmappedPositions?: number;
}): CheckRun {
  const input_revisions = collectInputRevisions(args.workspace, args.check);
  let comparability = runComparability(input_revisions);
  const cellsIncomplete = Boolean(args.cellsIncomplete);
  if (cellsIncomplete && comparability.kind === "full") {
    comparability = {
      kind: "limited",
      reason: `overview cells are top-${args.cells.length} of ${args.groupCount ?? "?"} groups — not a full matrix`,
    };
  }
  return {
    id: newCheckRunId(),
    check_id: args.check.id,
    ran_at: new Date().toISOString(),
    map_revision: keyMapRevision(args.map),
    input_revisions,
    check_definition_revision: checkDefinitionRevision(args.check),
    total_positions: args.totalPositions,
    cells: args.cells,
    comparability,
    cells_incomplete: cellsIncomplete,
    group_count: args.groupCount,
    covered_positions: args.coveredPositions,
    unmapped_positions: args.unmappedPositions,
  };
}

export function cellsFromQualitySummary(
  result: PreviewResult,
): { cells: CheckAggregateCell[]; total: number; incomplete: boolean } {
  const detailed = parseQualitySummaryDetailed(result);
  const cells: CheckAggregateCell[] = detailed.cells.map((c) => ({
    row: c.sourceFamily,
    column: c.targetFamily,
    signal: c.signal,
    positions: c.positions,
    revenue: c.revenue,
    samples: c.samples,
  }));
  return {
    cells,
    total: detailed.totalPositions,
    incomplete: detailed.incomplete,
  };
}

/**
 * Cohort predicate for selected matrix cells (group dimensions), not sample IN-list.
 * Samples remain illustration / Lens focus only (ADR-0027).
 */
export function cohortPredicateFromCells(cells: QualityCell[]): string {
  if (!cells.length) throw new Error("No cells for cohort predicate.");
  const parts = cells.map((c) => {
    const target =
      c.targetFamily === "Unmapped" || c.targetFamily === "—"
        ? `"target_family" IS NULL`
        : eqSql("target_family", c.targetFamily);
    const gradeTarget =
      c.targetGrade === "—" || c.targetGrade === "Unmapped"
        ? `("target_grade" IS NULL OR CAST("target_grade" AS VARCHAR) = '—')`
        : eqSql("target_grade", c.targetGrade);
    return `(${eqSql("source_family", c.sourceFamily)} AND ${target} AND ${eqSql("source_grade", c.sourceGrade)} AND ${gradeTarget} AND ${eqSql("decision_method", c.method)})`;
  });
  // Deduplicate identical cell predicates
  return [...new Set(parts)].join(" OR ");
}

/** Axis expression: one column or concat_ws tuple (matches attrs summary labels). */
export function attrsAxisExpr(columns: string[]): string {
  const cols = columns.filter(Boolean);
  if (!cols.length) throw new Error("attrs axis needs at least one column");
  if (cols.length === 1) {
    return `CAST(${quoteIdent(cols[0]!)} AS VARCHAR)`;
  }
  return `concat_ws(' | ', ${cols
    .map((c) => `CAST(${quoteIdent(c)} AS VARCHAR)`)
    .join(", ")})`;
}

/** Attrs-projection cohort: equality on left/right attr values of selected cells. */
export function cohortPredicateFromAttrCells(
  leftAttr: string | string[],
  rightAttr: string | string[],
  cells: QualityCell[],
): string {
  if (!cells.length) throw new Error("No cells for cohort predicate.");
  const leftCols = Array.isArray(leftAttr) ? leftAttr : [leftAttr];
  const rightCols = Array.isArray(rightAttr) ? rightAttr : [rightAttr];
  const leftExpr = attrsAxisExpr(leftCols);
  const rightExpr = attrsAxisExpr(rightCols);
  const rightNull = quoteIdent(rightCols[0]!);
  const parts = cells.map((c) => {
    const right =
      c.targetFamily === "Unmapped"
        ? `${rightNull} IS NULL`
        : `${rightExpr} = '${c.targetFamily.replace(/'/g, "''")}'`;
    return `(${leftExpr} = '${c.sourceFamily.replace(/'/g, "''")}' AND ${right})`;
  });
  return [...new Set(parts)].join(" OR ");
}

/** Concentration-lens target: cohort = rows converging on this canonical key. */
export function cohortPredicateForTarget(targetKey: string): string {
  const k = targetKey.trim();
  if (!k) throw new Error("Empty target key for cohort.");
  return eqSql("canonical_key", k);
}

/**
 * Illustrative sample keys only — never substitutes for the cohort predicate.
 * @deprecated Prefer cohortPredicateFromCells; kept for focus/lens helpers.
 */
export function cohortPredicateFromSamples(
  sampleColumn: string,
  keys: string[],
): string {
  const bounded = [...new Set(keys)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24);
  if (!bounded.length) throw new Error("No sample keys for illustration list.");
  const literals = bounded
    .map((key) => `'${key.replace(/'/g, "''")}'`)
    .join(", ");
  return `${quoteIdent(sampleColumn)} IN (${literals})`;
}

/**
 * Ephemeral Inspect: post-join cohort filter (ADR-0027).
 * Sample keys are not the cohort — they only order/focus Lens.
 */
/**
 * Join Lens context for an Inspect query. Lab wrappers are SqlModel-only —
 * Lens must target {@link QUALITY_JOIN}, not search for Join inside the wrapper.
 */
export function resolveInspectJoinLensTarget(
  workspace: Workspace,
  inspection: QueryDef,
): {
  hostQueryId: string;
  joinStepIndex: number;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
  joinType: JoinType;
} | null {
  const localIdx = inspection.steps.findIndex((s) => s.type === "Join");
  if (localIdx >= 0) {
    const step = inspection.steps[localIdx]!;
    if (step.type !== "Join" || step.payload.left_on.length === 0) return null;
    return {
      hostQueryId: inspection.id,
      joinStepIndex: localIdx,
      rightQueryId: targetKey(step.payload.right_query_id),
      leftOn: step.payload.left_on,
      rightOn: step.payload.right_on,
      joinType: step.payload.join_type,
    };
  }
  const lab = workspace.queries.find((q) => q.id === QUALITY_JOIN);
  if (!lab) return null;
  let joinStepIndex = -1;
  for (let i = lab.steps.length - 1; i >= 0; i--) {
    if (lab.steps[i]?.type === "Join") {
      joinStepIndex = i;
      break;
    }
  }
  const step = joinStepIndex >= 0 ? lab.steps[joinStepIndex] : null;
  if (!step || step.type !== "Join" || step.payload.left_on.length === 0) {
    return null;
  }
  return {
    hostQueryId: QUALITY_JOIN,
    joinStepIndex,
    rightQueryId: targetKey(step.payload.right_query_id),
    leftOn: step.payload.left_on,
    rightOn: step.payload.right_on,
    joinType: step.payload.join_type,
  };
}

export function cohortInspectionQuery(
  workspace: Workspace,
  check: MappingCheck,
): QueryDef {
  if (!check.cohort_predicate.trim()) {
    throw new Error("Select a matrix cell (cohort) before opening Join Lens.");
  }
  const attrsProj =
    check.projection.kind === "attrs"
      ? normalizeAttrsProjection(check.projection)
      : null;
  const sampleColumn =
    attrsProj && attrsProj.kind === "attrs"
      ? attrsProj.sample_columns[0] || attrsProj.sample_column
      : QUALITY_SAMPLE_COLUMN;
  const pred = check.cohort_predicate.trim();

  // Lab: wrap joined result so derived signal/attrs are filterable.
  if (check.projection.kind === "lab_v1" || isMappingQualityLab(workspace)) {
    if (!workspace.queries.some((q) => q.id === QUALITY_JOIN)) {
      throw new Error("Lab Join missing — reload the mapping quality demo.");
    }
    return {
      id: QUALITY_INSPECTION,
      name: "Check cohort · ephemeral",
      steps: [
        {
          type: "SqlModel",
          payload: {
            raw_sql: `
WITH observed AS (
  SELECT *,
    CASE WHEN target_family IS NULL THEN 'unmapped'
         WHEN source_family <> target_family THEN 'family_difference'
         WHEN source_grade <> target_grade THEN 'grade_difference'
         WHEN TRY_CAST(runner_up_gap AS DOUBLE) < 0.03 THEN 'close_alternative'
         WHEN decision_method = 'fuzzy' THEN 'similarity_only'
         ELSE 'aligned_attributes' END AS signal
  FROM {{query:${QUALITY_JOIN}}}
)
SELECT * FROM observed
WHERE ${pred}
ORDER BY ${quoteIdent(sampleColumn)}
`.trim(),
          },
        },
      ],
      execution: "local",
    };
  }

  const hostId =
    check.projection.kind === "attrs"
      ? check.projection.host_query_id
      : QUALITY_JOIN;
  const template = workspace.queries.find((q) => q.id === hostId);
  if (!template || template.steps[template.steps.length - 1]?.type !== "Join") {
    throw new Error("Check host query must end with a Join.");
  }
  // Keep host ApplyKeyMap entries as-is. Overview aggregates via {{query:host}}
  // with those rows; wiping them made Inspect a no-op remap (empty VALUES) so
  // cohort filters like item_code = 'WH-BEV-…' matched nothing.
  // Seed fills from workspace.key_maps when the step snapshot is already empty.
  const body = template.steps.map((step) => {
    if (step.type !== "ApplyKeyMap") return step;
    const existing = step.payload.entries ?? [];
    if (existing.length > 0) return step;
    const mapId =
      typeof step.payload.map_id === "string" ? step.payload.map_id : null;
    const map = mapId
      ? (workspace.key_maps ?? []).find((m) => m.id === mapId)
      : undefined;
    if (!map?.entries?.length) return step;
    return {
      ...step,
      payload: { ...step.payload, entries: map.entries },
    };
  });
  return {
    ...template,
    id: QUALITY_INSPECTION,
    name: "Check cohort · ephemeral",
    steps: [
      ...body,
      { type: "Filter", payload: { condition: pred } },
      {
        type: "SortBy",
        payload: { column: sampleColumn, descending: false },
      },
    ],
  };
}

/** Max aggregate groups returned for attrs overview (under preview LIMIT 50). */
export const CHECK_ATTRS_GROUP_BUDGET = 40;

/** Ephemeral left-side query id for Join-anchored attrs summary (ADR-0035). */
export const CHECK_LEFT_QUERY_ID = "__check_left__";
export const CHECK_SUMMARY_QUERY_ID = "__check_summary__";

/** Soft-migrate singular left_attr ↔ left_attrs[] (ADR-0035). */
export function normalizeAttrsProjection(
  projection: MappingCheckProjection,
): MappingCheckProjection {
  if (projection.kind !== "attrs") return projection;
  const left_attrs =
    projection.left_attrs?.length > 0
      ? projection.left_attrs
      : projection.left_attr
        ? [projection.left_attr]
        : [];
  const right_attrs =
    projection.right_attrs?.length > 0
      ? projection.right_attrs
      : projection.right_attr
        ? [projection.right_attr]
        : [];
  const sample_columns =
    projection.sample_columns?.length > 0
      ? projection.sample_columns
      : projection.sample_column
        ? [projection.sample_column]
        : [...left_attrs];
  return {
    kind: "attrs",
    host_query_id: projection.host_query_id,
    left_attr: left_attrs[0] ?? "",
    right_attr: right_attrs[0] ?? "",
    sample_column: sample_columns[0] ?? "",
    left_attrs,
    right_attrs,
    sample_columns,
  };
}

function concatWsVarchar(alias: string, cols: string[]): string {
  if (cols.length === 1) {
    return `CAST(${alias}.${quoteIdent(cols[0]!)} AS VARCHAR)`;
  }
  return `concat_ws(' | ', ${cols
    .map((c) => `CAST(${alias}.${quoteIdent(c)} AS VARCHAR)`)
    .join(", ")})`;
}

/**
 * Legacy host-result attrs SQL (arity-1). Prefer {@link attrsJoinAnchoredSummarySql}.
 */
export function attrsSummarySql(
  hostQueryId: string,
  leftAttr: string,
  rightAttr: string,
  sampleColumn: string,
  groupBudget: number = CHECK_ATTRS_GROUP_BUDGET,
): string {
  return attrsJoinAnchoredSummarySql({
    leftQueryId: hostQueryId,
    rightQueryId: hostQueryId,
    leftOn: [],
    rightOn: [],
    leftAttrs: [leftAttr],
    rightAttrs: [rightAttr],
    sampleColumns: [sampleColumn],
    hostResultMode: true,
    groupBudget,
  });
}

/**
 * Join-anchored attrs overview (ADR-0035): left attrs from left input, right from
 * right input — independent of columns dropped downstream of the Join.
 * Composite left_attrs (incl. date) become one axis label via concat_ws.
 */
export function attrsJoinAnchoredSummarySql(args: {
  leftQueryId: string;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
  leftAttrs: string[];
  rightAttrs: string[];
  sampleColumns: string[];
  /** When true, read a single host result (legacy); ignore ON / dual queries. */
  hostResultMode?: boolean;
  groupBudget?: number;
}): string {
  const budget = Math.max(
    1,
    Math.min(args.groupBudget ?? CHECK_ATTRS_GROUP_BUDGET, 40),
  );
  const leftAttrs = args.leftAttrs.filter(Boolean);
  const rightAttrs = args.rightAttrs.filter(Boolean);
  const sampleColumns = (args.sampleColumns.filter(Boolean).length
    ? args.sampleColumns
    : leftAttrs
  ).filter(Boolean);
  if (!leftAttrs.length || !rightAttrs.length) {
    throw new Error("attrs summary requires left_attrs and right_attrs");
  }

  if (args.hostResultMode) {
    const leftExpr =
      leftAttrs.length === 1
        ? `CAST(${quoteIdent(leftAttrs[0]!)} AS VARCHAR)`
        : `concat_ws(' | ', ${leftAttrs.map((c) => `CAST(${quoteIdent(c)} AS VARCHAR)`).join(", ")})`;
    const rightExpr =
      rightAttrs.length === 1
        ? `CAST(${quoteIdent(rightAttrs[0]!)} AS VARCHAR)`
        : `concat_ws(' | ', ${rightAttrs.map((c) => `CAST(${quoteIdent(c)} AS VARCHAR)`).join(", ")})`;
    const sampleExpr =
      sampleColumns.length === 1
        ? `CAST(${quoteIdent(sampleColumns[0]!)} AS VARCHAR)`
        : `concat_ws(' | ', ${sampleColumns.map((c) => `CAST(${quoteIdent(c)} AS VARCHAR)`).join(", ")})`;
    const rightNull = quoteIdent(rightAttrs[0]!);
    return `
WITH observed AS (
  SELECT
    ${leftExpr} AS source_family,
    COALESCE(${rightExpr}, 'Unmapped') AS target_family,
    '—' AS source_grade,
    '—' AS target_grade,
    'rule' AS decision_method,
    CASE WHEN ${rightNull} IS NULL THEN 'unmapped'
         WHEN ${leftExpr} IS DISTINCT FROM ${rightExpr} THEN 'attribute_difference'
         ELSE 'aligned_attributes' END AS signal,
    ${sampleExpr} AS sample_key
  FROM {{query:${args.leftQueryId}}}
),
agg AS (
  SELECT source_family, target_family, source_grade, target_grade, decision_method, signal,
         COUNT(*) AS positions, 0::DOUBLE AS revenue,
         to_json(list_sort(list(sample_key))[1:6]) AS sample_keys
  FROM observed
  GROUP BY 1,2,3,4,5,6
),
stats AS (
  SELECT COUNT(*)::BIGINT AS group_count,
         COALESCE(SUM(positions), 0)::BIGINT AS total_positions,
         COALESCE(SUM(CASE WHEN signal = 'unmapped' THEN positions ELSE 0 END), 0)::BIGINT AS unmapped_positions
  FROM agg
),
kept AS (
  SELECT * FROM agg ORDER BY positions DESC, source_family, target_family LIMIT ${budget}
)
SELECT k.source_family, k.target_family, k.source_grade, k.target_grade, k.decision_method,
       k.signal, k.positions, s.total_positions, k.revenue, k.sample_keys, s.group_count, s.unmapped_positions
FROM kept k CROSS JOIN stats s
ORDER BY k.positions DESC, k.source_family, k.target_family
`.trim();
  }

  const n = Math.min(args.leftOn.length, args.rightOn.length);
  if (n < 1) {
    throw new Error("Join-anchored attrs summary requires Join ON keys");
  }
  const onSql = Array.from({ length: n }, (_, i) => {
    const L = quoteIdent(args.leftOn[i]!);
    const R = quoteIdent(args.rightOn[i]!);
    return `CAST(l.${L} AS VARCHAR) = CAST(r.${R} AS VARCHAR)`;
  }).join(" AND ");
  const leftExpr = concatWsVarchar("l", leftAttrs);
  const rightExpr = concatWsVarchar("r", rightAttrs);
  const sampleExpr = concatWsVarchar("l", sampleColumns);
  const rightNull = `r.${quoteIdent(rightAttrs[0]!)}`;

  return `
WITH joined AS (
  SELECT
    ${leftExpr} AS source_family,
    ${rightExpr} AS target_family_raw,
    ${sampleExpr} AS sample_key,
    ${rightNull} AS _right_probe
  FROM {{query:${args.leftQueryId}}} AS l
  LEFT JOIN {{query:${args.rightQueryId}}} AS r ON ${onSql}
),
observed AS (
  SELECT
    source_family,
    COALESCE(CAST(target_family_raw AS VARCHAR), 'Unmapped') AS target_family,
    '—' AS source_grade,
    '—' AS target_grade,
    'rule' AS decision_method,
    CASE WHEN _right_probe IS NULL THEN 'unmapped'
         WHEN CAST(source_family AS VARCHAR) IS DISTINCT FROM CAST(target_family_raw AS VARCHAR)
           THEN 'attribute_difference'
         ELSE 'aligned_attributes' END AS signal,
    sample_key
  FROM joined
),
agg AS (
  SELECT source_family, target_family, source_grade, target_grade, decision_method, signal,
         COUNT(*) AS positions, 0::DOUBLE AS revenue,
         to_json(list_sort(list(CAST(sample_key AS VARCHAR)))[1:6]) AS sample_keys
  FROM observed
  GROUP BY 1,2,3,4,5,6
),
stats AS (
  SELECT COUNT(*)::BIGINT AS group_count,
         COALESCE(SUM(positions), 0)::BIGINT AS total_positions,
         COALESCE(SUM(CASE WHEN signal = 'unmapped' THEN positions ELSE 0 END), 0)::BIGINT AS unmapped_positions
  FROM agg
),
kept AS (
  SELECT * FROM agg ORDER BY positions DESC, source_family, target_family LIMIT ${budget}
)
SELECT k.source_family, k.target_family, k.source_grade, k.target_grade, k.decision_method,
       k.signal, k.positions, s.total_positions, k.revenue, k.sample_keys, s.group_count, s.unmapped_positions
FROM kept k CROSS JOIN stats s
ORDER BY k.positions DESC, k.source_family, k.target_family
`.trim();
}

/**
 * Ephemeral workspace for Join-anchored attrs overview (ADR-0035).
 * Left input = host steps before Join; summary SqlModel rebuilds the Join.
 */
export function workspaceForJoinAnchoredAttrsOverview(
  workspace: Workspace,
  args: {
    hostQueryId: string;
    joinStepIndex: number;
    rightQueryId: string;
    leftOn: string[];
    rightOn: string[];
    leftAttrs: string[];
    rightAttrs: string[];
    sampleColumns: string[];
    groupBudget?: number;
  },
): Workspace {
  const host = workspace.queries.find((q) => q.id === args.hostQueryId);
  if (!host) {
    throw new Error(`Attrs overview host “${args.hostQueryId}” not found`);
  }
  if (args.joinStepIndex < 0 || args.joinStepIndex >= host.steps.length) {
    throw new Error(`Join step ${args.joinStepIndex} out of range on host`);
  }
  const leftSteps = host.steps.slice(0, args.joinStepIndex);
  if (!leftSteps.length) {
    throw new Error("Join-anchored overview needs at least one step before Join");
  }
  const proj = normalizeAttrsProjection({
    kind: "attrs",
    host_query_id: args.hostQueryId,
    left_attr: args.leftAttrs[0] ?? "",
    right_attr: args.rightAttrs[0] ?? "",
    sample_column: args.sampleColumns[0] ?? args.leftAttrs[0] ?? "",
    left_attrs: args.leftAttrs,
    right_attrs: args.rightAttrs,
    sample_columns: args.sampleColumns,
  });
  if (proj.kind !== "attrs") throw new Error("expected attrs projection");
  const sql = attrsJoinAnchoredSummarySql({
    leftQueryId: CHECK_LEFT_QUERY_ID,
    rightQueryId: args.rightQueryId,
    leftOn: args.leftOn,
    rightOn: args.rightOn,
    leftAttrs: proj.left_attrs,
    rightAttrs: proj.right_attrs,
    sampleColumns: proj.sample_columns,
    groupBudget: args.groupBudget,
  });
  const withoutEphemeral = workspace.queries.filter(
    (q) => q.id !== CHECK_LEFT_QUERY_ID && q.id !== CHECK_SUMMARY_QUERY_ID,
  );
  return {
    ...workspace,
    focus_query_id: CHECK_SUMMARY_QUERY_ID,
    queries: [
      ...withoutEphemeral,
      {
        id: CHECK_LEFT_QUERY_ID,
        name: "check_left",
        steps: leftSteps,
        execution: host.execution,
      },
      {
        id: CHECK_SUMMARY_QUERY_ID,
        name: "check_summary",
        steps: [{ type: "SqlModel", payload: { raw_sql: sql } }],
        execution: host.execution,
      },
    ],
  };
}

function eqSql(column: string, value: string): string {
  return `CAST(${quoteIdent(column)} AS VARCHAR) = '${value.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
