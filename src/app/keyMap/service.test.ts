import {
  applyKeyMapOntoProject,
  dirtyDeltaHasChanges,
  mapForProjectAst,
  mergeFromValuesIntoMap,
  normalizeKeyMapForEditor,
  resolveJoinStepFromCtx,
  seedSaveResult,
  upsertKeyMapIntoProject,
} from "./service";
import type { KeyMapJoinCtx } from "./types";
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

console.log("keyMap/service.test.ts: ok");
