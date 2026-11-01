/**
 * Run: node via esbuild bundle, or npx tsx src/lib/joinMapEffect.test.ts
 */
import type { Workspace } from "../types/pipeline";
import {
  findIneffectiveMapEntries,
  keyLabelsFromSample,
  mapEntryFromLabel,
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

// --- not_applied: From still unmatched, no ApplyKeyMap ---
{
  const hit = findIneffectiveMapEntries(baseWs(), ctx, {
    leftUnmatchedKeys: new Set(["Cocacola", "Other"]),
  });
  assert(hit.length === 1, `expected 1 not_applied, got ${hit.length}`);
  assert(hit[0]!.reason === "not_applied", "reason not_applied");
  assert(hit[0]!.from === "Cocacola" && hit[0]!.to === "Danone", "pair");
}

// --- not_applied skipped when From not in unmatched ---
{
  const hit = findIneffectiveMapEntries(baseWs(), ctx, {
    leftUnmatchedKeys: new Set(["Other"]),
  });
  assert(hit.length === 0, "no overlap → empty");
}

// --- to_missing_on_right when Apply wired and To absent ---
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
  const hit = findIneffectiveMapEntries(ws, { ...ctx, joinStepIndex: 2 }, {
    rightKeys: new Set(["PEP", "KO"]), // Danone missing
  });
  assert(
    hit.some((e) => e.from === "Cocacola" && e.reason === "to_missing_on_right"),
    "Cocacola→Danone missing on right",
  );
  assert(
    !hit.some((e) => e.from === "Pepsi"),
    "Pepsi→PEP present on right → not listed",
  );
}

// --- To present → not listed ---
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
  const hit = findIneffectiveMapEntries(ws, { ...ctx, joinStepIndex: 2 }, {
    rightKeys: new Set(["Danone", "PEP"]),
  });
  assert(hit.length === 0, "all Tos present → empty");
}

// --- without rightKeys, wired map emits nothing ---
{
  const ws = baseWs();
  const host = ws.queries.find((q) => q.id === "dirty_join")!;
  host.steps.splice(1, 0, {
    type: "ApplyKeyMap",
    payload: { column: "company", map_id: "map_co", entries: [] },
  });
  const hit = findIneffectiveMapEntries(ws, { ...ctx, joinStepIndex: 2 }, {
    leftUnmatchedKeys: new Set(["Cocacola"]),
  });
  assert(hit.length === 0, "wired without rightKeys → skip");
}

// --- sample key labels ---
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
