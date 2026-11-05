/**
 * Query-backed KeyMap helpers (ADR-0036).
 * Binding / full-set row checks mirror Rust `keymap_query`.
 */
import type { KeyMapDef, QueryDef, Workspace } from "../types/pipeline";
import { fromColumnsEff } from "./keyMap";

export function isQueryBackedMap(map: KeyMapDef | null | undefined): boolean {
  return map?.storage?.kind === "query";
}

export function queryBackedQueryId(map: KeyMapDef): string | null {
  if (map.storage?.kind !== "query") return null;
  const id = map.storage.query_id.trim();
  return id || null;
}

export function validateQueryMapBinding(
  map: KeyMapDef,
  workspace: Workspace,
  schemaColumns: string[],
): { ok: true } | { ok: false; error: string } {
  const qid = queryBackedQueryId(map);
  if (!qid) return { ok: false, error: `KeyMap “${map.id}”: not query-backed` };
  if (!workspace.queries.some((q) => q.id === qid)) {
    return {
      ok: false,
      error: `KeyMap “${map.id}”: query “${qid}” not found`,
    };
  }
  const fromCols = fromColumnsEff(map);
  const to = (map.to_column ?? "to").trim();
  if (!fromCols.length || fromCols.some((c) => !c.trim()) || !to) {
    return { ok: false, error: "From/To columns must be non-empty" };
  }
  const folded = new Map<string, string>();
  for (const c of schemaColumns) {
    const k = c.toLowerCase();
    if (folded.has(k) && folded.get(k) !== c) {
      return {
        ok: false,
        error: `Ambiguous column “${c}” on query “${qid}”`,
      };
    }
    folded.set(k, c);
  }
  const resolve = (name: string) => folded.get(name.toLowerCase());
  for (const c of fromCols) {
    if (!resolve(c)) {
      return {
        ok: false,
        error: `Column “${c}” not found on query “${qid}”`,
      };
    }
  }
  if (!resolve(to)) {
    return { ok: false, error: `To column “${to}” not found on query “${qid}”` };
  }
  const fromSet = new Set(fromCols.map((c) => c.toLowerCase()));
  if (fromSet.size !== fromCols.length) {
    return { ok: false, error: "Duplicate From column" };
  }
  if (fromSet.has(to.toLowerCase())) {
    return { ok: false, error: "To intersects From columns" };
  }
  return { ok: true };
}

/** Full-set row validation — no trim/case rewrite of values. */
export function validateQueryMapRows(
  mapId: string,
  fromArity: number,
  rows: (string | null)[][],
): { ok: true } | { ok: false; error: string } {
  if (fromArity < 1) {
    return { ok: false, error: `KeyMap “${mapId}”: From arity must be ≥ 1` };
  }
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length !== fromArity + 1) {
      return {
        ok: false,
        error: `KeyMap “${mapId}”: row ${i} has ${row.length} cells, expected ${fromArity + 1}`,
      };
    }
    const fromParts: string[] = [];
    for (let p = 0; p < fromArity; p++) {
      const cell = row[p];
      if (cell == null) {
        return {
          ok: false,
          error: `KeyMap “${mapId}”: NULL in From part ${p} at row ${i}`,
        };
      }
      if (cell === "") {
        return {
          ok: false,
          error: `KeyMap “${mapId}”: empty From part ${p} at row ${i}`,
        };
      }
      fromParts.push(cell);
    }
    const to = row[fromArity];
    if (to == null) {
      return { ok: false, error: `KeyMap “${mapId}”: NULL in To at row ${i}` };
    }
    if (to === "") {
      return { ok: false, error: `KeyMap “${mapId}”: empty To at row ${i}` };
    }
    const key = JSON.stringify(fromParts);
    if (seen.has(key)) {
      return {
        ok: false,
        error: `KeyMap “${mapId}”: duplicate From tuple ${JSON.stringify(fromParts)} at row ${i}`,
      };
    }
    seen.add(key);
  }
  return { ok: true };
}

/** Ephemeral projection of map query → From…To for editor preview. */
export function queryMapPreviewSql(
  queryId: string,
  fromCols: string[],
  toCol: string,
  limit: number,
): string {
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const cols = [...fromCols, toCol].map(q).join(", ");
  const n = Math.max(1, Math.min(limit, 500));
  return `SELECT ${cols} FROM {{query:${queryId}}} LIMIT ${n}`;
}

export function queryMapPreviewQuery(
  map: KeyMapDef,
  limit = 50,
): QueryDef | null {
  const qid = queryBackedQueryId(map);
  if (!qid) return null;
  const fromCols = fromColumnsEff(map);
  const to = (map.to_column ?? "to").trim() || "to";
  return {
    id: "__keymap_query_preview__",
    name: "keymap_query_preview",
    steps: [
      {
        type: "SqlModel",
        payload: {
          raw_sql: queryMapPreviewSql(qid, fromCols, to, limit),
        },
      },
    ],
  };
}
