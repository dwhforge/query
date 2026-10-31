import type {
  ConnectionDef,
  KeyMapDef,
  KeyMapEntry,
  NormalizeOp,
  Project,
  QueryDef,
  SourceDef,
  TransformationStep,
  Workspace,
} from "../types/pipeline";
import { slugify } from "../types/pipeline";

export type ApplySide = "left" | "right" | "both";

/**
 * Prefer the KeyMap already wired via ApplyKeyMap on this Join's key column
 * (host before Join for left; right query for right).
 *
 * Traces RenameColumn backward so ApplyKeyMap on a pre-rename name still matches.
 * Does NOT fall back to an unrelated ApplyKeyMap (e.g. channel before a company Join).
 */
export function findApplyKeyMapIdForJoin(
  workspace: Workspace,
  ctx: {
    hostQueryId: string;
    joinStepIndex: number;
    rightQueryId: string;
    leftOn: string[];
    rightOn: string[];
    probeSide?: "left" | "right";
  },
): string | null {
  const fold = (s: string) => s.toLowerCase();

  /** Names that refer to `joinCol` at each step, walking renames backward. */
  const scanMapForJoinCol = (
    steps: TransformationStep[],
    upto: number | null,
    joinCol: string | undefined,
  ): string | null => {
    if (!joinCol?.trim()) return null;
    const end = upto == null ? steps.length : Math.min(upto, steps.length);
    const names = new Set<string>([fold(joinCol)]);
    for (let i = end - 1; i >= 0; i--) {
      const s = steps[i];
      if (!s) continue;
      if (s.type === "RenameColumn") {
        const from = fold(s.payload.from);
        const to = fold(s.payload.to);
        if (names.has(to)) {
          names.delete(to);
          names.add(from);
        }
        continue;
      }
      if (s.type === "ApplyKeyMap") {
        if (names.has(fold(s.payload.column))) {
          return s.payload.map_id;
        }
      }
    }
    return null;
  };

  const preferRight = ctx.probeSide === "right";
  const leftCol = ctx.leftOn[0];
  const rightCol = ctx.rightOn[0];
  const host = workspace.queries.find((q) => q.id === ctx.hostQueryId);
  const right = workspace.queries.find((q) => q.id === ctx.rightQueryId);

  if (preferRight) {
    return (
      (right ? scanMapForJoinCol(right.steps, null, rightCol) : null) ??
      (host ? scanMapForJoinCol(host.steps, ctx.joinStepIndex, leftCol) : null)
    );
  }
  return (
    (host ? scanMapForJoinCol(host.steps, ctx.joinStepIndex, leftCol) : null) ??
    (right ? scanMapForJoinCol(right.steps, null, rightCol) : null)
  );
}

export function emptyKeyMap(name = "Key map"): KeyMapDef {
  const id = `map_${slugify(name)}_${Date.now().toString(36)}`;
  return {
    id,
    name,
    entries: [],
    storage: { kind: "seed" },
    from_column: "from",
    to_column: "to",
  };
}

/** dbt seed / ref name for a KeyMap id (mirrors Rust `key_map_seed_name`). */
export function keyMapSeedName(mapId: string): string {
  const raw = mapId
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const id = raw || "map";
  return id.startsWith("map_") ? id : `map_${id}`;
}

/** Trim from; reject empty to / duplicate from. */
export function validateKeyMapEntries(
  entries: KeyMapEntry[],
): { ok: true; entries: KeyMapEntry[] } | { ok: false; error: string } {
  const cleaned: KeyMapEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const from = e.from.trim();
    if (!from) return { ok: false, error: "Empty From is not allowed" };
    if (!e.to) return { ok: false, error: `Empty To for From '${from}'` };
    if (seen.has(from)) {
      return { ok: false, error: `Duplicate From '${from}'` };
    }
    seen.add(from);
    cleaned.push({
      from,
      to: e.to,
      ...(e.attrs && Object.keys(e.attrs).length ? { attrs: e.attrs } : {}),
    });
  }
  return { ok: true, entries: cleaned };
}

