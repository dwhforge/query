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


/** Effective From column names on the map relation (ADR-0024). */
export function fromColumnsEff(map: KeyMapDef): string[] {
  if (map.from_columns?.length) return map.from_columns;
  const one = (map.from_column ?? "from").trim() || "from";
  return [one];
}

/** Effective From parts on an entry (ADR-0024). */
export function fromPartsEff(e: KeyMapEntry): string[] {
  if (e.from_parts?.length) return e.from_parts;
  return e.from?.trim() ? [e.from] : [];
}

/** Stable key for dirty-buffer / uniqueness (JSON tuple). */
export function tupleKey(parts: string[]): string {
  return JSON.stringify(parts.map((p) => p.trim()));
}

export function applyKeymapColumns(
  column: string | undefined,
  columns: string[] | undefined,
): string[] {
  if (columns?.length) return columns;
  if (column?.trim()) return [column.trim()];
  return [];
}

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
        const cols = applyKeymapColumns(
          s.payload.column,
          s.payload.columns,
        ).map(fold);
        if (cols.some((c) => names.has(c))) {
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
    from_columns: ["from"],
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

/** Trim From parts; reject empty to / duplicate tuples (ADR-0024). */
export function validateKeyMapEntries(
  entries: KeyMapEntry[],
  arity = 1,
): { ok: true; entries: KeyMapEntry[] } | { ok: false; error: string } {
  const n = Math.max(1, arity);
  const cleaned: KeyMapEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    let parts = fromPartsEff(e).map((p) => p.trim());
    if (parts.length === 1 && n > 1) {
      while (parts.length < n) parts.push("");
    }
    if (parts.length !== n && parts.every(Boolean)) {
      return {
        ok: false,
        error: `From parts length ${parts.length} ≠ arity ${n}`,
      };
    }
    // While editing mid-flight, allow incomplete arity (pad) but reject empties once filled.
    if (parts.length < n) {
      while (parts.length < n) parts.push("");
    }
    if (parts.length > n) parts = parts.slice(0, n);
    if (parts.some((p) => !p)) {
      return { ok: false, error: "Empty From part is not allowed" };
    }
    if (!e.to) {
      return {
        ok: false,
        error: `Empty To for From ${JSON.stringify(parts)}`,
      };
    }
    const key = tupleKey(parts);
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Duplicate From ${JSON.stringify(parts)}`,
      };
    }
    seen.add(key);
    cleaned.push({
      from: parts[0]!,
      from_parts: parts,
      to: e.to,
      ...(e.attrs && Object.keys(e.attrs).length ? { attrs: e.attrs } : {}),
    });
  }
  return { ok: true, entries: cleaned };
}

export function parseFromToPaste(
  text: string,
  arity = 1,
): KeyMapEntry[] {
  const n = Math.max(1, arity);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: KeyMapEntry[] = [];
  for (const line of lines) {
    if (/^from\b/i.test(line) && /\bto\b/i.test(line)) continue;
    const parts = line.includes("\t")
      ? line.split("\t")
      : line.includes(",")
        ? line.split(",")
        : line.split(/\s+/);
    if (parts.length < n + 1) continue;
    const fromParts = parts
      .slice(0, n)
      .map((p) => p.trim().replace(/^"|"$/g, ""));
    const to = parts
      .slice(n)
      .join(line.includes(",") ? "," : "\t")
      .trim()
      .replace(/^"|"$/g, "");
    if (fromParts.every(Boolean)) {
      out.push({
        from: fromParts[0]!,
        from_parts: fromParts,
        to,
      });
    }
  }
  return out;
}

function upsertApplyStep(
  steps: TransformationStep[],
  at: number,
  columns: string[],
  map: KeyMapDef,
  outputColumn?: string,
): TransformationStep[] {
  const next = [...steps];
  const cols = columns.filter((c) => c.trim());
  if (!cols.length) return next;
  const payload = {
    column: cols[0]!,
    columns: cols,
    ...(outputColumn?.trim() ? { output_column: outputColumn.trim() } : {}),
    map_id: map.id,
    entries: map.entries,
  };
  const key = cols.map((c) => c.toLowerCase()).join("\0");
  const existing = next.findIndex((s, i) => {
    if (i > at || s.type !== "ApplyKeyMap" || s.payload.map_id !== map.id) {
      return false;
    }
    const sc = applyKeymapColumns(s.payload.column, s.payload.columns)
      .map((c) => c.toLowerCase())
      .join("\0");
    return sc === key;
  });
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
  columnsLeft?: string[],
  columnsRight?: string[],
  outputColumnLeft?: string,
  outputColumnRight?: string,
): Workspace {
  const leftCols = columnsLeft?.length ? columnsLeft : [columnLeft];
  const rightCols = columnsRight?.length ? columnsRight : [columnRight];
  const outLeft =
    outputColumnLeft?.trim() || leftCols[0];
  const outRight =
    outputColumnRight?.trim() || rightCols[0];
  const queries = workspace.queries.map((q) => {
    if (side !== "right" && q.id === hostQueryId) {
      return {
        ...q,
        steps: upsertApplyStep(
          q.steps,
          joinStepIndex,
          leftCols,
          map,
          outLeft,
        ),
      };
    }
    if (side !== "left" && q.id === rightQueryId) {
      return {
        ...q,
        steps: upsertApplyStep(
          q.steps,
          q.steps.length,
          rightCols,
          map,
          outRight,
        ),
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
  proposals: {
    from_key: string;
    to_key: string;
    ambiguous: boolean;
    from_parts?: string[];
  }[],
): KeyMapEntry[] {
  const merged = new Map(
    entries.map((entry) => [tupleKey(fromPartsEff(entry)), entry] as const),
  );
  for (const proposal of proposals) {
    if (proposal.ambiguous) continue;
    const parts =
      proposal.from_parts?.length
        ? proposal.from_parts
        : proposal.from_key.trim()
          ? [proposal.from_key]
          : [];
    if (!parts.length) continue;
    const key = tupleKey(parts);
    if (merged.get(key)?.to.trim()) continue;
    merged.set(key, {
      from: parts[0]!,
      from_parts: parts,
      to: proposal.to_key,
    });
  }
  return [...merged.values()];
}
