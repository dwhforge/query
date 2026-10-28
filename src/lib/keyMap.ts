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
    cleaned.push({ from, to: e.to });
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
  return queries.map((q) => ({
    ...q,
    steps: q.steps.map((s) =>
      s.type === "ApplyKeyMap" && s.payload.map_id === map.id
        ? {
            ...s,
            payload: { ...s.payload, entries: map.entries },
          }
        : s,
    ),
  }));
}

function pgDsn(c: ConnectionDef | undefined): string | null {
  const dsn = c?.postgres?.connection_string?.trim();
  return dsn || null;
}

/** Resolve Postgres DSN for a source-backed KeyMap (explicit conn → source → target → any PG). */
export function resolveKeyMapConnectionString(
  project: Project,
  map: KeyMapDef,
  connections: ConnectionDef[] = project.connections,
): string | null {
  if (map.storage?.kind !== "source") return null;
  const { source, table, connection_id } = map.storage;

  if (connection_id) {
    const dsn = pgDsn(connections.find((x) => x.id === connection_id));
    if (dsn) return dsn;
  }

  const match = project.sources.find(
    (s: SourceDef) =>
      s.kind === "postgres" &&
      (s.schema ?? "").toLowerCase() === source.toLowerCase() &&
      (s.table_name ?? "").toLowerCase() === table.toLowerCase(),
  );
  if (match?.connection_id) {
    const dsn = pgDsn(connections.find((x) => x.id === match.connection_id));
    if (dsn) return dsn;
  }
  if (match?.connection_string?.trim()) return match.connection_string.trim();

  if (project.target_connection_id) {
    const dsn = pgDsn(
      connections.find((x) => x.id === project.target_connection_id),
    );
    if (dsn) return dsn;
  }
  // Prefer any Postgres connection that already has a DSN (Explorer Sources optional).
  for (const c of connections) {
    if (c.kind !== "postgres") continue;
    const dsn = pgDsn(c);
    if (dsn) return dsn;
  }
  return null;
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
