import {
  queryMapPreviewSql,
  validateQueryMapBinding,
  validateQueryMapRows,
} from "./keyMapQuery";
import type { KeyMapDef, Workspace } from "../types/pipeline";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const map = {
    id: "m1",
    name: "M",
    entries: [],
    storage: { kind: "query", query_id: "q_map" },
    from_columns: ["a", "d"],
    to_column: "b",
  } as KeyMapDef;
  const ws = {
    focus_query_id: "q_map",
    queries: [
      {
        id: "q_map",
        name: "map",
        steps: [{ type: "LoadCsv", payload: { path: "x.csv" } }],
      },
    ],
    key_maps: [],
  } as Workspace;
  assert(
    validateQueryMapBinding(map, ws, ["a", "d", "b"]).ok,
    "binding ok",
  );
  assert(
    !validateQueryMapBinding(map, ws, ["a", "b"]).ok,
    "missing d",
  );
  assert(
    !validateQueryMapBinding(
      { ...map, to_column: "a" },
      ws,
      ["a", "d"],
    ).ok,
    "to∩from",
  );
}

{
  assert(validateQueryMapRows("m", 1, [["x", "y"]]).ok, "ok row");
  assert(!validateQueryMapRows("m", 1, [[null, "y"]]).ok, "null from");
  assert(
    !validateQueryMapRows("m", 1, [
      ["x", "y"],
      ["x", "z"],
    ]).ok,
    "dupe",
  );
}

{
  const sql = queryMapPreviewSql("q1", ["a", "b"], "c", 50);
  assert(sql.includes("{{query:q1}}"), "placeholder");
  assert(sql.includes("LIMIT 50"), "limit");
}

console.log("keyMapQuery.test.ts: ok");
