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

const k1 = heavyPreviewCacheKey(wsMapped, "mapped");
const k2 = heavyPreviewCacheKey(wsMapped, "mapped");
assert.equal(k1, k2);

const cache = new HeavyPreviewCache();
const fake = { columns: ["c"], rows: [["1"]] };
cache.set(k1, fake as never);
assert.equal(cache.get(k1), fake as never);

console.log("previewTransport.test.ts: ok");
