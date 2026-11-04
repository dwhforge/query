import {
  applyKeyMapOntoProject,
  applyKeyMapTabMapChange,
  dirtyDeltaHasChanges,
  mapForProjectAst,
  mergeFromValuesIntoMap,
  mergeKeyMapTabSession,
  normalizeKeyMapForEditor,
  resolveJoinStepFromCtx,
  seedSaveResult,
  upsertKeyMapIntoProject,
} from "./service";
import type { KeyMapJoinCtx, KeyMapTabSession } from "./types";
import type { Project } from "../../types/pipeline";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const joinCtx: KeyMapJoinCtx = {
  hostQueryId: "q_host",
  joinStepIndex: 0,
  rightQueryId: "q_right",
  leftOn: ["sku"],
  rightOn: ["id"],
  joinType: "left",
};

const map = {
  id: "map_1",
  name: "M",
  entries: [{ from: "a", to: "1" }],
  storage: { kind: "seed" as const },
};

const project = {
  id: "p",
  name: "t",
  connections: [],
  sources: [],
  workspace: {
    queries: [
      {
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
      },
      { id: "q_right", name: "right", steps: [] },
    ],
    focus_query_id: "q_host",
    key_maps: [map],
  },
  dbt_target: "v1",
} as Project;

assert(resolveJoinStepFromCtx(project.workspace, joinCtx) === 0, "join idx");

const applied = applyKeyMapOntoProject(project, {
  map: map as never,
  ctx: joinCtx,
  side: "left",
  leftCols: ["sku"],
  rightCols: ["id"],
  outputColumnLeft: "sku_mapped",
  outputColumnRight: "id",
});
assert(applied.result.status === "ok", "apply ok");

const sourceMap = {
  ...map,
  storage: { kind: "source" as const, connection_id: "c", schema: "s", table: "t" },
  entries: [{ from: "x", to: "y" }],
};
assert(mapForProjectAst(sourceMap as never).entries.length === 0, "strip source");

const norm = normalizeKeyMapForEditor({
  id: "m",
  name: "n",
  entries: [],
} as never);
assert(norm.from_column === "from" && norm.to_column === "to", "defaults");

const merged = mergeFromValuesIntoMap({
  map: map as never,
  fromValues: ["b"],
  toValues: ["2"],
  joinCtx,
});
assert(merged.entries.some((e) => e.from === "b" && e.to === "2"), "merge from");

const renamed = { ...map, name: "Renamed" };
const up = upsertKeyMapIntoProject(project, renamed as never);
assert(
  up.workspace.key_maps?.find((m) => m.id === "map_1")?.name === "Renamed",
  "upsert",
);

assert(!dirtyDeltaHasChanges(null), "empty delta");
assert(
  dirtyDeltaHasChanges({ upserts: [{ from: "a", to: "1" }], deletedFroms: [] }),
  "has upsert",
);

