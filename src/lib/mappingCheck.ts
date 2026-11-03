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
} from "../types/mappingCheck";
import type { KeyMapDef, QueryDef, Workspace } from "../types/pipeline";
import {
  QUALITY_INSPECTION,
  QUALITY_JOIN,
  QUALITY_MAP,
  QUALITY_SAMPLE_COLUMN,
  isMappingQualityLab,
  parseQualitySummary,
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
  for (const step of q.steps) {
    if (step.type === "LoadCsv" || step.type === "LoadParquet") {
      return {
        ref_id: queryId,
        revision: null,
        unknown_reason: `${step.type} content version not tracked (path-only)`,
      };
    }
    if (step.type === "LoadPostgres") {
      return {
        ref_id: queryId,
        revision: null,
        unknown_reason: "postgres relation version not tracked",
      };
    }
    if (step.type === "LoadDuckdb") {
      return {
        ref_id: queryId,
        revision: null,
        unknown_reason: "duckdb file content version not tracked",
      };
    }
    if (step.type === "FromQuery") {
      const upstream = inputRevisionForQuery(
        workspace,
        String(step.payload.query_id),
        seen,
      );
      if (upstream.revision == null) {
        return {
          ref_id: queryId,
          revision: null,
          unknown_reason:
            upstream.unknown_reason ??
            `upstream ${upstream.ref_id} has no reliable version`,
        };
      }
    }
    if (step.type === "Join") {
      const right = inputRevisionForQuery(
        workspace,
        String(step.payload.right_query_id),
        seen,
      );
      if (right.revision == null) {
        return {
          ref_id: queryId,
          revision: null,
          unknown_reason:
            right.unknown_reason ??
            `join right ${right.ref_id} has no reliable version`,
        };
      }
    }
  }
  // No fragile external loads: fingerprint the full step graph for this query.
  return {
    ref_id: queryId,
    revision: `steps:${fnv1a(JSON.stringify(q.steps))}`,
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
): KeyMapDef {
  assertRemapConfirmable(freeze, map, workspace, check);
  const arity = fromColumnsEff(map).length;
  if (arity > 1 || map.time_mode === "range_scd") {
    throw new Error(
      "Frozen batch remap v1 supports only static arity-1 maps (not composite / range SCD).",
    );
  }
  const byFrom = new Map(freeze.changes.map((c) => [c.from.trim(), c.to]));
  const entries = map.entries.map((e) => {
    const hit = byFrom.get(fromPartsEff(e)[0]?.trim() || e.from.trim());
    if (hit == null) return e;
    byFrom.delete(e.from.trim());
    return { ...e, to: hit };
  });
  for (const [from, to] of byFrom) {
    entries.push({ from, to });
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
}): CheckRun {
  const input_revisions = collectInputRevisions(args.workspace, args.check);
  return {
    id: newCheckRunId(),
    check_id: args.check.id,
    ran_at: new Date().toISOString(),
    map_revision: keyMapRevision(args.map),
    input_revisions,
    check_definition_revision: checkDefinitionRevision(args.check),
    total_positions: args.totalPositions,
    cells: args.cells,
    comparability: runComparability(input_revisions),
  };
}

export function cellsFromQualitySummary(
  result: PreviewResult,
): { cells: CheckAggregateCell[]; total: number } {
  const parsed = parseQualitySummary(result);
  const cells: CheckAggregateCell[] = parsed.map((c) => ({
    row: c.sourceFamily,
    column: c.targetFamily,
    signal: c.signal,
    positions: c.positions,
    revenue: c.revenue,
    samples: c.samples,
  }));
  const total = cells.reduce((s, c) => s + c.positions, 0);
  return { cells, total };
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

/** Attrs-projection cohort: equality on left/right attr values of selected cells. */
export function cohortPredicateFromAttrCells(
  leftAttr: string,
  rightAttr: string,
  cells: QualityCell[],
): string {
  if (!cells.length) throw new Error("No cells for cohort predicate.");
  const parts = cells.map((c) => {
    const right =
      c.targetFamily === "Unmapped"
        ? `${quoteIdent(rightAttr)} IS NULL`
        : eqSql(rightAttr, c.targetFamily);
    return `(${eqSql(leftAttr, c.sourceFamily)} AND ${right})`;
  });
  return [...new Set(parts)].join(" OR ");
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
export function cohortInspectionQuery(
  workspace: Workspace,
  check: MappingCheck,
): QueryDef {
  if (!check.cohort_predicate.trim()) {
    throw new Error("Select a matrix cell (cohort) before opening Join Lens.");
  }
  const sampleColumn =
    check.projection.kind === "attrs"
      ? check.projection.sample_column
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
  // Attrs: Filter after Join so right-side attributes exist.
  const body = template.steps.map((step) => {
    if (step.type !== "ApplyKeyMap") return step;
    return { ...step, payload: { ...step.payload, entries: [] } };
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

export function attrsSummarySql(
  hostQueryId: string,
  leftAttr: string,
  rightAttr: string,
  sampleColumn: string,
): string {
  const L = quoteIdent(leftAttr);
  const R = quoteIdent(rightAttr);
  const S = quoteIdent(sampleColumn);
  return `
WITH observed AS (
  SELECT *,
    CASE WHEN ${R} IS NULL THEN 'unmapped'
         WHEN CAST(${L} AS VARCHAR) IS DISTINCT FROM CAST(${R} AS VARCHAR) THEN 'attribute_difference'
         ELSE 'aligned_attributes' END AS signal
  FROM {{query:${hostQueryId}}}
)
SELECT CAST(${L} AS VARCHAR) AS source_family,
       COALESCE(CAST(${R} AS VARCHAR), 'Unmapped') AS target_family,
       '—' AS source_grade,
       '—' AS target_grade,
       'rule' AS decision_method,
       signal,
       COUNT(*) AS positions,
       SUM(COUNT(*)) OVER() AS total_positions,
       0::DOUBLE AS revenue,
       to_json(list_sort(list(CAST(${S} AS VARCHAR)))[1:6]) AS sample_keys
FROM observed
GROUP BY 1,2,3,4,5,6
ORDER BY 1,2
`.trim();
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
