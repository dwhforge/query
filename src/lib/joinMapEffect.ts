/**
 * Join Lens: mappings wired to this Join via ApplyKeyMap that still do not
 * produce a join match (To missing on the right input).
 *
 * A KeyMap that merely exists in the project is not "mapped on this node" —
 * only ApplyKeyMap counts.
 */
import type { KeyMapDef, Workspace } from "../types/pipeline";
import { findApplyKeyMapIdForJoin } from "./keyMap";

export type IneffectiveMapReason = "to_missing_on_right";

export type IneffectiveMapEntry = {
  mapId: string;
  mapName: string;
  from: string;
  to: string;
  reason: IneffectiveMapReason;
};

export type JoinMapEffectCtx = {
  hostQueryId: string;
  joinStepIndex: number;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
};

const DEFAULT_LIMIT = 40;

function foldKey(s: string): string {
  return s.trim();
}

/** Display / lookup label for a map entry From (matches Join Lens key labels). */
export function mapEntryFromLabel(entry: {
  from?: string;
  from_parts?: string[];
}): string {
  const parts =
    entry.from_parts?.length
      ? entry.from_parts
      : entry.from?.trim()
        ? [entry.from]
        : [];
  if (parts.length > 1) return parts.map((p) => p.trim()).join(" · ");
  return foldKey(entry.from || parts[0] || "");
}

type NamedCols = { name: string; type?: string }[];

/**
 * Distinct join-key labels from a diag/preview sample.
 * Multi-column keys joined with " · ".
 */
export function keyLabelsFromSample(
  sample: { columns: NamedCols; rows: unknown[][] } | null | undefined,
  keyCols: string[],
): Set<string> {
  const out = new Set<string>();
  if (!sample || keyCols.length === 0) return out;
  const idxs = keyCols.map((k) =>
    sample.columns.findIndex(
      (c) => c.name.toLowerCase() === k.toLowerCase(),
    ),
  );
  if (idxs.some((i) => i < 0)) return out;
  for (const row of sample.rows) {
    const parts = idxs.map((i) => {
      const v = row[i!];
      if (v == null) return "";
      return String(v).trim();
    });
    if (parts.every((p) => !p)) continue;
    out.add(parts.length === 1 ? parts[0]! : parts.join(" · "));
  }
  return out;
}

export function keyLabelsFromRows(
  columns: NamedCols,
  rows: unknown[][],
  keyCols: string[],
): Set<string> {
  return keyLabelsFromSample({ columns, rows }, keyCols);
}

/** From/To labels from the ApplyKeyMap wired to this Join (if any). */
export function wiredMapKeyLabels(
  workspace: Workspace,
  ctx: JoinMapEffectCtx,
): { from: Set<string>; to: Set<string>; mapId: string | null } {
  const from = new Set<string>();
  const to = new Set<string>();
  const mapId = findApplyKeyMapIdForJoin(workspace, ctx);
  if (!mapId) return { from, to, mapId: null };
  const map = (workspace.key_maps ?? []).find((m) => m.id === mapId);
  if (!map) return { from, to, mapId };
  for (const e of map.entries) {
    const f = mapEntryFromLabel(e);
    const t = foldKey(e.to);
    if (f) from.add(f);
    if (t) to.add(t);
  }
  return { from, to, mapId };
}

function pushEntry(
  out: IneffectiveMapEntry[],
  map: KeyMapDef,
  from: string,
  to: string,
  reason: IneffectiveMapReason,
  limit: number,
  seen: Set<string>,
) {
  if (out.length >= limit) return;
  const f = foldKey(from);
  const t = foldKey(to);
  if (!f) return;
  const id = `${map.id}\0${f}\0${t}\0${reason}`;
  if (seen.has(id)) return;
  seen.add(id);
  out.push({
    mapId: map.id,
    mapName: map.name,
    from: f,
    to: t,
    reason,
  });
}

/**
 * Entries on the ApplyKeyMap wired to this Join whose To is not a right
 * join key — remap has no join effect. No ApplyKeyMap → empty (a project
 * KeyMap alone is not assigned to this node).
 */
export function findIneffectiveMapEntries(
  workspace: Workspace,
  ctx: JoinMapEffectCtx,
  opts?: {
    rightKeys?: Set<string> | null;
    limit?: number;
  },
): IneffectiveMapEntry[] {
  const maps = workspace.key_maps ?? [];
  if (maps.length === 0) return [];
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const out: IneffectiveMapEntry[] = [];
  const seen = new Set<string>();

  const wiredId = findApplyKeyMapIdForJoin(workspace, ctx);
  if (!wiredId) return out;

  const map = maps.find((m) => m.id === wiredId);
  const rightKeys = opts?.rightKeys;
  if (!map || !rightKeys) return out;

  for (const e of map.entries) {
    const from = mapEntryFromLabel(e);
    const to = foldKey(e.to);
    if (!to || rightKeys.has(to)) continue;
    pushEntry(out, map, from, to, "to_missing_on_right", limit, seen);
    if (out.length >= limit) break;
  }
  return out;
}
