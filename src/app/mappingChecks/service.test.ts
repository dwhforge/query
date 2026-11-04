import {
  allowCheckDifference,
  createMappingCheck,
  recordCheckRun,
  resolveActiveMappingCheck,
  stageFrozenRemapChanges,
} from "./service";
import { labMappingCheck } from "../../lib/mappingCheck";
import type { Project, QueryDef } from "../../types/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const joinQuery: QueryDef = {
  id: "q_host",
  name: "host",
  steps: [
    {
      type: "Join",
      payload: {
        right_query_id: "q_right",
        join_type: "left",
        left_on: ["sku"],
        right_on: ["id"],
      },
    },
  ],
};

const map = {
  id: "map_1",
  name: "Aliases",
  entries: [{ from: "a", to: "1" }],
};

assert(resolveActiveMappingCheck([]) === null, "empty");
const lab = resolveActiveMappingCheck([labMappingCheck()]);
assert(lab != null && lab.id === "check_lab_quality", "lab preferred");

const created = createMappingCheck({
  checks: [],
  keyMaps: [map as never],
  queries: [joinQuery],
});
assert(created.ok === true, "create ok");
if (created.ok) {
  assert(created.check.projection.kind === "attrs", "attrs projection");
  assert(created.check.map_id === "map_1", "map");
}

const noMap = createMappingCheck({ checks: [], keyMaps: [], queries: [joinQuery] });
assert(noMap.ok === false, "needs map");

const check = labMappingCheck();
const project = {
  id: "p",
  name: "t",
  connections: [],
  sources: [],
  workspace: { queries: [], focus_query_id: "", key_maps: [map] },
  dbt_target: "v1",
  mapping_checks: [check],
  mapping_check_runs: [],
} as Project;

const recorded = recordCheckRun({
  project,
  check,
  cells: [
    {
      sourceFamily: "A",
      targetFamily: "B",
      signal: "mismatch",
      positions: 2,
      revenue: 10,
      samples: ["x"],
    },
  ],
  totalPositions: 2,
});
assert(recorded.run.total_positions === 2, "run positions");
assert(recorded.mapping_check_runs.length === 1, "one run");
assert(recorded.deltaNote.includes("CheckRun recorded"), "note");

const allowed = allowCheckDifference({
  checks: [check],
  checkId: check.id,
  groupKey: "A→B",
  explanation: "ok",
});
assert(allowed.ok === true, "allow");
if (allowed.ok) {
  assert(allowed.mapping_checks[0].allow_decisions.length === 1, "decision");
}

const frozen = stageFrozenRemapChanges(
  {
    check_id: check.id,
    map_id: map.id,
    expected_map_revision: "rev",
    expected_input_revisions: [],
    changes: [],
    previewed_at: "t",
  },
  ["from1"],
  ["to1"],
);
assert(frozen.changes.length === 1 && frozen.changes[0].to === "to1", "stage");

console.log("mappingChecks/service.test.ts: ok");
