/** Commit the explicitly approved, paginated Matching run through the existing Mapping save owner.
 * The renderer never constructs SQL or writes a source table directly.
 * Source-backed writes use the same guarded dirty-delta path as KeyMapEditor.
 */
import type { KeyMapDef, KeyMapEntry } from "../../types/pipeline";
import type { DatasetMatchingPlan, DatasetApprovedMappingPage, KeyMapSaveResult,
  KeyMapDirtyDelta, KeyMapDirtyBaseline, KeyMapReadResult } from "../../lib/bridge";
import { emptyKeyMap, fromColumnsEff, fromPartsEff, outputColumnsEff, outputValuesEff } from "../../lib/keyMap";

export type SaveMatchingIntent = {
  runId: string;
  targetMapId: string | null;
  newMapName: string | null;
  plan: DatasetMatchingPlan;
};
export type SavedMatchingReceipt = {
  mapId: string; mapName: string; count: number; destination: string; message: string;
};
export type SaveMatchingPorts = {
  /** These must be the project and editor versions captured at the start of Save. */
  maps: readonly KeyMapDef[];
  current: () => boolean;
  editorBusy: (mapId: string) => boolean;
  approvedPage: (runId: string, page: number, size: number) => Promise<DatasetApprovedMappingPage>;
  /** Existing App-level Mapping Save/guard owner. */
  save: (map: KeyMapDef, opts?: { dirtyDelta?: KeyMapDirtyDelta }) => Promise<KeyMapSaveResult>;
  /** Existing connection resolver; must enforce source write permission. */
  writableSourceDsn: (map: KeyMapDef) => string;
  readSource: (map: KeyMapDef, dsn: string, opts: { fromExact: string[][] }) => Promise<KeyMapReadResult>;
  openSaved: (map: KeyMapDef) => void;
};

export function parseApprovedValues(value: string, expectedArity: number, label: string): string[] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new Error(`Invalid ${label}: not JSON`); }
  if (!Array.isArray(decoded) || decoded.length !== expectedArity || !decoded.every(v => typeof v === "string")) {
    throw new Error(`Invalid ${label}: Mapping requires ${expectedArity} non-NULL strings`);
  }
  return decoded as string[];
}

/** Read all approved pairs, never a visible page; refuse inconsistent exports. */
export async function loadApprovedPairs(intent: SaveMatchingIntent, ports: Pick<SaveMatchingPorts, "approvedPage">): Promise<Map<string, { from: string[]; to: string[] }>> {
  const keys = new Map<string, { from: string[]; to: string[] }>();
  let total: number | null = null;
  let received = 0;
  for (let page = 0; ; page++) {
    const result = await ports.approvedPage(intent.runId, page, 200);
    if (!Number.isSafeInteger(result.total) || result.total < 0 || (total !== null && total !== result.total)) {
      throw new Error("Approved Mapping export changed during pagination; re-evaluate and review again.");
    }
    total = result.total;
    if (!result.rows.length && received < total) throw new Error("Approved Mapping export returned an incomplete page.");
    received += result.rows.length;
    if (received > total) throw new Error("Approved Mapping export exceeded its declared total.");
    for (const row of result.rows) {
      const from = parseApprovedValues(row.mapKey, intent.plan.mapKeyFields.length, "LEFT Mapping key");
      const to = parseApprovedValues(row.outputs, intent.plan.outputs.length, "RIGHT output");
      const token = JSON.stringify(from);
      const old = keys.get(token);
      if (old && JSON.stringify(old.to) !== JSON.stringify(to)) {
        throw new Error(`Multiple confirmed outputs for one Mapping key ${token}`);
      }
      keys.set(token, { from, to });
    }
    if (received === total) break;
  }
  if (!keys.size) throw new Error("No reviewed and confirmed pairs to save. Confirm candidates first.");
  return keys;
}

function mapEntry(from: string[], to: string[], prior?: KeyMapEntry): KeyMapEntry {
  return { ...prior, from: from[0]!, from_parts: [...from], to: to[0]!, output_values: [...to] };
}
function checkNotReplacing(from: string[], prior: KeyMapEntry | undefined, to: string[]): boolean {
  if (!prior) return false;
  const existing = outputValuesEff(prior);
  if (JSON.stringify(existing) === JSON.stringify(to)) return true;
  if (existing.some(value => value.trim() !== "")) {
    throw new Error(`Refused to overwrite a populated Mapping value for ${JSON.stringify(from)}; edit it explicitly in the Mapping editor.`);
  }
  return false;
}

function ensureShape(map: KeyMapDef, intent: SaveMatchingIntent) {
  if (map.time_mode === "range_scd" || !["seed", "source"].includes(map.storage?.kind ?? "seed")) {
    throw new Error("Only seed and writable source Mapping can be committed here; use the dedicated editor for ref/query/range-SCD.");
  }
  if (fromColumnsEff(map).length !== intent.plan.mapKeyFields.length ||
      outputColumnsEff(map).length !== intent.plan.outputs.length) {
    throw new Error("Mapping key/output arity differs from the evaluated Matching plan.");
  }
}

