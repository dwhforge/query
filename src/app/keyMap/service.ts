/**
 * KeyMap editing application use-cases (ADR-0020/0022 / ADR-0032).
 */
import type { KeyMapDirtyDelta, KeyMapSaveResult } from "../../lib/bridge";
import {
  applyKeyMapToWorkspace,
  fromPartsEff,
  syncApplyKeyMapEntries,
  tupleKey,
  upsertKeyMapList,
} from "../../lib/keyMap";
import type {
  KeyMapDef,
  KeyMapEntry,
  KeyMapStorage,
  Project,
  TransformationStep,
  Workspace,
} from "../../types/pipeline";
import { targetKey } from "../../types/pipeline";
import type {
  KeyMapApplyIntent,
  KeyMapApplyResult,
  KeyMapJoinCtx,
  KeyMapTabSession,
} from "./types";

type KeyMapIdentityMeta = Pick<
  KeyMapDef,
  "time_mode" | "valid_from_column" | "valid_to_column"
>;

/**
 * Stable edit identity for merge.
 * - Static / composite: full From tuple.
 * - Range SCD: From tuple + valid_from only (closing an open interval updates
 *   the same row instead of adding an overlapping sibling).
 */
export function keyMapEntryIdentity(
  entry: KeyMapEntry,
  map: KeyMapIdentityMeta,
): string {
  const parts = tupleKey(fromPartsEff(entry));
  if (map.time_mode === "range_scd") {
    const vf = map.valid_from_column?.trim() || "valid_from";
    const from = (entry.attrs?.[vf] ?? "").trim();
    return `${parts}\0${from}`;
  }
  return parts;
}

function storageBindingKey(storage: KeyMapStorage | undefined): string {
  if (!storage || storage.kind === "seed") return "seed";
  if (storage.kind === "ref") return `ref:${storage.model}`;
  return `source:${storage.connection_id ?? ""}:${storage.source}:${storage.table}`;
}

/** True when warehouse / seed binding changed — drop concurrency tokens. */
export function isKeyMapBindingChanged(
  prev: KeyMapDef,
  incoming: KeyMapDef,
): boolean {
  return (
    storageBindingKey(prev.storage) !== storageBindingKey(incoming.storage)
  );
}

function dirtyTouchesEntry(
  delta: KeyMapDirtyDelta | null | undefined,
  entry: KeyMapEntry,
  meta: KeyMapIdentityMeta,
): boolean {
  if (!delta) return false;
  const id = keyMapEntryIdentity(entry, meta);
  if (
    delta.upserts.some((u) => keyMapEntryIdentity(u, meta) === id)
  ) {
    return true;
  }
  return dirtyDeletesEntry(delta, entry);
}

function dirtyDeletesEntry(
  delta: KeyMapDirtyDelta | null | undefined,
  entry: KeyMapEntry,
): boolean {
  if (!delta) return false;
  const parts = fromPartsEff(entry).map((p) => p.trim());
  if (parts.length <= 1) {
    const from = parts[0] ?? entry.from.trim();
    return delta.deletedFroms.some((d) => d.trim() === from);
  }
  return (delta.deletedFromParts ?? []).some(
    (d) => tupleKey(d) === tupleKey(parts),
  );
}

/** True when a warehouse Save is awaiting response for this tab. */
export function isKeyMapSaveBusy(session: KeyMapTabSession): boolean {
  return Boolean(session.saveInFlight || session.saveApi?.isSaving());
}

/**
 * Apply an editor map patch. Binding changes reset concurrency / dirty state
 * and never union rows from the previous relation. In-flight Save → refuse.
 */
export function applyKeyMapTabMapChange(
  prev: KeyMapTabSession,
  nextMap: KeyMapDef,
):
  | { ok: true; session: KeyMapTabSession }
  | { ok: false; reason: string } {
  const normalized = normalizeKeyMapForEditor(nextMap);
  if (!isKeyMapBindingChanged(prev.map, normalized)) {
    return { ok: true, session: { ...prev, map: normalized } };
  }
  if (isKeyMapSaveBusy(prev)) {
    return {
      ok: false,
      reason:
        "KeyMap warehouse save still in progress — wait or abort before changing storage binding.",
    };
  }
  return {
    ok: true,
    session: {
      ...prev,
      map: normalized,
      contentHash: undefined,
      dirtyDelta: null,
      localDraft: false,
      saveInFlight: false,
      dirtyResetSeq: undefined,
      totalCount: undefined,
      // Invalidate capture/confirm wired to the previous binding's store.
      saveApi: undefined,
    },
  };
}

