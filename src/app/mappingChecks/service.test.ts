import {
  allowCheckDifference,
  confirmFrozenCheckRemap,
  createMappingCheck,
  dirtyDeltaFromFrozenRemap,
  findJoinHostsForMap,
  mergeRemapDirtyIntoTab,
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

// Apply after Join / wrong column must not count as a host (strict key-link).
{
  const afterJoin: QueryDef = {
    id: "q_late",
    name: "late",
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
      {
        type: "ApplyKeyMap",
        payload: {
          map_id: "map_actual",
          column: "sku",
          entries: [],
        },
      },
    ],
  };
  assert(
    findJoinHostsForMap([afterJoin], "map_actual").length === 0,
    "Apply after Join is not a host",
  );

  const wrongCol: QueryDef = {
    id: "q_ch",
    name: "ch",
    steps: [
      {
        type: "ApplyKeyMap",
        payload: {
          map_id: "map_actual",
          column: "channel",
          entries: [],
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
  assert(
    findJoinHostsForMap([wrongCol], "map_actual").length === 0,
    "Apply on non-Join key is not a host",
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

// Confirm dirtyDelta preserves attrs + baselines; merge keeps unrelated drafts.
{
  const richMap = {
    id: "map_rich",
    name: "Rich",
    editable_columns: ["note"],
    entries: [
      { from: "x", to: "OLD", attrs: { note: "keep" } },
      { from: "y", to: "Y1", attrs: { note: "other" } },
    ],
    storage: { kind: "seed" as const },
  };
  const richFrozen = stageFrozenRemapChanges(
    {
      check_id: check.id,
      map_id: richMap.id,
      expected_map_revision: keyMapRevision(richMap as never),
      expected_input_revisions: [],
      changes: [],
      previewed_at: "t",
    },
    ["x"],
    ["NEW"],
  );
  const delta = dirtyDeltaFromFrozenRemap(
    richMap as never,
    richFrozen.changes,
    {
      ...richMap,
      entries: [
        { from: "x", to: "NEW", attrs: { note: "keep" } },
        { from: "y", to: "Y1", attrs: { note: "other" } },
      ],
    } as never,
  );
  assert(delta.upserts.length === 1, "only remapped From upserted");
  assert(
    delta.upserts[0]!.to === "NEW" && delta.upserts[0]!.attrs?.note === "keep",
    "Confirm upsert keeps attrs",
  );
  assert(
    delta.baselines?.length === 1 &&
      delta.baselines[0]!.existed === true &&
      delta.baselines[0]!.to === "OLD" &&
      delta.baselines[0]!.attrs?.note === "keep",
    "Confirm baseline freezes prior To+attrs",
  );
  const merged = mergeRemapDirtyIntoTab(
    {
      upserts: [{ from: "y", to: "Y2", attrs: { note: "draft" } }],
      deletedFroms: [],
      baselines: [
        {
          fromParts: ["y"],
          existed: true,
          to: "Y1",
          attrs: { note: "other" },
        },
      ],
    },
    delta,
  );
  assert(
    merged.upserts.some((u) => u.from === "y" && u.to === "Y2") &&
      merged.upserts.some((u) => u.from === "x" && u.to === "NEW"),
    "merge keeps tab draft + remap",
  );
}

// Incomplete top-N CheckRun: store flags; do not invent cell Δ zeros.
{
  const incomplete = recordCheckRun({
    project,
    check,
    cells: [
      {
        sourceFamily: "A",
        targetFamily: "B",
        signal: "mismatch",
        positions: 100,
        revenue: 1,
        samples: ["x"],
      },
    ],
    totalPositions: 10000,
    cellsIncomplete: true,
    groupCount: 200,
    coveredPositions: 100,
    unmappedPositions: 2500,
  });
  assert(incomplete.run.cells_incomplete === true, "incomplete flag");
  assert(incomplete.run.group_count === 200, "group_count");
  assert(incomplete.run.unmapped_positions === 2500, "full unmapped");
  assert(
    incomplete.run.comparability.kind === "limited",
    "incomplete ⇒ limited comparability",
  );
  assert(
    incomplete.deltaNote.includes("top 1/200"),
    `trunc note: ${incomplete.deltaNote}`,
  );

  const nextIncomplete = recordCheckRun({
    project: {
      ...project,
      mapping_check_runs: incomplete.mapping_check_runs,
    },
    check,
    cells: [
      {
        sourceFamily: "Z",
        targetFamily: "Q",
        signal: "mismatch",
        positions: 50,
        revenue: 1,
        samples: ["z"],
      },
    ],
    totalPositions: 10000,
    cellsIncomplete: true,
    groupCount: 200,
    coveredPositions: 50,
    unmappedPositions: 2400,
  });
  assert(
    !nextIncomplete.deltaNote.includes("groups ") ||
      nextIncomplete.deltaNote.includes("top "),
    `no fake cell Δ across truncated runs: ${nextIncomplete.deltaNote}`,
  );
}

{
  // Intersection-only Δ: missing group on one side is not a zero.
  const note = summarizeCellDeltas(
    [
      { row: "A", column: "B", signal: "mismatch", positions: 10 },
      { row: "C", column: "D", signal: "mismatch", positions: 5 },
    ],
    [{ row: "A", column: "B", signal: "mismatch", positions: 7 }],
  );
  assert(
    note != null && note.includes("10→7") && !note.includes("C→D"),
    `intersection Δ only: ${note}`,
  );
}

console.log("mappingChecks/service.test.ts: ok");
