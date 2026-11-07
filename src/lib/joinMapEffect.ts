/**
 * Join Lens helpers for mappings wired to the current Join via ApplyKeyMap.
 *
 * A KeyMap that merely exists in the project is not "mapped on this node" —
 * only ApplyKeyMap counts. Preview-bounded "To missing on right" / "no join
 * effect" conclusions are intentionally not derived here (samples are not a
 * full right-key universe).
 */
import type { Workspace } from "../types/pipeline";
import { findApplyKeyMapIdForJoin, primaryTo } from "./keyMap";

export type JoinMapEffectCtx = {
  hostQueryId: string;
  joinStepIndex: number;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
};

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
    const t = foldKey(primaryTo(e));
    if (f) from.add(f);
    if (t) to.add(t);
  }
  return { from, to, mapId };
}
