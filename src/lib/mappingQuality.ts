import type { PreviewResult, QueryDef, Workspace } from "../types/pipeline";

export const QUALITY_JOIN = "quality_joined";
export const QUALITY_SUMMARY = "quality_summary";
export const QUALITY_TARGETS = "quality_targets";
export const QUALITY_MAP = "map_quality_products";
export const QUALITY_TAB = "mapping-quality-overview";
/** Single reusable Inspect drill-down — session-only, not saved with the project. */
export const QUALITY_INSPECTION = "quality_inspection";
/** Result column that Inspect samples refer to (source positions, not join ON). */
export const QUALITY_SAMPLE_COLUMN = "commercial_sku";

export function isMappingQualityLab(workspace: Workspace): boolean {
  const ids = new Set(workspace.queries.map((query) => query.id));
  return (
    [QUALITY_JOIN, QUALITY_SUMMARY, QUALITY_TARGETS].every((id) =>
      ids.has(id),
    ) && (workspace.key_maps ?? []).some((map) => map.id === QUALITY_MAP)
  );
}

/** Full 100K lab Join — too heavy for auto canvas preview / Join Lens on tab switch. */
export function isFullQualityJoin(queryId: string | null | undefined): boolean {
  return queryId === QUALITY_JOIN;
}

/** Stable Inspect node (+ legacy `quality_inspection_*` from earlier multi-query builds). */
export function isQualityInspectionQuery(
  queryId: string | null | undefined,
): boolean {
  if (!queryId) return false;
  return (
    queryId === QUALITY_INSPECTION || queryId.startsWith(`${QUALITY_INSPECTION}_`)
  );
}

/** Replace-or-insert the one ephemeral Inspect query; drop legacy duplicates. */
export function upsertQualityInspection(
  queries: QueryDef[],
  sample: QueryDef,
): QueryDef[] {
  const next = {
    ...sample,
    id: QUALITY_INSPECTION,
  };
  const without = queries.filter((query) => !isQualityInspectionQuery(query.id));
  return [...without, next];
}

/** Drop session Inspect nodes before Save / Export. */
export function stripQualityInspectionQueries(
  workspace: Workspace,
): Workspace {
  const queries = workspace.queries.filter(
    (query) => !isQualityInspectionQuery(query.id),
  );
  const focus = isQualityInspectionQuery(workspace.focus_query_id)
    ? (queries.find((query) => query.id === QUALITY_JOIN)?.id ??
      queries[0]?.id ??
      "")
    : workspace.focus_query_id;
  return { ...workspace, queries, focus_query_id: focus };
}

/**
 * Fingerprint of lab inputs that feed the overview projections.
 * Ignores inspection queries and other canvas edits so returning to the tab
 * does not rebuild a finished analysis.
 */