assert(seedSaveResult({ exportPath: null }).external === "skipped", "no export");
assert(seedSaveResult({ exportPath: "/x" }).external === "synced", "synced");

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      from_columns: ["sys", "code"],
      entries: [
        { from: "ERP", from_parts: ["ERP", "100"], to: "A" },
        { from: "ERP", from_parts: ["ERP", "200"], to: "B" },
      ],
    },
    contentHash: "hash-1",
    dirtyDelta: { upserts: [], deletedFroms: [] },
    saveInFlight: true,
    dirtyResetSeq: 3,
    totalCount: 9,
    saveApi: {
      captureSave: () => null,
      confirmSave: () => {},
      abortSave: () => {},
      isSaving: () => false,
    },
  };
  const incoming = {
    id: "m",
    name: "M",
    from_columns: ["sys", "code"],
    entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "A2" }],
  };
  const merged = mergeKeyMapTabSession(prev, incoming as never);
  assert(merged.map.entries.length === 2, "composite rows not collapsed");
  assert(
    merged.map.entries.some(
      (e) => e.from_parts?.[1] === "100" && e.to === "A2",
    ),
    "updated tuple",
  );
  assert(
    merged.map.entries.some((e) => e.from_parts?.[1] === "200" && e.to === "B"),
    "sibling tuple kept",
  );
  assert(merged.contentHash === "hash-1", "lifecycle contentHash");
  assert(merged.saveInFlight === true, "lifecycle saveInFlight");
  assert(merged.dirtyResetSeq === 3, "lifecycle dirtyResetSeq");
  assert(merged.totalCount === 9, "lifecycle totalCount");
  assert(merged.saveApi != null, "lifecycle saveApi");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "A", to: "1", attrs: { reason: "old" } }],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "A", to: "1", attrs: { reason: "new" } }],
  } as never);
  assert(
    merged.map.entries[0]?.attrs?.reason === "new",
    "attrs-only update when not dirty",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "A", to: "1", attrs: { reason: "local" } }],
    },
    dirtyDelta: {
      upserts: [{ from: "A", to: "1", attrs: { reason: "local" } }],
      deletedFroms: [],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "A", to: "1", attrs: { reason: "remote" } }],
  } as never);
  assert(
    merged.map.entries[0]?.attrs?.reason === "local",
    "dirty draft attrs win",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      time_mode: "range_scd",
      entries: [
        {
          from: "A",
          to: "1",
          attrs: { valid_from: "2026-01-01", valid_to: "" },
        },
      ],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    time_mode: "range_scd",
    entries: [
      {
        from: "A",
        to: "1",
        attrs: { valid_from: "2026-01-01", valid_to: "2026-06-01" },
      },
    ],
  } as never);
  assert(merged.map.entries.length === 1, "SCD bound update is one row");
  assert(
    merged.map.entries[0]?.attrs?.valid_to === "2026-06-01",
    "SCD valid_to updated",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: {
        kind: "source",
        source: "public",
        table: "a",
        connection_id: "c1",
      },
      entries: [
        { from: "A_ONLY", to: "1" },
        { from: "SHARED", to: "old" },
      ],
    },
    contentHash: "hash-A",
    dirtyDelta: { upserts: [{ from: "A_ONLY", to: "1" }], deletedFroms: [] },
    saveApi: {
      captureSave: () => null,
      confirmSave: () => {},
      abortSave: () => {},
      isSaving: () => false,
    },
  };
  const rebound = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: {
      kind: "source",
      source: "public",
      table: "b",
      connection_id: "c1",
    },
    entries: [
      { from: "B_ONLY", to: "9" },
      { from: "SHARED", to: "new" },
    ],
  } as never);
  assert(rebound.contentHash === undefined, "rebind clears hash");
  assert(rebound.dirtyDelta === null, "rebind clears dirty");
  assert(rebound.saveApi === undefined, "rebind invalidates saveApi");
  assert(
    !rebound.map.entries.some((e) => e.from === "A_ONLY"),
    "source A rows must not follow binding B",
  );
  assert(
    rebound.map.entries.some((e) => e.from === "B_ONLY" && e.to === "9"),
    "source B rows present",
  );
  assert(rebound.map.entries.length === 2, "only B relation rows");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "1" }],
    },
    saveInFlight: true,
  };
  const refused = applyKeyMapTabMapChange(prev, {
    id: "m",
    name: "M",
    storage: {
      kind: "source",
      source: "public",
      table: "t",
      connection_id: "c1",
    },
    entries: [],
  } as never);
  assert(!refused.ok, "refuse rebind while save in flight");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "gone", to: "1" }],
    },
    dirtyDelta: {
      upserts: [],
      deletedFroms: ["gone"],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "gone", to: "1" }],
  } as never);
  assert(
    !merged.map.entries.some((e) => e.from === "gone"),
    "deletedFroms not resurrected",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      from_columns: ["sys", "code"],
      entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "1" }],
    },
    dirtyDelta: {
      upserts: [],
      deletedFroms: [],
      deletedFromParts: [["ERP", "100"]],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    from_columns: ["sys", "code"],
    entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "1" }],
  } as never);
  assert(merged.map.entries.length === 0, "deletedFromParts not resurrected");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "local", attrs: { reason: "draft" } }],
    },
    dirtyDelta: {
      upserts: [{ from: "A", to: "local", attrs: { reason: "draft" } }],
      deletedFroms: [],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: { kind: "seed" },
    entries: [{ from: "A", to: "remote", attrs: { reason: "file" } }],
  } as never);
  assert(
    merged.map.entries[0]?.to === "local" &&
      merged.map.entries[0]?.attrs?.reason === "draft",
    "seed dirty draft survives refresh",
  );
}

console.log("keyMap/service.test.ts: ok");