function buildSeedDraft(map: KeyMapDef, pairs: Map<string, { from: string[]; to: string[] }>): KeyMapDef {
  const rows = [...map.entries];
  const byKey = new Map(rows.map((entry, index) => [JSON.stringify(fromPartsEff(entry)), index]));
  for (const [token, pair] of pairs) {
    const index = byKey.get(token);
    const old = index === undefined ? undefined : rows[index];
    if (checkNotReplacing(pair.from, old, pair.to)) continue;
    if (index === undefined) { byKey.set(token, rows.length); rows.push(mapEntry(pair.from, pair.to)); }
    else rows[index] = mapEntry(pair.from, pair.to, old);
  }
  return { ...map, entries: rows };
}

async function buildSourceDelta(map: KeyMapDef, pairs: Map<string, { from: string[]; to: string[] }>, dsn: string,
  readSource: SaveMatchingPorts["readSource"]): Promise<KeyMapDirtyDelta> {
  const known = new Map<string, KeyMapEntry>();
  const keys = [...pairs.values()].map(pair => pair.from);
  for (let i = 0; i < keys.length; i += 200) {
    const result = await readSource(map, dsn, { fromExact: keys.slice(i, i + 200) });
    for (const row of result.entries) {
      const token = JSON.stringify(fromPartsEff(row));
      if (!pairs.has(token)) throw new Error("Source read returned an unexpected Mapping key.");
      if (known.has(token)) throw new Error(`Duplicate rows in source Mapping table for ${token}`);
      known.set(token, row);
    }
  }
  const upserts: KeyMapEntry[] = [];
  const baselines: KeyMapDirtyBaseline[] = [];
  const names = outputColumnsEff(map);
  for (const [token, pair] of pairs) {
    const before = known.get(token);
    if (checkNotReplacing(pair.from, before, pair.to)) continue;
    const values = before ? outputValuesEff(before) : [];
    upserts.push(mapEntry(pair.from, pair.to, before));
    baselines.push({
      fromParts: [...pair.from], existed: !!before, to: values[0] ?? "",
      outputs: Object.fromEntries(names.map((name, i) => [name, values[i] ?? ""])),
      ...(before?.attrs ? { attrs: Object.fromEntries(Object.entries(before.attrs).map(([k,v]) => [k,v])) } : {}),
    });
  }
  return { upserts, deletedFroms: [], deletedFromParts: [], baselines };
}

export async function saveDatasetMatching(intent: SaveMatchingIntent, ports: SaveMatchingPorts): Promise<SavedMatchingReceipt> {
  if (!ports.current()) throw new Error("Project/Matching context changed; reopen Matching before saving.");
  let map: KeyMapDef;
  if (intent.targetMapId) {
    const found = ports.maps.find(row => row.id === intent.targetMapId);
    if (!found) throw new Error("Target Mapping no longer exists.");
    map = found;
  } else {
    const name = intent.newMapName?.trim();
    if (!name) throw new Error("Provide a name for the new Mapping.");
    if (ports.maps.some(row => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error("A Mapping with this name already exists. Select it or choose a different name.");
    }
    map = { ...emptyKeyMap(name),
      from_column: intent.plan.mapKeyFields[0]!, from_columns: [...intent.plan.mapKeyFields],
      to_column: intent.plan.outputs[0]!, output_columns: [...intent.plan.outputs] };
  }
  ensureShape(map, intent);
  if (ports.editorBusy(map.id)) throw new Error("This Mapping has unsaved or in-flight editor changes. Save/discard those first.");
  const pairs = await loadApprovedPairs(intent, ports);
  if (!ports.current()) throw new Error("Project changed during Mapping approval read; no write performed.");

  if ((map.storage?.kind ?? "seed") === "seed") {
    const draft = buildSeedDraft(map, pairs);
    if (!ports.current()) throw new Error("Project changed during Mapping Save; no write performed.");
    const result = await ports.save(draft);
    ports.openSaved(draft);
    if (result.external === "error" || result.external === "conflict") {
      throw new Error(`Mapping saved in project, but external seed sync failed: ${result.message}`);
    }
    return { mapId: draft.id, mapName: draft.name, count: pairs.size,
      destination: result.external === "synced" ? "project + dbt seed" : "project (seed)",
      message: `${pairs.size} confirmed Mapping keys saved to '${draft.name}'. ${result.message} Save the project file separately.` };
  }

  const dsn = ports.writableSourceDsn(map);
  const delta = await buildSourceDelta(map, pairs, dsn, ports.readSource);
  if (!ports.current()) throw new Error("Project changed during source Mapping verification; no write performed.");
  if (delta.upserts.length === 0) {
    ports.openSaved(map);
    return { mapId: map.id, mapName: map.name, count: pairs.size, destination: "source table (already current)",
      message: `All ${pairs.size} confirmed keys already have the same values in '${map.name}'; no table changes were necessary.` };
  }
  // Existing App save owner invokes writeKeyMap with contentHash and per-row baselines.
  const result = await ports.save(map, { dirtyDelta: delta });
  if (result.external !== "synced") {
    throw new Error(`Source Mapping write was not confirmed: ${result.message} (status ${result.external}).`);
  }
  ports.openSaved(map);
  return { mapId: map.id, mapName: map.name, count: pairs.size, destination: "source table",
    message: `Saved ${delta.upserts.length} changed keys (${pairs.size} confirmed) directly to the source table of '${map.name}'. ${result.message}` };
}