export function parseFromToPaste(text: string): KeyMapEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: KeyMapEntry[] = [];
  for (const line of lines) {
    if (/^from\s*[,|\t]\s*to$/i.test(line)) continue;
    const parts = line.includes("\t")
      ? line.split("\t")
      : line.includes(",")
        ? line.split(",")
        : line.split(/\s+/);
    if (parts.length < 2) continue;
    const from = parts[0]!.trim().replace(/^"|"$/g, "");
    const to = parts.slice(1).join(parts.length > 2 && line.includes(",") ? "," : "\t").trim().replace(/^"|"$/g, "");
    if (from) out.push({ from, to });
  }
  return out;
}

function upsertApplyStep(
  steps: TransformationStep[],
  at: number,
  column: string,
  map: KeyMapDef,
): TransformationStep[] {
  const next = [...steps];
  const payload = {
    column,
    map_id: map.id,
    entries: map.entries,
  };
  const existing = next.findIndex(
    (s, i) =>
      i <= at &&
      s.type === "ApplyKeyMap" &&
      s.payload.column === column &&
      s.payload.map_id === map.id,
  );
  if (existing >= 0) {
    next[existing] = { type: "ApplyKeyMap", payload };
    return next;
  }
  next.splice(at, 0, { type: "ApplyKeyMap", payload });
  return next;
}

function upsertNormalizeBeforeJoin(
  steps: TransformationStep[],
  joinIndex: number,
  columns: string[],
  ops: NormalizeOp[],
): TransformationStep[] {
  const next = [...steps];
  const existing = next.findIndex(
    (s, i) =>
      i < joinIndex &&
      s.type === "NormalizeKey" &&
      s.payload.columns.join("\0") === columns.join("\0"),
  );
  const step: TransformationStep = {
    type: "NormalizeKey",
    payload: { columns, ops },
  };
  if (existing >= 0) {
    next[existing] = step;
    return next;
  }
  next.splice(joinIndex, 0, step);
  return next;
}

/** Insert/update ApplyKeyMap on left (before join) and/or right (append). */
export function applyKeyMapToWorkspace(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  rightQueryId: string,
  side: ApplySide,
  columnLeft: string,
  columnRight: string,
  map: KeyMapDef,
): Workspace {
  const queries = workspace.queries.map((q) => {
    if (side !== "right" && q.id === hostQueryId) {
      return {
        ...q,
        steps: upsertApplyStep(q.steps, joinStepIndex, columnLeft, map),
      };
    }
    if (side !== "left" && q.id === rightQueryId) {
      return {
        ...q,
        steps: upsertApplyStep(q.steps, q.steps.length, columnRight, map),
      };
    }
    return q;
  });
  const key_maps = upsertKeyMapList(workspace.key_maps ?? [], map);
  return { ...workspace, queries, key_maps };
}

export function applyNormalizeToWorkspace(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  rightQueryId: string,
  side: ApplySide,
  leftOn: string[],
  rightOn: string[],
  ops: NormalizeOp[],
): Workspace {
  const queries = workspace.queries.map((q) => {
    if (side !== "right" && q.id === hostQueryId) {
      return {
        ...q,
        steps: upsertNormalizeBeforeJoin(q.steps, joinStepIndex, leftOn, ops),
      };
    }
    if (side !== "left" && q.id === rightQueryId) {
      const joinLike = q.steps.length;
      return {
        ...q,
        steps: upsertNormalizeBeforeJoin(q.steps, joinLike, rightOn, ops),
      };
    }
    return q;
  });
  return { ...workspace, queries };
}

export function upsertKeyMapList(
  maps: KeyMapDef[],
  map: KeyMapDef,
): KeyMapDef[] {
  const i = maps.findIndex((m) => m.id === map.id);
  if (i < 0) return [...maps, map];
  const next = [...maps];
  next[i] = map;
  return next;
}

export function syncApplyKeyMapEntries(
  queries: QueryDef[],
  map: KeyMapDef,
): QueryDef[] {
  // ADR-0022: source maps must not snapshot the WH dictionary into ApplyKeyMap.
  const snapEntries =
    map.storage?.kind === "source" ? [] : map.entries;
  return queries.map((q) => ({
    ...q,
    steps: q.steps.map((s) =>
      s.type === "ApplyKeyMap" && s.payload.map_id === map.id
        ? {
            ...s,
            payload: { ...s.payload, entries: snapEntries },
          }
        : s,
    ),
  }));
}

