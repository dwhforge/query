import assert from "node:assert/strict";
import type { KeyMapDef, KeyMapEntry } from "../../types/pipeline";
import { loadApprovedPairs, saveDatasetMatching, type SaveMatchingIntent,
  type SaveMatchingPorts } from "./saveDatasetMapping";

const plan: SaveMatchingIntent["plan"] = {
  sourceRef: "sales", targetRef: "product", mapKeyFields: ["sku"],
  targetIdentityFields: ["id"], outputs: ["erp_id"],
  comparisons: [{ sourceField: "name", targetField: "name", role: "soft_signal" }],
  normalization: ["trim", "casefold"], ambiguity: "leave_for_manual", scope: "full",
  semanticRevision: 1, uiRevision: 0,
};
const intent = (mapId: string | null): SaveMatchingIntent => ({
  runId: "r55", targetMapId: mapId, newMapName: mapId ? null : "Product relationships", plan,
});
const seed = (): KeyMapDef => ({ id: "m1", name: "Products", entries: [],
  storage: { kind: "seed" }, from_column: "sku", from_columns: ["sku"],
  to_column: "erp_id", output_columns: ["erp_id"] });
const source = (): KeyMapDef => ({ ...seed(), id: "m_source", storage: { kind: "source", source: "warehouse", table: "product_map" } });
const pages = [
  { rows: [{ mapKey: '["A"]', outputs: '["R1"]', targetIdentity: '["R1"]' }], page: 0, pageSize: 200, total: 2 },
  { rows: [{ mapKey: '["B"]', outputs: '["R2"]', targetIdentity: '["R2"]' }], page: 1, pageSize: 200, total: 2 },
];
function harness(map: KeyMapDef) {
  const calls: { map: KeyMapDef; delta?: unknown }[] = [];
  const opened: KeyMapDef[] = [];
  let rows: KeyMapEntry[] = [];
  const ports: SaveMatchingPorts = {
    maps: [map], current: () => true, editorBusy: () => false,
    approvedPage: async (_id, page) => pages[page] ?? { rows: [], page, pageSize: 200, total: 2 },
    save: async (next, options) => { calls.push({map:next, delta:options?.dirtyDelta});
      return { local:"saved", external: next.storage?.kind === "source" ? "synced" : "none", message:"Saved" }; },
    writableSourceDsn: () => "postgres://mock",
    readSource: async () => ({ entries: rows, content_hash: "hash" }),
    openSaved: map => { opened.push(map); },
  };
  return { ports, calls, opened, setRows: (next: KeyMapEntry[]) => { rows = next; } };
}

async function tests() {
  const h = harness(seed());
  const receipt = await saveDatasetMatching(intent("m1"), h.ports);
  assert.equal(receipt.count, 2);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.map.entries.map(row => row.output_values), [["R1"], ["R2"]]);
  assert.equal(h.opened.length, 1);

  // The old renderer delta path is intentionally refused for Source Mapping.
  // Streaming Host publication never accumulates all confirmed keys in React.
  const sourceMap = harness(source());
  await assert.rejects(saveDatasetMatching(intent("m_source"), sourceMap.ports), /Host-side bounded publisher/);
  assert.equal(sourceMap.calls.length, 0);

  const hugeSeed = harness(seed());
  hugeSeed.ports.approvedPage = async () => ({ rows: [], page: 0, pageSize: 200, total: 10_001 });
  await assert.rejects(saveDatasetMatching(intent("m1"), hugeSeed.ports), /at most 10000 approved keys/);
  assert.equal(hugeSeed.calls.length, 0);

  const malformed = harness(seed());
  malformed.ports.approvedPage = async (_id, page) => page === 0
    ? {rows:[{mapKey:'["A"]',outputs:'["R1"]',targetIdentity:'["R1"]'}],page:0,pageSize:200,total:2}
    : {rows:[],page,pageSize:200,total:2};
  await assert.rejects(saveDatasetMatching(intent("m1"), malformed.ports), /incomplete page/i);
  assert.equal(malformed.calls.length, 0);

  const duplicate = harness(seed());
  duplicate.ports.approvedPage = async () => ({rows:[
    {mapKey:'["A"]', outputs:'["R1"]', targetIdentity:'["R1"]'},
    {mapKey:'["A"]', outputs:'["R2"]', targetIdentity:'["R2"]'},
  ], page:0, pageSize:200, total:2});
  await assert.rejects(loadApprovedPairs(intent("m1"), duplicate.ports), /Multiple confirmed outputs/);

  const created = harness(seed());
  const made = await saveDatasetMatching(intent(null), created.ports);
  assert.equal(made.mapName, "Product relationships");
  assert.deepEqual(created.calls[0]!.map.from_columns, ["sku"]);
  assert.deepEqual(created.calls[0]!.map.output_columns, ["erp_id"]);
  console.log("Dataset Matching Save: seed/new, Source renderer refusal, seed memory cap, pagination and duplicate output passed");
}
void tests();