/** After ApplyKeyMap insert, Join may shift; find the same Join by right + ON + type. */
export function resolveJoinStepFromCtx(
  ws: Workspace,
  ctx: KeyMapJoinCtx,
): number | null {
  const q = ws.queries.find((x) => x.id === ctx.hostQueryId);
  if (!q) return null;
  const leftKey = ctx.leftOn.join("\0");
  const rightKey = ctx.rightOn.join("\0");
  const matches = (
    s: TransformationStep | undefined,
  ): s is TransformationStep & { type: "Join" } =>
    s?.type === "Join" &&
    targetKey(s.payload.right_query_id) === ctx.rightQueryId &&
    s.payload.left_on.join("\0") === leftKey &&
    s.payload.right_on.join("\0") === rightKey &&
    s.payload.join_type === ctx.joinType;
  const at = q.steps[ctx.joinStepIndex];
  if (matches(at)) return ctx.joinStepIndex;
  for (let i = 0; i < q.steps.length; i++) {
    if (matches(q.steps[i])) return i;
  }
  return null;
}

/** Pure: fold ApplyKeyMap into the latest project workspace. */
export function applyKeyMapOntoProject(
  project: Project,
  intent: KeyMapApplyIntent,
): { project: Project; result: KeyMapApplyResult } {
  const joinIdx = resolveJoinStepFromCtx(project.workspace, intent.ctx);
  if (joinIdx == null) {
    return {
      project,
      result: { status: "join_gone", mapId: intent.map.id },
    };
  }
  const workspace = applyKeyMapToWorkspace(
    {
      ...project.workspace,
      key_maps: upsertKeyMapList(project.workspace.key_maps ?? [], intent.map),
    },
    intent.ctx.hostQueryId,
    joinIdx,
    intent.ctx.rightQueryId,
    intent.side,
    intent.leftCols[0]!,
    intent.rightCols[0]!,
    intent.map,
    intent.leftCols,
    intent.rightCols,
    intent.outputColumnLeft,
    intent.outputColumnRight,
  );
  return {
    project: { ...project, workspace },
    result: { status: "ok", mapId: intent.map.id, workspace },
  };
}

export function normalizeKeyMapForEditor(map: KeyMapDef): KeyMapDef {
  return {
    storage: { kind: "seed" },
    from_column: "from",
    from_columns: map.from_columns?.length
      ? map.from_columns
      : [map.from_column ?? "from"],
    to_column: "to",
    ...map,
  };
}

function entrySnapshotsEqual(a: KeyMapEntry, b: KeyMapEntry): boolean {
  if (a.from.trim() !== b.from.trim() || a.to.trim() !== b.to.trim()) {
    return false;
  }
  const ap = fromPartsEff(a).map((p) => p.trim());
  const bp = fromPartsEff(b).map((p) => p.trim());
  if (tupleKey(ap) !== tupleKey(bp)) return false;
  const aa = a.attrs ?? {};
  const ba = b.attrs ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(ba)]);
  for (const k of keys) {
    if ((aa[k] ?? "").trim() !== (ba[k] ?? "").trim()) return false;
  }
  return true;
}

function isSeedOrRefStorage(map: KeyMapDef): boolean {
  const kind = map.storage?.kind ?? "seed";
  return kind === "seed" || kind === "ref";
}

/** Stable fingerprint of map rows — used to settle seed/ref Save without wiping newer edits. */
export function keyMapEntriesFingerprint(map: KeyMapDef): string {
  const meta: KeyMapIdentityMeta = {
    time_mode: map.time_mode,
    valid_from_column: map.valid_from_column,
    valid_to_column: map.valid_to_column,
  };
  const rows = map.entries
    .map((e) => {
      const id = keyMapEntryIdentity(e, meta);
      const attrs = e.attrs ?? {};
      const attrKeys = Object.keys(attrs).sort();
      const attrPart = attrKeys
        .map((k) => `${k}=${(attrs[k] ?? "").trim()}`)
        .join("&");
      return `${id}\t${e.to.trim()}\t${attrPart}`;
    })
    .sort();
  return rows.join("\n");
}

/**
 * After seed/ref Save of revision R1 succeeds: clear draft only if the tab
 * still holds R1. Edits made during the in-flight Save (R2) stay dirty.
 */
export function settleSeedDraftAfterSave(
  session: KeyMapTabSession,
  savedEntriesFingerprint: string,
): KeyMapTabSession {
  if (keyMapEntriesFingerprint(session.map) !== savedEntriesFingerprint) {
    return session;
  }
  return { ...session, localDraft: false, dirtyDelta: null };
}

/**
 * Merge incoming map rows into an open tab.
 * Preserves editor lifecycle (contentHash / dirtyDelta / saveApi) on reopen;
 * binding change replaces rows (no union with the previous relation).
 */
