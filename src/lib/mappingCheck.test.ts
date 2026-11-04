import {
  applyFrozenRemapToMap,
  assertRemapConfirmable,
  attributeDelta,
  buildCheckRun,
  checkDefinitionRevision,
  cohortInspectionQuery,
  cohortPredicateForTarget,
  cohortPredicateFromAttrCells,
  cohortPredicateFromCells,
  collectInputRevisions,
  deltaLabel,
  inputRevisionForQuery,
  keyMapRevision,
  labMappingCheck,
  resolveInspectJoinLensTarget,
  upsertAllowDecision,
} from "./mappingCheck";
import { QUALITY_JOIN } from "./mappingQuality";
import type { CheckRun, MappingCheck } from "../types/mappingCheck";
import type { KeyMapDef, Workspace } from "../types/pipeline";
import { parseQualitySummary, SIGNALS } from "./mappingQuality";
import { validateKeyMapEntries } from "./keyMap";
import { parseScdBound } from "./scdBound";

function assert(v: unknown, msg: string) {
  if (!v) throw new Error(msg);
}

const map: KeyMapDef = {
  id: "map_quality_products",
  name: "m",
  entries: [
    { from: "a", to: "1" },
    { from: "b", to: "2" },
  ],
};

const r1 = keyMapRevision(map);
const r2 = keyMapRevision({
  ...map,
  entries: [
    { from: "a", to: "9" },
    { from: "b", to: "2" },
  ],
});
assert(r1 !== r2, "map revision changes when links change");

const rAttrs = keyMapRevision({
  ...map,
  entries: [{ from: "a", to: "1", attrs: { reason: "x" } }, { from: "b", to: "2" }],
});
assert(rAttrs !== r1, "map revision changes when attrs change");

const check = labMappingCheck();
const ws: Workspace = {
  focus_query_id: "quality_joined",
  key_maps: [map],
  queries: [
    {
      id: "quality_commercial",
      name: "c",
      steps: [{ type: "LoadCsv", payload: { path: "/tmp/c.csv" } }],
    },
    {
      id: "quality_catalog",
      name: "k",
      steps: [{ type: "LoadCsv", payload: { path: "/tmp/k.csv" } }],
    },
    {
      id: "quality_joined",
      name: "j",
      steps: [
        { type: "FromQuery", payload: { query_id: "quality_commercial" } },
        {
          type: "Join",
          payload: {
            right_query_id: "quality_catalog",
            join_type: "left",
            left_on: ["k"],
            right_on: ["id"],
          },
        },
      ],
    },
  ],
};

const fileRev = inputRevisionForQuery(ws, "quality_commercial");
assert(fileRev.revision == null, "CSV path-only → unknown revision");
assert(
  collectInputRevisions(ws, check).some((r) => r.revision == null),
  "lab inputs limited",
);

const runA = buildCheckRun({
  check,
  workspace: ws,
  map,
  cells: [
    {
      row: "Urea",
      column: "Urea",
      signal: "aligned_attributes",
      positions: 10,
      revenue: 0,
      samples: ["a"],
    },
  ],
  totalPositions: 10,
});
assert(runA.comparability.kind === "limited", "file loads → limited comparability");

const runB: CheckRun = {
  ...buildCheckRun({
    check,
    workspace: ws,
    map: { ...map, entries: [{ from: "a", to: "9" }, { from: "b", to: "2" }] },
    cells: runA.cells,
    totalPositions: 10,
  }),
  input_revisions: runA.input_revisions,
  comparability: { kind: "full" },
};
// With limited runs, Δ is limited
assert(attributeDelta(runA, runB) === "limited", "limited Δ when comparability limited");

const runFullA: CheckRun = { ...runA, comparability: { kind: "full" } };
const runFullB: CheckRun = {
  ...runB,
  comparability: { kind: "full" },
  check_definition_revision: runA.check_definition_revision,
};
assert(attributeDelta(runFullA, runFullB) === "mapping_changed", "Δ maps to mapping");

const check2 = { ...check, cohort_predicate: `"source_family" = 'X'` };
assert(
  checkDefinitionRevision(check) !== checkDefinitionRevision(check2),
  "cohort in definition revision",
);
const runDef: CheckRun = {
  ...runFullB,
  map_revision: runFullA.map_revision,
  input_revisions: runFullA.input_revisions,
  check_definition_revision: checkDefinitionRevision(check2),
};
assert(
  attributeDelta(runFullA, runDef) === "definition_changed",
  "definition change attributed",
);
assert(deltaLabel("definition_changed").includes("definition"), "definition label");

