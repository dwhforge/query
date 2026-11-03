import {
  applyFrozenRemapToMap,
  assertRemapConfirmable,
  attributeDelta,
  buildCheckRun,
  cohortPredicateFromSamples,
  deltaLabel,
  keyMapRevision,
  labMappingCheck,
  upsertAllowDecision,
} from "./mappingCheck";
import type { CheckRun } from "../types/mappingCheck";
import type { KeyMapDef, Workspace } from "../types/pipeline";

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
assert(attributeDelta(runA, runB) === "mapping_changed", "Δ maps to mapping");
assert(deltaLabel("limited").includes("Limited"), "limited label");

const freeze = {
  check_id: check.id,
  map_id: map.id,
  expected_map_revision: r1,
  changes: [{ from: "a", to: "9" }],
  previewed_at: new Date().toISOString(),
};
assertRemapConfirmable(freeze, map);
try {
  assertRemapConfirmable(
    { ...freeze, expected_map_revision: "stale" },
    map,
  );
  throw new Error("stale should refuse");
} catch (e) {
  assert(String(e).includes("preview"), "stale remap refused");
}
const next = applyFrozenRemapToMap(map, freeze);
assert(next.entries.find((e) => e.from === "a")?.to === "9", "remap applied");

const allowed = upsertAllowDecision(check, '["Urea","Sulfur"]', "intentional");
assert(allowed.allow_decisions.length === 1, "allow on check");
try {
  upsertAllowDecision(check, "x", "  ");
  throw new Error("empty explanation must fail");
} catch (e) {
  assert(String(e).includes("explanation"), "allow needs explanation");
}

const pred = cohortPredicateFromSamples("commercial_sku", ["b", "a"]);
assert(pred.includes("'a'") && pred.includes("'b'"), "predicate from samples");

console.log("mappingCheck.test.ts: ok");
