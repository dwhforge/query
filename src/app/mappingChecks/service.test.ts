import {
  allowCheckDifference,
  confirmFrozenCheckRemap,
  createMappingCheck,
  findJoinHostsForMap,
  recordCheckRun,
  resolveActiveMappingCheck,
  stageFrozenRemapChanges,
  summarizeCellDeltas,
} from "./service";
import { keyMapRevision, labMappingCheck } from "../../lib/mappingCheck";
import { upsertKeyMapIntoProject } from "../keyMap";
import type { Project, QueryDef } from "../../types/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const map = {
  id: "map_actual",
  name: "Actual",
  entries: [{ from: "x", to: "B" }],
  storage: { kind: "seed" as const },
};

const mapUnrelated = {
  id: "map_unrelated",
  name: "Unrelated",
  entries: [{ from: "z", to: "9" }],
  storage: { kind: "seed" as const },
};

const joinQuery: QueryDef = {
  id: "q_host",
  name: "host",
  steps: [
    {
      type: "ApplyKeyMap",
      payload: {
        map_id: "map_actual",
        column: "sku",
        entries: [{ from: "x", to: "B" }],
      },
    },
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

assert(resolveActiveMappingCheck([]) === null, "empty");
const lab = resolveActiveMappingCheck([labMappingCheck()]);
assert(lab != null && lab.id === "check_lab_quality", "lab preferred");

{
  const hosts = findJoinHostsForMap([joinQuery], "map_actual");
  assert(hosts.length === 1 && hosts[0]!.host.id === "q_host", "host for map");
  assert(
    findJoinHostsForMap([joinQuery], "map_unrelated").length === 0,
    "unrelated map has no host",
  );
}

{
  const created = createMappingCheck({
    checks: [],
    keyMaps: [mapUnrelated as never, map as never],
    queries: [joinQuery],
    mapId: "map_actual",
    hostQueryId: "q_host",
    leftAttr: "sku",
    rightAttr: "id",
  });
  assert(created.ok === true, "create ok");
  if (created.ok) {
    assert(created.check.map_id === "map_actual", "bound to actual map");
    assert(
      created.check.projection.kind === "attrs" &&
        created.check.projection.host_query_id === "q_host",
      "host",
    );
  }
}

{
  const wrong = createMappingCheck({
    checks: [],
    keyMaps: [map as never, mapUnrelated as never],
    queries: [joinQuery],
    mapId: "map_unrelated",
    hostQueryId: "q_host",
    leftAttr: "sku",
    rightAttr: "id",
  });
  assert(wrong.ok === false, "refuse unrelated map on this Join host");
}

{
  const noMap = createMappingCheck({
    checks: [],
    keyMaps: [],
    queries: [joinQuery],
    mapId: "missing",
    hostQueryId: "q_host",
    leftAttr: "sku",
    rightAttr: "id",
  });
  assert(noMap.ok === false, "needs map");
}

const check = labMappingCheck();
const project = {
  id: "p",
  name: "t",
  connections: [],
  sources: [],
  workspace: { queries: [joinQuery], focus_query_id: "q_host", key_maps: [map] },
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
      positions: 10000,
      revenue: 10,
      samples: ["x"],
    },
  ],
  totalPositions: 10000,
});
assert(recorded.run.total_positions === 10000, "run positions");
assert(recorded.mapping_check_runs.length === 1, "one run");

const recorded2 = recordCheckRun({
  project: {
    ...project,
    mapping_check_runs: recorded.mapping_check_runs,
  },
  check,
  cells: [
    {
      sourceFamily: "A",
      targetFamily: "B",
      signal: "mismatch",
      positions: 2000,
      revenue: 10,
      samples: ["x"],
    },
  ],
  totalPositions: 10000,
});
assert(
  recorded2.deltaNote.includes("10000→2000") ||
    recorded2.deltaNote.includes("10000 → 2000") ||
    recorded2.deltaNote.includes("A→B"),
  `cell Δ in note: ${recorded2.deltaNote}`,
);

{
  const note = summarizeCellDeltas(
    [{ row: "A", column: "B", signal: "mismatch", positions: 10000 }],
    [{ row: "A", column: "B", signal: "mismatch", positions: 2000 }],
  );
  assert(note != null && note.includes("10000→2000"), `summarize ${note}`);
}

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
    expected_map_revision: keyMapRevision(map as never),
    expected_input_revisions: [],
    changes: [],
    previewed_at: "t",
  },
  ["x"],
  ["NEW"],
);
assert(frozen.changes.length === 1 && frozen.changes[0].to === "NEW", "stage");

{
  const confirmed = confirmFrozenCheckRemap({
    frozen,
    workspace: project.workspace,
    checks: [check],
  });
  assert(confirmed.ok === true, "confirm ok");
  if (confirmed.ok) {
    assert(
      confirmed.nextMap.entries.some((e) => e.from === "x" && e.to === "NEW"),
      "map updated",
    );
    assert(confirmed.dirtyDelta.upserts.length === 1, "dirty upserts");
    const applied = upsertKeyMapIntoProject(project, confirmed.nextMap as never);
    const apply = applied.workspace.queries[0]?.steps.find(
      (s) => s.type === "ApplyKeyMap",
    );
    assert(apply?.type === "ApplyKeyMap", "apply step");
    if (apply?.type === "ApplyKeyMap") {
      assert(
        (apply.payload.entries ?? []).some(
          (e) => e.from === "x" && e.to === "NEW",
        ),
        "ApplyKeyMap snapshot synced on confirm path",
      );
    }
  }
}

console.log("mappingChecks/service.test.ts: ok");
