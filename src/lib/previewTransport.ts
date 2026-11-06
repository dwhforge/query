/**
 * Preview IPC hygiene ([ADR-0033](../../docs/adr/0033-mapping-data-plane.md)):
 * - Strip unused seed KeyMap rows on transport (lab has 95k — not every CSV click).
 * - Heavy ApplyKeyMap focuses: cache result + postload once; do not re-ship the
 *   dictionary on every graph click (avoids SUPER traffic while keeping full data).
 */
import { directUpstreamQueryIds } from "../app/mappingCreate/service";
import type {
  KeyMapDef,
  PreviewResult,
  QueryDef,
  Workspace,
} from "../types/pipeline";
import { targetKey } from "../types/pipeline";

/**
 * Maps Applied anywhere in the focus closure.
 * Query-backed maps pull their `storage.query_id` (and that query's maps).
 * SQL `{{query:id}}` uses the same placeholder grammar as the rest of the app
 * (hyphens allowed). Seed rows are stripped only for maps outside this set.
 */
export function keyMapIdsNeededForFocus(
  workspace: Workspace,
  focusId: string | null | undefined,
): Set<string> {
  const needed = new Set<string>();
  if (!focusId) return needed;
  const byId = new Map(workspace.queries.map((q) => [q.id, q]));
  const maps = workspace.key_maps ?? [];
  const visiting = new Set<string>();

  const walk = (id: string) => {
    if (visiting.has(id) || id.startsWith("xref:")) return;
    const q = byId.get(id);
    if (!q) return;
    visiting.add(id);
    for (const step of q.steps) {
      if (step.type !== "ApplyKeyMap") continue;
      const mid = targetKey(step.payload.map_id);
      if (mid) needed.add(mid);
    }
    for (const dep of directUpstreamQueryIds(q, maps)) {
      walk(dep);
    }
  };

  walk(focusId);
  return needed;
}

function stripUnusedMapEntries(
  maps: KeyMapDef[],
  needed: Set<string>,
): KeyMapDef[] {
  return maps.map((m) => {
    if (needed.has(m.id) || m.entries.length === 0) return m;
    // Keep metadata; preview of LoadCsv / unrelated queries must not ship rows.
    return { ...m, entries: [] };
  });
}

/**
 * Clone workspace for host preview/describe: drop seed rows not required by focus.
 * ApplyKeyMap that needs a map still receives full entries for that map id.
 */
export function workspaceForPreviewTransport(workspace: Workspace): Workspace {
  const maps = workspace.key_maps ?? [];
  if (maps.every((m) => m.entries.length === 0)) return workspace;
  const needed = keyMapIdsNeededForFocus(workspace, workspace.focus_query_id);
  const nextMaps = stripUnusedMapEntries(maps, needed);
  if (nextMaps.every((m, i) => m === maps[i])) return workspace;
  return { ...workspace, key_maps: nextMaps };
}

const HEAVY_ENTRY_FLOOR = 5_000;

/** True when this focus pulls a large seed map (or known lab projection nodes). */
export function isHeavyPreviewFocus(
  workspace: Workspace,
  focusId: string | null | undefined,
): boolean {
  if (!focusId) return false;
  if (
    focusId === "quality_joined" ||
    focusId === "quality_summary" ||
    focusId === "quality_targets"
  ) {
    return true;
  }
  const needed = keyMapIdsNeededForFocus(workspace, focusId);
  if (needed.size === 0) return false;
  const maps = workspace.key_maps ?? [];
  for (const id of needed) {
    const m = maps.find((x) => x.id === id);
    if (m && m.entries.length >= HEAVY_ENTRY_FLOOR) return true;
  }
  return false;
}

/** @deprecated use {@link isHeavyPreviewFocus} — kept for call-site clarity during migrate */
export const shouldSkipHeavyAutoPreview = isHeavyPreviewFocus;

/** Cheap fingerprint — never sort 95k rows. */
function mapLiteFingerprint(map: KeyMapDef): string {
  const n = map.entries.length;
  if (n === 0) return `${map.id}:0`;
  const label = (e: KeyMapDef["entries"][0] | undefined) =>
    e
      ? `${(e.from_parts?.length ? e.from_parts.join("\0") : e.from).trim()}→${e.to}`
      : "";
  if (n <= 8) {
    return `${map.id}:${n}:${map.entries.map((e) => label(e)).join("|")}`;
  }
  const mid = map.entries[Math.floor(n / 2)];
  return `${map.id}:${n}:${label(map.entries[0])}|${label(mid)}|${label(map.entries[n - 1])}`;
}

/**
 * Session cache key for a heavy focus. Stable across clicks; changes when
 * map ends or query steps that touch the map change.
 */
export function heavyPreviewCacheKey(
  workspace: Workspace,
  focusId: string,
): string {
  const needed = [...keyMapIdsNeededForFocus(workspace, focusId)].sort();
  const maps = workspace.key_maps ?? [];
  const mapFp = needed
    .map((id) => {
      const m = maps.find((x) => x.id === id);
      return m ? mapLiteFingerprint(m) : `${id}:missing`;
    })
    .join(";");
  const q = workspace.queries.find((x) => x.id === focusId);
  const stepFp = q
    ? q.steps
        .map((s) => {
          if (s.type === "ApplyKeyMap") {
            return `ApplyKeyMap:${s.payload.map_id}:${s.payload.column ?? ""}:${(s.payload.columns ?? []).join(",")}`;
          }
          return `${s.type}:${JSON.stringify(s.payload).length}`;
        })
        .join(">")
    : "";
  return `${focusId}#${mapFp}#${stepFp}`;
}

/** In-memory preview cache — one full IPC per heavy key per session fingerprint. */
export class HeavyPreviewCache {
  private readonly store = new Map<string, PreviewResult>();

  get(key: string): PreviewResult | undefined {
    return this.store.get(key);
  }

  set(key: string, result: PreviewResult): void {
    this.store.set(key, result);
  }

  clear(): void {
    this.store.clear();
  }
}

/** Dev/test helper — count entries that would be sent. */
export function previewTransportEntryCount(workspace: Workspace): number {
  const slim = workspaceForPreviewTransport(workspace);
  return (slim.key_maps ?? []).reduce((n, m) => n + m.entries.length, 0);
}

/** @internal walk helper for tests */
export function queryDependsOnMap(
  queries: QueryDef[],
  focusId: string,
  mapId: string,
): boolean {
  return keyMapIdsNeededForFocus(
    { queries, focus_query_id: focusId, key_maps: [] },
    focusId,
  ).has(mapId);
}