/** Cache key must change when map *content* or projection deps change (not only row count). */
export function qualityProjectionCacheKey(
  workspace: Workspace,
  opts?: { mapId?: string; hostQueryId?: string },
): string {
  const byId = new Map(workspace.queries.map((query) => [query.id, query]));
  const slim = (id: string) => {
    const query = byId.get(id);
    if (!query) return null;
    return {
      id: query.id,
      steps: query.steps.map((step) => {
        if (step.type !== "ApplyKeyMap") return step;
        return {
          type: step.type,
          payload: {
            column: step.payload.column,
            columns: step.payload.columns,
            output_column: step.payload.output_column,
            as_of_column: step.payload.as_of_column,
            map_id: step.payload.map_id,
            entryCount: step.payload.entries?.length ?? 0,
          },
        };
      }),
    };
  };
  const mapFingerprints = (workspace.key_maps ?? []).map((map) => ({
    id: map.id,
    time_mode: map.time_mode ?? "none",
    rows: [...map.entries]
      .map((e) => {
        const from = (
          e.from_parts?.length ? e.from_parts.join("\0") : e.from
        ).trim();
        const attrs = Object.entries(e.attrs ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(";");
        return `${from}\t${e.to}\t${attrs}`;
      })
      .sort()
      .join("\n"),
  }));
  const host = opts?.hostQueryId;
  return JSON.stringify({
    commercial: slim("quality_commercial"),
    catalog: slim("quality_catalog"),
    join: slim(QUALITY_JOIN),
    summary: slim(QUALITY_SUMMARY),
    targets: slim(QUALITY_TARGETS),
    host: host ? slim(host) : null,
    focusMapId: opts?.mapId ?? null,
    mapFingerprints,
  });
}

export type QualityCell = {
  sourceFamily: string;
  targetFamily: string;
  sourceGrade: string;
  targetGrade: string;
  method: string;
  signal: string;
  positions: number;
  revenue: number;
  samples: string[];
};
export type QualityTarget = {
  key: string;
  family: string;
  grade: string;
  positions: number;
  sourceGrades: number;
  packages: number;
  samples: string[];
};
export const SIGNALS: Record<
  string,
  { label: string; color: string; explanation: string }
> = {
  aligned_attributes: {
    label: "Aligned attributes",
    color: "#57dfbc",
    explanation:
      "Family and grade agree. This is evidence of consistency, not proof of identity.",
  },
  grade_difference: {
    label: "Grade differences",
    color: "#ffb870",
    explanation:
      "Mapped source and target grades differ. Check whether grade is a required distinction.",
  },
  family_difference: {
    label: "Family differences",
    color: "#f3829d",
    explanation:
      "The mapping crosses product families. This can be intentional; inspect the actual positions.",
  },
  close_alternative: {
    label: "Close alternative",
    color: "#b8a0ff",
    explanation:
      "The declared runner-up gap is below 0.03. These accepted links deserve attention even though coverage is high.",
  },
  similarity_only: {
    label: "Similarity basis",
    color: "#8daeff",
    explanation:
      "Declared fuzzy decisions with aligned attributes. A similarity score is not a probability of correctness.",
  },
  unmapped: {
    label: "Without catalog partner",
    color: "#8195aa",
    explanation:
      "No target catalog row was found after applying the map. This is an exact observation for this dataset.",
  },
  attribute_difference: {
    label: "Attribute differences",
    color: "#f0c674",
    explanation:
      "Chosen left/right attributes differ after ApplyKeyMap. Inspect whether the difference is expected.",
  },
};
function records(result: PreviewResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(
      result.columns.map((column, index) => [column.name, row[index]]),
    ),
  );
}
function number(value: unknown): number {
  if (value == null || typeof value === "boolean" || value === "")
    throw new Error("Missing aggregate value.");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Invalid aggregate returned by the quality projection.");
  return parsed;
}
function samples(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  )
    throw new Error("Invalid sample keys.");
  return parsed.slice(0, 6);
}
export function parseQualitySummary(result: PreviewResult): QualityCell[] {
  const rows = records(result);
  const cells = rows.map((row) => {
    const signal = String(row.signal);
    if (!SIGNALS[signal]) throw new Error("Unknown quality signal.");
    return {
      sourceFamily: String(row.source_family),
      targetFamily: String(row.target_family),
      sourceGrade: String(row.source_grade),
      targetGrade: String(row.target_grade),
      method: String(row.decision_method),
      signal,
      positions: number(row.positions),
      revenue: number(row.revenue),
      samples: samples(row.sample_keys),
    };
  });
  const total = cells.reduce((sum, cell) => sum + cell.positions, 0);
  if (
    !rows.length ||
    rows.some((row) => number(row.total_positions) !== total)
  ) {
    throw new Error(
      "The aggregate result is incomplete. A truncated preview cannot represent the whole mapping.",
    );
  }
  return cells;
}
export function parseQualityTargets(result: PreviewResult): QualityTarget[] {
  return records(result).map((row) => ({
    key: String(row.canonical_key),
    family: String(row.target_family),
    grade: String(row.target_grade),
    positions: number(row.positions),
    sourceGrades: number(row.source_grades),
    packages: number(row.packaging_variants),
    samples: samples(row.sample_keys),
  }));
}
export type QualityDimension = "family" | "grade" | "basis";
export function axes(
  cell: QualityCell,
  dimension: QualityDimension,
): [string, string] {
  if (dimension === "grade")
    return [
      `${cell.sourceFamily} · ${cell.sourceGrade}`,
      `${cell.targetFamily} · ${cell.targetGrade}`,
    ];
  if (dimension === "basis") return [cell.method, SIGNALS[cell.signal]!.label];
  return [cell.sourceFamily, cell.targetFamily];
}
/** Creates an ordinary, explicit sample query. No full-row transfer or silent Join mutation. */
export function qualityInspectionQuery(
  workspace: Workspace,
  keys: string[],
): QueryDef {
  const template = workspace.queries.find((query) => query.id === QUALITY_JOIN);
  if (
    !template ||
    template.steps[0]?.type !== "FromQuery" ||
    template.steps[template.steps.length - 1]?.type !== "Join"
  ) {
    throw new Error(
      "The lab Join was changed. Reload the demo before using sample drill-down.",
    );
  }
  const bounded = [...new Set(keys)]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24);
  if (!bounded.length) throw new Error("No sample keys in this selection.");
  const literals = bounded
    .map((key) => `'${key.replace(/'/g, "''")}'`)
    .join(", ");
  // Drop embedded seed rows — compiler resolves ApplyKeyMap from workspace.key_maps.
  const rest = template.steps.slice(1).map((step) => {
    if (step.type !== "ApplyKeyMap") return step;
    return {
      ...step,
      payload: { ...step.payload, entries: [] },
    };
  });
  return {
    ...template,
    id: QUALITY_INSPECTION,
    name: `Sample inspect · ${bounded.length} keys · ephemeral`,
    steps: [
      template.steps[0],
      {
        type: "Filter",
        payload: {
          condition: `"${QUALITY_SAMPLE_COLUMN}" IN (${literals})`,
        },
      },
      // Stable order so Join Lens can pin the first sample key as This row.
      {
        type: "SortBy",
        payload: { column: QUALITY_SAMPLE_COLUMN, descending: false },
      },
      ...rest,
    ],
  };
}