function pgDsn(c: ConnectionDef | undefined): string | null {
  const dsn = c?.postgres?.connection_string?.trim();
  return dsn || null;
}

export type KeyMapConnResolve =
  | { ok: true; dsn: string; connectionId: string }
  | { ok: false; error: string };

/**
 * Resolve Postgres DSN for a source-backed KeyMap.
 *
 * Write path (`forWrite=true`): requires an explicit `storage.connection_id`
 * with a usable DSN — never falls back to target / “any PG” (silent wrong DB).
 *
 * Read path: may fall back to a matching Explorer source’s connection only.
 * A *set* but missing/invalid `connection_id` is always an error (no silent hop).
 */
export function resolveKeyMapConnection(
  project: Project,
  map: KeyMapDef,
  connections: ConnectionDef[] = project.connections,
  forWrite = false,
): KeyMapConnResolve {
  if (map.storage?.kind !== "source") {
    return { ok: false, error: "KeyMap storage is not source" };
  }
  const { source, table, connection_id } = map.storage;
  const cid = connection_id?.trim() ?? "";

  if (cid) {
    const conn = connections.find((x) => x.id === cid);
    if (!conn) {
      return {
        ok: false,
        error: `KeyMap connection_id “${cid}” not found — pick a Connection in the editor (no fallback).`,
      };
    }
    const dsn = pgDsn(conn);
    if (!dsn) {
      return {
        ok: false,
        error: `Connection “${cid}” has no Postgres DSN — open Connections and save it.`,
      };
    }
    return { ok: true, dsn, connectionId: cid };
  }

  if (forWrite) {
    return {
      ok: false,
      error:
        "KeyMap write requires an explicit Connection on the map (Storage → Connection). No silent fallback to target / other PG.",
    };
  }

  // Read-only convenience: Explorer source with same schema.table.
  const match = project.sources.find(
    (s: SourceDef) =>
      s.kind === "postgres" &&
      (s.schema ?? "").toLowerCase() === source.toLowerCase() &&
      (s.table_name ?? "").toLowerCase() === table.toLowerCase(),
  );
  if (match?.connection_id) {
    const conn = connections.find((x) => x.id === match.connection_id);
    const dsn = pgDsn(conn);
    if (dsn && conn) {
      return { ok: true, dsn, connectionId: conn.id };
    }
  }
  if (match?.connection_string?.trim()) {
    return {
      ok: true,
      dsn: match.connection_string.trim(),
      connectionId: match.connection_id ?? "",
    };
  }

  return {
    ok: false,
    error: `No connection for KeyMap source ${source}.${table} — set Storage → Connection.`,
  };
}

/** @deprecated Prefer resolveKeyMapConnection — kept for call sites that only need DSN. */
export function resolveKeyMapConnectionString(
  project: Project,
  map: KeyMapDef,
  connections: ConnectionDef[] = project.connections,
  forWrite = false,
): string | null {
  const r = resolveKeyMapConnection(project, map, connections, forWrite);
  return r.ok ? r.dsn : null;
}

/** Remove KeyMap resource and all ApplyKeyMap steps that reference it. */
export function deleteKeyMapFromWorkspace(
  workspace: Workspace,
  mapId: string,
): { workspace: Workspace; removedSteps: number } {
  let removedSteps = 0;
  const queries = workspace.queries.map((q) => {
    const steps = q.steps.filter((s) => {
      if (s.type === "ApplyKeyMap" && s.payload.map_id === mapId) {
        removedSteps += 1;
        return false;
      }
      return true;
    });
    return { ...q, steps };
  });
  const key_maps = (workspace.key_maps ?? []).filter((m) => m.id !== mapId);
  return {
    workspace: { ...workspace, queries, key_maps },
    removedSteps,
  };
}

/** Accept into a draft only. Filled mappings and ambiguous proposals are untouched. */
export function mergeKeyMapProposals(
  entries: KeyMapEntry[],
  proposals: { from_key: string; to_key: string; ambiguous: boolean }[],
): KeyMapEntry[] {
  const merged = new Map(entries.map((entry) => [entry.from, entry]));
  for (const proposal of proposals) {
    if (proposal.ambiguous || merged.get(proposal.from_key)?.to.trim()) continue;
    merged.set(proposal.from_key, { from: proposal.from_key, to: proposal.to_key });
  }
  return [...merged.values()];
}
