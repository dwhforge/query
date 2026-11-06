import assert from "node:assert/strict";
import {
  HeavyPreviewCache,
  heavyPreviewCacheKey,
  isHeavyPreviewFocus,
  keyMapIdsNeededForFocus,
  previewTransportEntryCount,
  workspaceForPreviewTransport,
} from "./previewTransport";
import type { KeyMapDef, Workspace } from "../types/pipeline";

function bigMap(n: number): KeyMapDef {
  return {
    id: "km_big",
    name: "big",
    from_column: "from",
    to_column: "to",
    entries: Array.from({ length: n }, (_, i) => ({
      from: `s${i}`,
      to: `t${i}`,
    })),
  };
}

const wsLight: Workspace = {
  focus_query_id: "csv_a",
  queries: [
    {
      id: "csv_a",
      name: "a",
      steps: [{ type: "LoadCsv", payload: { path: "a.csv" } }],
    },
    {
      id: "mapped",
      name: "mapped",
      steps: [
        { type: "FromQuery", payload: { query_id: "csv_a" } },
        {
          type: "ApplyKeyMap",
          payload: { map_id: "km_big", column: "sku", output_column: "out" },
        },
      ],
    },
  ],
  key_maps: [bigMap(8_000)],
};

assert.equal(
  previewTransportEntryCount(wsLight),
  0,
  "CSV focus must not ship unused map rows",
);

const wsMapped: Workspace = { ...wsLight, focus_query_id: "mapped" };
assert.equal(
  previewTransportEntryCount(wsMapped),
  8_000,
  "ApplyKeyMap focus keeps full map (no permanent cut)",
);
assert.equal(isHeavyPreviewFocus(wsMapped, "mapped"), true);
assert.equal(isHeavyPreviewFocus(wsLight, "csv_a"), false);

const slim = workspaceForPreviewTransport(wsLight);
assert.equal(slim.key_maps![0]!.entries.length, 0);
assert.ok(keyMapIdsNeededForFocus(wsMapped, "mapped").has("km_big"));

function mapWith(
  id: string,
  n: number,
  storage?: KeyMapDef["storage"],
): KeyMapDef {
  return {
    id,
    name: id,
    entries: Array.from({ length: n }, (_, i) => ({
      from: `${id}-${i}`,
      to: `t${i}`,
    })),
    storage,
  };
}

const wsNested: Workspace = {
  focus_query_id: "fact",
  queries: [
    {
      id: "q_dictionary",
      name: "dictionary",
      steps: [
        { type: "LoadCsv", payload: { path: "dict.csv" } },
        {
          type: "ApplyKeyMap",
          payload: { map_id: "seed_map", column: "sku", output_column: "canon" },
        },
      ],
    },
    {
      id: "fact",
      name: "fact",
      steps: [
        { type: "LoadCsv", payload: { path: "fact.csv" } },
        {
          type: "ApplyKeyMap",
          payload: {
            map_id: "outer_map",
            column: "sku",
            output_column: "product_id",
          },
        },
      ],
    },
  ],
  key_maps: [
    mapWith("outer_map", 2, { kind: "query", query_id: "q_dictionary" }),
    mapWith("seed_map", 4),
    mapWith("unused_map", 9),
  ],
};

const nestedNeeded = keyMapIdsNeededForFocus(wsNested, "fact");
assert.ok(nestedNeeded.has("outer_map"));
assert.ok(nestedNeeded.has("seed_map"), "query-backed map must pull its query's seed map");
assert.equal(nestedNeeded.has("unused_map"), false);

const nestedSlim = workspaceForPreviewTransport(wsNested);
const nestedById = new Map(nestedSlim.key_maps!.map((m) => [m.id, m.entries.length]));
assert.equal(nestedById.get("seed_map"), 4, "seed rows stay for the nested dictionary");
assert.equal(nestedById.get("outer_map"), 2);
assert.equal(nestedById.get("unused_map"), 0);

const wsSql: Workspace = {
  focus_query_id: "consumer",
  queries: [
    {
      id: "lookup-v2",
      name: "lookup",
      steps: [
        { type: "LoadCsv", payload: { path: "lookup.csv" } },
        {
          type: "ApplyKeyMap",
          payload: { map_id: "seed_map", column: "sku", output_column: "canon" },
        },
      ],
    },
    {
      id: "consumer",
      name: "consumer",
      steps: [
        {
          type: "CustomSql",
          payload: { raw_sql: "select * from {{query:lookup-v2}}" },
        },
      ],
    },
  ],
  key_maps: [mapWith("seed_map", 3), mapWith("unused_map", 5)],
};

assert.ok(
  keyMapIdsNeededForFocus(wsSql, "consumer").has("seed_map"),
  "hyphenated {{query:lookup-v2}} is a real dependency",
);
const sqlSlim = workspaceForPreviewTransport(wsSql);
assert.equal(sqlSlim.key_maps!.find((m) => m.id === "seed_map")!.entries.length, 3);
assert.equal(sqlSlim.key_maps!.find((m) => m.id === "unused_map")!.entries.length, 0);

const k1 = heavyPreviewCacheKey(wsMapped, "mapped");
const k2 = heavyPreviewCacheKey(wsMapped, "mapped");
assert.equal(k1, k2);

const cache = new HeavyPreviewCache();
const fake = { columns: ["c"], rows: [["1"]] };
cache.set(k1, fake as never);
assert.equal(cache.get(k1), fake as never);

console.log("previewTransport.test.ts: ok");
