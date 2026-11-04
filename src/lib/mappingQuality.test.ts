import {
  QUALITY_INSPECTION,
  axes,
  parseQualitySummary,
  parseQualitySummaryDetailed,
  qualityInspectionQuery,
  stripQualityInspectionQueries,
  upsertQualityInspection,
} from "./mappingQuality";
import type { PreviewResult, Workspace } from "../types/pipeline";
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
function rejects(fn: () => unknown) {
  let rejected = false;
  try {
    fn();
  } catch {
    rejected = true;
  }
  assert(rejected, "must reject invalid/incomplete input");
}
const result: PreviewResult = {
  columns: [
    "source_family",
    "target_family",
    "source_grade",
    "target_grade",
    "decision_method",
    "signal",
    "positions",
    "revenue",
    "sample_keys",
    "total_positions",
  ].map((name) => ({ name, type: "VARCHAR" })),
  rows: [
    [
      "Urea",
      "Urea",
      "A",
      "A",
      "rule",
      "aligned_attributes",
      90,
      1000,
      '["C1","C2"]',
      100,
    ],
    [
      "Sulfur",
      "Urea",
      "A",
      "A",
      "manual",
      "family_difference",
      10,
      400,
      '["C3"]',
      100,
    ],
  ],
  sql: "",
};
const cells = parseQualitySummary(result);
assert(
  cells.reduce((sum, c) => sum + c.positions, 0) === 100,
  "counts cover whole aggregate",
);
assert(axes(cells[0]!, "grade")[0] === "Urea · A", "grade view retains family");
assert(
  axes(cells[1]!, "basis")[0] === "manual",
  "decision basis is separate from similarity",
);
rejects(() =>
  parseQualitySummary({ ...result, rows: result.rows.slice(0, 1) }),
);
rejects(() =>
  parseQualitySummary({
    ...result,
    rows: [[...result.rows[0]!.slice(0, 6), null, ...result.rows[0]!.slice(7)]],
  }),
);
const workspace: Workspace = {
  focus_query_id: "quality_joined",
  key_maps: [],
  queries: [
    {
      id: "quality_joined",
      name: "join",
      steps: [
        { type: "FromQuery", payload: { query_id: "raw" } },
        {
          type: "Join",
          payload: {
            right_query_id: "catalog",
            join_type: "left",
            left_on: ["key"],
            right_on: ["id"],
          },
        },
      ],
    },
  ],
};
const before = JSON.stringify(workspace);
const sample = qualityInspectionQuery(workspace, ["a'b", "z-key"]);
assert(
  sample.steps[1]?.type === "Filter" &&
    sample.steps[1].payload.condition.includes("a''b"),
  "quote exact sample keys",
);
assert(
  sample.steps[2]?.type === "SortBy" &&
    sample.steps[2].payload.column === "commercial_sku",
  "stable sample order for Join Lens pin",
);
assert(
  sample.steps[sample.steps.length - 1]?.type === "Join",
  "drill-down remains a real Join",
);
const capped = qualityInspectionQuery(
  workspace,
  Array.from({ length: 30 }, (_, i) => `k${String(i).padStart(2, "0")}`),
);
assert(
  capped.steps[1]?.type === "Filter" &&
    (capped.steps[1].payload.condition.match(/'/g)?.length ?? 0) === 48,
  "sample inspect caps at 24 keys (24 quoted literals)",
);
assert(sample.id === QUALITY_INSPECTION, "stable ephemeral id");
assert(
  JSON.stringify(workspace) === before,
  "drill-down must not mutate the original Join",
);
const once = upsertQualityInspection(workspace.queries, sample);
const twice = upsertQualityInspection(
  [...once, { ...sample, id: "quality_inspection_old" }],
  { ...sample, name: "replaced" },
);
assert(twice.filter((q) => q.id.startsWith("quality_inspection")).length === 1, "one ephemeral node");
assert(twice.at(-1)?.name === "replaced", "latest Inspect wins");
const stripped = stripQualityInspectionQueries({
  ...workspace,
  queries: twice,
  focus_query_id: QUALITY_INSPECTION,
});
assert(
  stripped.queries.every((q) => q.id !== QUALITY_INSPECTION),
  "strip removes ephemeral before save",
);
assert(stripped.focus_query_id === "quality_joined", "strip restores lab join focus");
rejects(() => qualityInspectionQuery(workspace, []));

// Budgeted attrs summary: group_count + unmapped_positions drive KPI, not top-N cells.
{
  const budgeted: PreviewResult = {
    columns: [
      "source_family",
      "target_family",
      "source_grade",
      "target_grade",
      "decision_method",
      "signal",
      "positions",
      "total_positions",
      "revenue",
      "sample_keys",
      "group_count",
      "unmapped_positions",
    ].map((name) => ({ name, type: "VARCHAR" })),
    rows: [
      [
        "A",
        "B",
        "—",
        "—",
        "rule",
        "attribute_difference",
        40,
        1000,
        0,
        '["k1"]',
        80,
        300,
      ],
      [
        "C",
        "Unmapped",
        "—",
        "—",
        "rule",
        "unmapped",
        10,
        1000,
        0,
        '["k2"]',
        80,
        300,
      ],
    ],
    sql: "",
  };
  const detailed = parseQualitySummaryDetailed(budgeted);
  assert(detailed.incomplete === true, "top-N incomplete");
  assert(detailed.groupCount === 80, "full group_count");
  assert(detailed.totalPositions === 1000, "full total");
  assert(detailed.coveredPositions === 50, "top-N covered");
  assert(
    detailed.unmappedPositions === 300,
    "unmapped from stats — not sum of top-N unmapped cells (10)",
  );
  // Coverage KPI must use full unmapped, not cell-inferred 10 → fake 99%.
  const coverage =
    (100 * (detailed.totalPositions - detailed.unmappedPositions)) /
    detailed.totalPositions;
  assert(Math.abs(coverage - 70) < 0.01, `coverage ${coverage}% uses full unmapped`);
}

console.log("mappingQuality.test.ts: ok");