export function mergeKeyMapTabSession(
  prev: KeyMapTabSession,
  incoming: KeyMapDef,
  opts?: {
    pickTo?: string[];
    suggestedFrom?: string[];
    suggestedFromParts?: string[][];
    joinCtx?: KeyMapJoinCtx;
  },
): KeyMapTabSession {
  const normalized = normalizeKeyMapForEditor(incoming);
  if (isKeyMapBindingChanged(prev.map, normalized)) {
    // Never union previous binding rows into the new relation.
    const rebound = applyKeyMapTabMapChange(prev, normalized);
    const base = rebound.ok
      ? rebound.session
      : {
          // Busy save: keep prior session; caller should surface refusal.
          ...prev,
        };
    const next: KeyMapTabSession = { ...base };
    if (opts && "pickTo" in opts) next.pickTo = opts.pickTo;
    if (opts && "suggestedFrom" in opts) next.suggestedFrom = opts.suggestedFrom;
    if (opts && "suggestedFromParts" in opts) {
      next.suggestedFromParts = opts.suggestedFromParts;
    }
    if (opts && "joinCtx" in opts) next.joinCtx = opts.joinCtx;
    return next;
  }

  const meta: KeyMapIdentityMeta = {
    time_mode: normalized.time_mode ?? prev.map.time_mode,
    valid_from_column:
      normalized.valid_from_column ?? prev.map.valid_from_column,
    valid_to_column: normalized.valid_to_column ?? prev.map.valid_to_column,
  };
  const byId = new Map(
    prev.map.entries.map((e) => [keyMapEntryIdentity(e, meta), e] as const),
  );
  // Protect divergent rows when the tab has unsaved edits. Source maps usually
  // have dirtyDelta; seed/ref may only flip localDraft (no warehouse wire).
  const protectLocalDrafts =
    dirtyDeltaHasChanges(prev.dirtyDelta) || Boolean(prev.localDraft);

  for (const e of normalized.entries) {
    const id = keyMapEntryIdentity(e, meta);
    if (!id || id === "[]" || id.startsWith("[]\0")) continue;
    // Deleted drafts must not be resurrected by a SoT/suggest refresh.
    if (dirtyDeletesEntry(prev.dirtyDelta, e)) {
      byId.delete(id);
      continue;
    }
    const cur = byId.get(id);
    if (!cur) {
      // Seed/ref local draft has no reliable add-vs-delete baseline when
      // dirtyDelta is absent: do not union new incoming rows (would resurrect
      // intentional deletes). Suggest-merge while draft must be a separate path.
      if (protectLocalDrafts && isSeedOrRefStorage(prev.map)) {
        continue;
      }
      byId.set(id, e);
      continue;
    }
    // Local dirty draft wins over SoT/suggest refresh for this identity.
    if (dirtyTouchesEntry(prev.dirtyDelta, cur, meta)) {
      continue;
    }
    if (protectLocalDrafts && !entrySnapshotsEqual(cur, e)) {
      continue;
    }
    const toIn = e.to.trim();
    const toCur = cur.to.trim();
    if (toIn && toIn !== toCur) {
      // Fresh To from SoT/suggest; keep local attrs only if incoming omitted them.
      byId.set(id, {
        ...e,
        attrs: { ...(cur.attrs ?? {}), ...(e.attrs ?? {}) },
      });
    } else if (e.attrs && Object.keys(e.attrs).length > 0) {
      // Same To (or both empty): attrs / SCD bound updates.
      // Incoming omitted attr keys are left as-is (not treated as explicit clear).
      byId.set(id, {
        ...cur,
        to: toIn || cur.to,
        attrs: { ...(cur.attrs ?? {}), ...e.attrs },
      });
    } else if (toIn && !toCur) {
      byId.set(id, { ...cur, to: e.to });
    }
  }

  const next: KeyMapTabSession = {
    ...prev,
    map: {
      ...normalized,
      entries: [...byId.values()],
      storage: normalized.storage ?? prev.map.storage,
    },
  };
  if (opts && "pickTo" in opts) next.pickTo = opts.pickTo;
  if (opts && "suggestedFrom" in opts) next.suggestedFrom = opts.suggestedFrom;
  if (opts && "suggestedFromParts" in opts) {
    next.suggestedFromParts = opts.suggestedFromParts;
  }
  if (opts && "joinCtx" in opts) next.joinCtx = opts.joinCtx;
  return next;
}

/** Binding fingerprint for late Save-ack isolation. */
export function keyMapBindingFingerprint(map: KeyMapDef): string {
  return storageBindingKey(map.storage);
}

/**
 * AST form for project document (ADR-0022): source maps must not stash row bodies.
 */
export function mapForProjectAst(map: KeyMapDef): KeyMapDef {
  return map.storage?.kind === "source" ? { ...map, entries: [] } : map;
}