const freeze = {
  check_id: check.id,
  map_id: map.id,
  expected_map_revision: r1,
  expected_input_revisions: collectInputRevisions(ws, check),
  changes: [{ from: "a", to: "9" }],
  previewed_at: new Date().toISOString(),
};
assertRemapConfirmable(freeze, map, ws, check);
try {
  assertRemapConfirmable(
    { ...freeze, expected_map_revision: "stale" },
    map,
  );
  throw new Error("stale should refuse");
} catch (e) {
  assert(String(e).includes("preview"), "stale remap refused");
}
const next = applyFrozenRemapToMap(map, freeze, ws, check);
assert(next.entries.find((e) => e.from === "a")?.to === "9", "remap applied");

const scdMap: KeyMapDef = {
  ...map,
  time_mode: "range_scd",
  entries: [
    {
      from: "a",
      to: "1",
      attrs: { valid_from: "2024-01-01", valid_to: "2024-06-01" },
    },
  ],
};
{
  let refused = false;
  try {
    applyFrozenRemapToMap(scdMap, {
      ...freeze,
      map_id: scdMap.id,
      expected_map_revision: keyMapRevision(scdMap),
    });
  } catch (e) {
    refused = /static arity-1|not composite \/ range SCD/i.test(String(e));
  }
  assert(refused, "SCD batch remap refused by applyFrozenRemapToMap");
}

const allowed = upsertAllowDecision(check, '["Urea","Sulfur"]', "intentional");
assert(allowed.allow_decisions.length === 1, "allow on check");
try {
  upsertAllowDecision(check, "x", "  ");
  throw new Error("empty explanation must fail");
} catch (e) {
  assert(String(e).includes("explanation"), "allow needs explanation");
}

const pred = cohortPredicateFromCells([
  {
    sourceFamily: "Urea",
    targetFamily: "Urea",
    sourceGrade: "A",
    targetGrade: "A",
    method: "exact",
    signal: "aligned_attributes",
    positions: 3,
    revenue: 0,
    samples: ["k1", "k2"],
  },
]);
assert(pred.includes("source_family") && pred.includes("Urea"), "cohort from group dims");
assert(!pred.includes("IN ("), "cohort is not sample IN-list");

assert(SIGNALS.attribute_difference, "attribute_difference signal registered");
const fakeSummary = {
  columns: [
    { name: "source_family" },
    { name: "target_family" },
    { name: "source_grade" },
    { name: "target_grade" },
    { name: "decision_method" },
    { name: "signal" },
    { name: "positions" },
    { name: "total_positions" },
    { name: "revenue" },
    { name: "sample_keys" },
  ],
  rows: [
    ["A", "B", "—", "—", "rule", "attribute_difference", 2, 2, 0, '["x"]'],
  ],
  sql: "",
  truncated: false,
};
const parsed = parseQualitySummary(fakeSummary as never);
assert(parsed[0]?.signal === "attribute_difference", "parser accepts attribute_difference");

const scdOk = validateKeyMapEntries(
  [
    {
      from: "sku",
      to: "item",
      attrs: { valid_from: "2024-01-01", valid_to: "2024-06-01" },
    },
    {
      from: "sku",
      to: "item2",
      attrs: { valid_from: "2024-06-01", valid_to: "" },
    },
  ],
  1,
  { timeMode: "range_scd" },
);
assert(scdOk.ok, "non-overlapping SCD From duplicates allowed");

const scdBad = validateKeyMapEntries(
  [
    {
      from: "sku",
      to: "item",
      attrs: { valid_from: "apple", valid_to: "banana" },
    },
  ],
  1,
  { timeMode: "range_scd" },
);
assert(!scdBad.ok, "non-date SCD bounds rejected");

assert(parseScdBound("2026-02-31") == null, "reject Feb 31");
assert(parseScdBound("2026-11-03T25:00:00") == null, "reject hour 25");
assert(parseScdBound("2026-11-03T10:00:00garbage") == null, "reject garbage");
assert(parseScdBound("2026-11-03T10:00:00+03:00") == null, "reject offset");
assert(parseScdBound("+") == null, "reject lone +");
assert(parseScdBound("2026-11-03T10:00:00.100Z") == null, "reject fractional v1");
const t0 = parseScdBound("2026-11-03T10:00:00")!;
const t1 = parseScdBound("2026-11-03T11:00:00")!;
assert(t1 - t0 === 3600_000, "timestamp keeps hour precision");

