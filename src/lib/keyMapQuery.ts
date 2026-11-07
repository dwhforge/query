/**
 * Query-backed KeyMap helpers (ADR-0036).
 * Binding / full-set row checks mirror Rust `keymap_query`.
 */
import type { KeyMapDef, QueryDef, Workspace } from "../types/pipeline";
import { fromColumnsEff, outputColumnsEff } from "./keyMap";

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
  if (!qid) return { ok: false, error: `Mapping “${map.id}”: not query-backed` };
  if (!workspace.queries.some((q) => q.id === qid)) {
    return {
      ok: false,
      error: `Mapping “${map.id}”: query “${qid}” not found`,
    };
  }
  const fromCols = fromColumnsEff(map);
  const outCols = outputColumnsEff(map);
  if (
    !fromCols.length ||
    fromCols.some((c) => !c.trim()) ||
    !outCols.length ||
    outCols.some((c) => !c.trim())
  ) {
    return { ok: false, error: "From/output columns must be non-empty" };
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
  for (const c of outCols) {
    if (!resolve(c)) {
      return {
        ok: false,
        error: `Output column “${c}” not found on query “${qid}”`,
      };
    }
  }
  const used = new Set<string>();
  for (const c of [...fromCols, ...outCols]) {
    const k = c.toLowerCase();
    if (used.has(k)) {
      return { ok: false, error: `Duplicate map column “${c}”` };
    }
    used.add(k);
  }
  return { ok: true };
}

/** Full-set row validation — no trim/case rewrite of values. */
export function validateQueryMapRows(
  mapId: string,
  fromArity: number,
  rows: (string | null)[][],
  outputArity = 1,
): { ok: true } | { ok: false; error: string } {
  if (fromArity < 1) {
    return { ok: false, error: `Mapping “${mapId}”: From arity must be ≥ 1` };
  }
  if (outputArity < 1) {
    return { ok: false, error: `Mapping “${mapId}”: output arity must be ≥ 1` };
  }
  const width = fromArity + outputArity;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length !== width) {
      return {
        ok: false,
        error: `Mapping “${mapId}”: row ${i} has ${row.length} cells, expected ${width}`,
      };
    }
    const fromParts: string[] = [];
    for (let p = 0; p < fromArity; p++) {
      const cell = row[p];
      if (cell == null) {
        return {
          ok: false,
          error: `Mapping “${mapId}”: NULL in From part ${p} at row ${i}`,
        };
      }
      if (cell === "") {
        return {
          ok: false,
          error: `Mapping “${mapId}”: empty From part ${p} at row ${i}`,
        };
      }
      fromParts.push(cell);
    }
    for (let o = 0; o < outputArity; o++) {
      const out = row[fromArity + o];
      const label = outputArity > 1 ? `output ${o}` : "To";
      if (out == null) {
        return {
          ok: false,
          error: `Mapping “${mapId}”: NULL in ${label} at row ${i}`,
        };
      }
      if (out === "") {
        return {
          ok: false,
          error: `Mapping “${mapId}”: empty ${label} at row ${i}`,
        };
      }
    }
    const key = JSON.stringify(fromParts);
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Mapping “${mapId}”: duplicate From tuple ${JSON.stringify(fromParts)} at row ${i}`,
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
  toCols: string | string[],
  limit: number,
): string {
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const outs = Array.isArray(toCols) ? toCols : [toCols];
  const cols = [...fromCols, ...outs].map(q).join(", ");
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
  const outs = outputColumnsEff(map);
  return {
    id: "__keymap_query_preview__",
    name: "keymap_query_preview",
    steps: [
      {
        type: "SqlModel",
        payload: {
          raw_sql: queryMapPreviewSql(qid, fromCols, outs, limit),
        },
      },
    ],
  };
}
