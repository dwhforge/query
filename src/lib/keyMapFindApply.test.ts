/**
 * Lightweight assertions for findApplyKeyMapIdForJoin (run: npx tsx src/lib/keyMapFindApply.test.ts).
 * Not wired into CI — guards the channel-vs-company KeyMap mix-up.
 */
import { findApplyKeyMapIdForJoin } from "./keyMap";
import type { Workspace } from "../types/pipeline";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const ws: Workspace = {
  focus_query_id: "fact",
  key_maps: [],
  queries: [
    {
      id: "fact",
      name: "fact",
      steps: [
        { type: "LoadCsv", payload: { path: "x.csv" } },
        {
          type: "ApplyKeyMap",
          payload: { column: "channel", map_id: "map_channel", entries: [] },
        },
        {
          type: "ApplyKeyMap",
          payload: { column: "company_raw", map_id: "map_company", entries: [] },
        },
        {
          type: "RenameColumn",
          payload: { from: "company_raw", to: "company" },
        },
        {
          type: "Join",
          payload: {
            right_query_id: "dim",
            join_type: "left",
            left_on: ["company"],
            right_on: ["company_id"],
          },
        },
      ],
    },
    {
      id: "dim",
      name: "dim",
      steps: [{ type: "LoadCsv", payload: { path: "d.csv" } }],
    },
  ],
};

const ctx = {
  hostQueryId: "fact",
  joinStepIndex: 4,
  rightQueryId: "dim",
  leftOn: ["company"],
  rightOn: ["company_id"],
};

// Prefer company map (via rename trail), never channel fallback.
assert(
  findApplyKeyMapIdForJoin(ws, ctx) === "map_company",
  `expected map_company, got ${findApplyKeyMapIdForJoin(ws, ctx)}`,
);

const noCompany: Workspace = {
  ...ws,
  queries: [
    {
      ...ws.queries[0]!,
      steps: [
        { type: "LoadCsv", payload: { path: "x.csv" } },
        {
          type: "ApplyKeyMap",
          payload: { column: "channel", map_id: "map_channel", entries: [] },
        },
        {
          type: "Join",
          payload: {
            right_query_id: "dim",
            join_type: "left",
            left_on: ["company"],
            right_on: ["company_id"],
          },
        },
      ],
    },
    ws.queries[1]!,
  ],
};
assert(
  findApplyKeyMapIdForJoin(noCompany, {
    ...ctx,
    joinStepIndex: 2,
  }) === null,
  "unrelated ApplyKeyMap must not be preferred",
);

console.log("keyMapFindApply.test.ts: ok");