const up: Workspace = {
  focus_query_id: "down",
  key_maps: [],
  queries: [
    {
      id: "up",
      name: "up",
      steps: [{ type: "SqlModel", payload: { raw_sql: "SELECT 1 AS k" } }],
    },
    {
      id: "down",
      name: "down",
      steps: [{ type: "FromQuery", payload: { query_id: "up" } }],
    },
  ],
};
const d1 = inputRevisionForQuery(up, "down");
const up2: Workspace = {
  ...up,
  queries: [
    {
      id: "up",
      name: "up",
      steps: [{ type: "SqlModel", payload: { raw_sql: "SELECT 2 AS k" } }],
    },
    up.queries[1]!,
  ],
};
const d2 = inputRevisionForQuery(up2, "down");
assert(d1.revision && d2.revision && d1.revision !== d2.revision, "upstream in digest");

assert(
  cohortPredicateForTarget("SKU-1").includes("canonical_key"),
  "target cohort",
);

{
  const hostWs: Workspace = {
    focus_query_id: "pos_mapped",
    key_maps: [],
    queries: [
      {
        id: "pos_mapped",
        name: "pos_mapped",
        steps: [
          { type: "LoadParquet", payload: { path: "a.parquet" } },
          {
            type: "ApplyKeyMap",
            payload: {
              column: "sku_code",
              map_id: "map_pos",
              entries: [{ from: "CC-1", to: "WH-BEV-1101" }],
            },
          },
          {
            type: "Join",
            payload: {
              right_query_id: "wms",
              join_type: "left",
              left_on: ["item_code"],
              right_on: ["item_code"],
            },
          },
        ],
      },
    ],
  };
  const attrsCheck: MappingCheck = {
    ...labMappingCheck(),
    id: "check_attrs",
    map_id: "map_pos",
    input_refs: ["pos_mapped"],
    cohort_predicate: cohortPredicateFromAttrCells("item_code", "item_code", [
      {
        sourceFamily: "WH-BEV-1101",
        targetFamily: "WH-BEV-1101",
        sourceGrade: "—",
        targetGrade: "—",
        method: "rule",
        signal: "aligned_attributes",
        positions: 1,
        revenue: 0,
        samples: ["WH-BEV-1101"],
      },
    ]),
    projection: {
      kind: "attrs",
      host_query_id: "pos_mapped",
      left_attr: "item_code",
      right_attr: "item_code",
      sample_column: "item_code",
    },
  };
  const sample = cohortInspectionQuery(hostWs, attrsCheck);
  const apply = sample.steps.find((s) => s.type === "ApplyKeyMap");
  assert(apply?.type === "ApplyKeyMap", "inspect keeps ApplyKeyMap");
  if (apply?.type === "ApplyKeyMap") {
    assert(
      (apply.payload.entries ?? []).some((e) => e.to === "WH-BEV-1101"),
      "inspect must not wipe host KeyMap entries",
    );
  }
  assert(
    sample.steps.some((s) => s.type === "Filter"),
    "inspect adds cohort Filter",
  );
}

{
  const labWs: Workspace = {
    focus_query_id: QUALITY_JOIN,
    key_maps: [],
    queries: [
      {
        id: QUALITY_JOIN,
        name: "joined",
        steps: [
          { type: "LoadParquet", payload: { path: "a.parquet" } },
          {
            type: "Join",
            payload: {
              right_query_id: "dim",
              join_type: "left",
              left_on: ["sku"],
              right_on: ["id"],
            },
          },
        ],
      },
    ],
  };
  const labInspect = cohortInspectionQuery(labWs, {
    ...labMappingCheck(),
    cohort_predicate: `signal = 'aligned_attributes'`,
  });
  assert(
    labInspect.steps.every((s) => s.type !== "Join"),
    "lab inspect is SqlModel wrapper",
  );
  const lens = resolveInspectJoinLensTarget(labWs, labInspect);
  assert(lens?.hostQueryId === QUALITY_JOIN, "lab lens → QUALITY_JOIN");
  assert(lens?.joinStepIndex === 1, "lab join step index");
  assert(lens?.leftOn[0] === "sku", "lab left_on");
}

console.log("mappingCheck.test.ts: ok");
