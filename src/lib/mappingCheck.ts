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
  qualityInspectionQuery,
} from "./mappingQuality";
import type { PreviewResult } from "../types/pipeline";

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

export function keyMapRevision(map: KeyMapDef | undefined | null): string {
  if (!map) return "missing_map";
  const rows = [...map.entries]
    .map((e) => {
      const from = (e.from_parts?.length ? e.from_parts.join("\0") : e.from).trim();
      return `${from}\t${e.to.trim()}`;
    })
    .sort();
  return `map:${map.id}:n=${rows.length}:h=${fnv1a(rows.join("\n"))}`;
}

export function checkDefinitionRevision(check: MappingCheck): string {
  const payload = JSON.stringify({
    map_id: check.map_id,
    input_refs: check.input_refs,
    group_attributes: check.group_attributes,
    projection: check.projection,
  });
  return `def:${fnv1a(payload)}`;
}

export function inputRevisionForQuery(
  workspace: Workspace,
  queryId: string,
): CheckInputRevision {
  const q = workspace.queries.find((x) => x.id === queryId);
  if (!q) {
    return {
      ref_id: queryId,
      revision: null,
      unknown_reason: "query missing",
    };
  }
  const loads = q.steps.filter(
    (s) =>
      s.type === "LoadCsv" ||
      s.type === "LoadParquet" ||
      s.type === "LoadPostgres" ||
      s.type === "LoadDuckdb",
  );
  if (!loads.length) {
    return {
      ref_id: queryId,
      revision: `steps:${fnv1a(JSON.stringify(q.steps))}`,
    };
  }
  const parts: string[] = [];
  let unknown: string | undefined;
  for (const step of loads) {
    if (step.type === "LoadCsv" || step.type === "LoadParquet") {
      parts.push(`${step.type}:${step.payload.path}`);
    } else if (step.type === "LoadPostgres") {
      unknown = "postgres relation version not tracked";
      parts.push(
        `LoadPostgres:${step.payload.schema}.${step.payload.table}`,
      );
    } else if (step.type === "LoadDuckdb") {
      parts.push(`LoadDuckdb:${step.payload.path}:${step.payload.table}`);
    }
  }
  if (unknown) {
    return { ref_id: queryId, revision: null, unknown_reason: unknown };
  }
  return { ref_id: queryId, revision: `loads:${fnv1a(parts.join("|"))}` };
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
    case "unchanged":
      return "No map/input revision change";
    case "limited":
      return "Limited comparability";
  }
}

export function assertRemapConfirmable(
  freeze: FrozenRemapPreview,
  map: KeyMapDef | undefined,
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
  if (!freeze.changes.length) {
    throw new Error("No From→To changes in the frozen preview.");
  }
}

export function applyFrozenRemapToMap(
  map: KeyMapDef,
  freeze: FrozenRemapPreview,
): KeyMapDef {
  assertRemapConfirmable(freeze, map);
  const byFrom = new Map(freeze.changes.map((c) => [c.from.trim(), c.to]));
  const entries = map.entries.map((e) => {
    const hit = byFrom.get(e.from.trim());
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

export function cohortInspectionQuery(
  workspace: Workspace,
  check: MappingCheck,
): QueryDef {
  if (!check.cohort_predicate.trim()) {
    throw new Error("Select a matrix cell (cohort) before opening Join Lens.");
  }
  if (check.projection.kind === "lab_v1" || isMappingQualityLab(workspace)) {
    const keys = parseInListPredicate(
      check.cohort_predicate,
      QUALITY_SAMPLE_COLUMN,
    );
    if (keys?.length) {
      return qualityInspectionQuery(workspace, keys);
    }
  }
  const hostId =
    check.projection.kind === "attrs"
      ? check.projection.host_query_id
      : QUALITY_JOIN;
  const template = workspace.queries.find((q) => q.id === hostId);
  if (!template || template.steps[template.steps.length - 1]?.type !== "Join") {
    throw new Error("Check host query must end with a Join.");
  }
  const sampleColumn =
    check.projection.kind === "attrs"
      ? check.projection.sample_column
      : QUALITY_SAMPLE_COLUMN;
  const rest = template.steps.slice(1).map((step) => {
    if (step.type !== "ApplyKeyMap") return step;
    return { ...step, payload: { ...step.payload, entries: [] } };
  });
  return {
    ...template,
    id: QUALITY_INSPECTION,
    name: `Check cohort · ephemeral`,
    steps: [
      template.steps[0]!,
      {
        type: "Filter",
        payload: { condition: check.cohort_predicate.trim() },
      },
      {
        type: "SortBy",
        payload: { column: sampleColumn, descending: false },
      },
      ...rest,
    ],
  };
}

export function cohortPredicateFromSamples(
  sampleColumn: string,
  keys: string[],
): string {
  const bounded = [...new Set(keys)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24);
  if (!bounded.length) throw new Error("No sample keys for cohort predicate.");
  const literals = bounded
    .map((key) => `'${key.replace(/'/g, "''")}'`)
    .join(", ");
  return `"${sampleColumn}" IN (${literals})`;
}

export function attrsSummarySql(
  hostQueryId: string,
  leftAttr: string,
  rightAttr: string,
): string {
  const L = quoteIdent(leftAttr);
  const R = quoteIdent(rightAttr);
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
       to_json(list_sort(list(CAST(${L} AS VARCHAR)))[1:6]) AS sample_keys
FROM observed
GROUP BY 1,2,3,4,5,6
ORDER BY 1,2
`.trim();
}

function parseInListPredicate(
  predicate: string,
  column: string,
): string[] | null {
  const re = new RegExp(
    `^\\s*"?${escapeReg(column)}"?\\s+IN\\s*\\((.*)\\)\\s*$`,
    "i",
  );
  const m = predicate.trim().match(re);
  if (!m?.[1]) return null;
  const keys: string[] = [];
  const lit = /'((?:[^']|'')*)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = lit.exec(m[1]))) {
    keys.push(hit[1].replace(/''/g, "'"));
  }
  return keys.length ? keys : null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