export function upsertKeyMapIntoProject(
  project: Project,
  map: KeyMapDef,
): Project {
  const forAst = mapForProjectAst(map);
  const key_maps = upsertKeyMapList(project.workspace.key_maps ?? [], forAst);
  const queries = syncApplyKeyMapEntries(project.workspace.queries, forAst);
  return {
    ...project,
    workspace: { ...project.workspace, key_maps, queries },
  };
}

export function dirtyDeltaHasChanges(
  delta: KeyMapDirtyDelta | null | undefined,
): boolean {
  if (!delta) return false;
  return (
    delta.upserts.length > 0 ||
    delta.deletedFroms.length > 0 ||
    (delta.deletedFromParts?.length ?? 0) > 0
  );
}

export function isSyncConflictMessage(msg: string): boolean {
  return /refused|hash mismatch|conflict|concurrently|hash/i.test(msg);
}

export function seedSaveResult(args: {
  exportPath: string | null | undefined;
  syncError?: string;
}): KeyMapSaveResult {
  if (!args.exportPath) {
    return {
      local: "saved",
      external: "skipped",
      message: "KeyMap saved in project (not exported yet — no seed CSV)",
    };
  }
  if (!args.syncError) {
    return {
      local: "saved",
      external: "synced",
      message: "KeyMap saved in project · synced → seeds (export tree)",
    };
  }
  const isConflict = isSyncConflictMessage(args.syncError);
  return {
    local: "saved",
    external: isConflict ? "conflict" : "error",
    message: args.syncError,
  };
}

export function sourceSaveSkipped(message: string): KeyMapSaveResult {
  return { local: "saved", external: "skipped", message };
}

export function sourceSaveSynced(args: {
  schema: string;
  table: string;
  rowsWritten: number;
  contentHash: string;
}): KeyMapSaveResult {
  return {
    local: "saved",
    external: "synced",
    message: `KeyMap saved in project · upsert → ${args.schema}.${args.table} (${args.rowsWritten} dirty rows)`,
    contentHash: args.contentHash,
  };
}

export function sourceSaveFailed(msg: string): KeyMapSaveResult {
  const isConflict = isSyncConflictMessage(msg);
  return {
    local: "saved",
    external: isConflict ? "conflict" : "error",
    message: msg,
  };
}

export function refSaveResult(): KeyMapSaveResult {
  return {
    local: "saved",
    external: "none",
    message: "KeyMap saved in project (ref storage — no warehouse write-back)",
  };
}

/** Merge From values (and optional To / parts) into a map for Join Lens → editor. */
export function mergeFromValuesIntoMap(args: {
  map: KeyMapDef;
  fromValues: string[];
  joinCtx: KeyMapJoinCtx;
  toValues?: string[];
  fromParts?: string[][];
}): KeyMapDef {
  const { map, fromValues, joinCtx, toValues, fromParts } = args;
  const entries: KeyMapEntry[] = [...map.entries];
  const indexByFrom = new Map(
    entries.map((e, i) => {
      const parts =
        e.from_parts?.length ? e.from_parts : e.from.trim() ? [e.from] : [];
      return [JSON.stringify(parts.map((p) => p.trim())), i] as const;
    }),
  );
  fromValues.forEach((rawFrom, i) => {
    const parts = (
      fromParts?.[i]?.length
        ? fromParts[i]!
        : rawFrom.trim()
          ? [rawFrom]
          : []
    ).map((p) => p.trim());
    if (!parts.length || parts.some((p) => !p)) return;
    const key = JSON.stringify(parts);
    const to = (toValues?.[i] ?? "").trim();
    const existing = indexByFrom.get(key);
    if (existing !== undefined) {
      if (to && !entries[existing]!.to.trim()) {
        entries[existing] = { ...entries[existing]!, to };
      }
      return;
    }
    indexByFrom.set(key, entries.length);
    entries.push({ from: parts[0]!, from_parts: parts, to });
  });
  const arity = Math.max(
    map.from_columns?.length ?? 0,
    joinCtx.applyLeftOn?.length ?? 0,
    fromParts?.find((p) => p.length)?.length ?? 1,
    1,
  );
  const from_columns =
    map.from_columns?.length === arity
      ? map.from_columns
      : joinCtx.applyLeftOn && joinCtx.applyLeftOn.length === arity
        ? joinCtx.applyLeftOn
        : arity > 1 && joinCtx.leftOn.length >= arity
          ? joinCtx.leftOn.slice(0, arity)
          : map.from_columns?.length
            ? map.from_columns
            : [map.from_column ?? "from"];
  return {
    ...map,
    from_columns,
    from_column: from_columns[0],
    entries,
  };
}
