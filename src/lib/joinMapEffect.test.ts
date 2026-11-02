/**
 * Run: esbuild bundle + node, or npx tsx src/lib/joinMapEffect.test.ts
 */
import type { Workspace } from "../types/pipeline";
import {
  keyLabelsFromSample,
  mapEntryFromLabel,
  wiredMapKeyLabels,
} from "./joinMapEffect";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const ctx = {
  hostQueryId: "dirty_join",
  joinStepIndex: 1,
  rightQueryId: "dim_company",
  leftOn: ["company"],
  rightOn: ["company_id"],
};

function baseWs(over: Partial<Workspace> = {}): Workspace {
  return {
    focus_query_id: "dirty_join",
    queries: [
      {
        id: "sales_daily",
        name: "sales",
        steps: [{ type: "LoadCsv", payload: { path: "/tmp/sales.csv" } }],
      },
      {
        id: "dim_company",
        name: "dim",
        steps: [{ type: "LoadCsv", payload: { path: "/tmp/dim.csv" } }],
      },
      {
        id: "dirty_join",
        name: "dirty_join",
        steps: [
          { type: "FromQuery", payload: { query_id: "sales_daily" } },
          {
            type: "Join",
            payload: {
              right_query_id: "dim_company",
              join_type: "left",
              left_on: ["company"],
              right_on: ["company_id"],
            },
          },
        ],
      },
    ],
    key_maps: [
      {
        id: "map_co",
        name: "Companies",
        entries: [
          { from: "Cocacola", to: "Danone" },
          { from: "Pepsi", to: "PEP" },
        ],
        storage: { kind: "seed" },
        from_column: "from",
        to_column: "to",
      },
    ],
    ...over,
  };
}

// --- no ApplyKeyMap on Join → not "mapped" for this node ---
{
  const wired = wiredMapKeyLabels(baseWs(), ctx);
  assert(wired.mapId === null, "no wired map");
  assert(wired.from.size === 0, "do not hide Froms from unwired maps");
}

// --- Apply wired → expose From/To labels ---
{
  const ws = baseWs();
  const host = ws.queries.find((q) => q.id === "dirty_join")!;
  host.steps = [
    { type: "FromQuery", payload: { query_id: "sales_daily" } },
    {
      type: "ApplyKeyMap",
      payload: { column: "company", map_id: "map_co", entries: [] },
    },
    {
      type: "Join",
      payload: {
        right_query_id: "dim_company",
        join_type: "left",
        left_on: ["company"],
        right_on: ["company_id"],
      },
    },
  ];
  const joinCtx = { ...ctx, joinStepIndex: 2 };
  const wired = wiredMapKeyLabels(ws, joinCtx);
  assert(wired.mapId === "map_co", "wired map_co");
  assert(wired.from.has("Cocacola") && wired.to.has("PEP"), "hide labels");
}

// --- helpers ---
{
  const keys = keyLabelsFromSample(
    {
      columns: [
        { name: "company", type: "VARCHAR" },
        { name: "x", type: "INT" },
      ],
      rows: [
        ["Cocacola", 1],
        ["  Pepsi ", 2],
      ],
    },
    ["company"],
  );
  assert(keys.has("Cocacola") && keys.has("Pepsi"), "sample labels");
  assert(
    mapEntryFromLabel({ from: "A", from_parts: ["A", "B"] }) === "A · B",
    "composite label",
  );
}

console.log("joinMapEffect.test.ts: ok");
