import type { KeyMapEntry } from "../types/pipeline";
import type { KeyMapDirtyBaseline, KeyMapDirtyDelta } from "./bridge";
import { fromPartsEff, tupleKey } from "./keyMap";

/** Editor-only marker: stable across empty→filled From/To before Save. */
export type EditorKeyMapEntry = KeyMapEntry & { __dwhLocalId?: string };

function snapshotEntry(entry: KeyMapEntry): KeyMapEntry {
  const parts = fromPartsEff(entry).map((p) => p.trim());
  return {
    from: parts[0] ?? "",
    from_parts: parts,
    to: entry.to,
    ...(entry.attrs && Object.keys(entry.attrs).length
      ? { attrs: { ...entry.attrs } }
      : {}),
  };
}

function partsFromKey(key: string): string[] {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* legacy single-from keys */
  }
  return [key];
}

function newLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Attach a stable local id (insert tracking) without clobbering an existing one. */
export function withLocalId(entry: KeyMapEntry, id = newLocalId()): EditorKeyMapEntry {
  const e = entry as EditorKeyMapEntry;
  if (e.__dwhLocalId) return e;
  return { ...entry, __dwhLocalId: id };
}

function validKeyParts(parts: string[]): boolean {
  return parts.length > 0 && parts.every(Boolean);
}

/** Session dirty buffer for source KeyMap edits (ADR-0022 / ADR-0024). */
export class KeyMapDirtyBuffer {
  private upserts = new Map<string, KeyMapEntry>();
  private deleted = new Set<string>();
  /**
   * First-seen warehouse snapshot per From key (`null` = row did not exist).
   * Frozen until clear — page navigation must not refresh this.
   */
  private baselines = new Map<string, KeyMapEntry | null>();
  /**
   * Local row ids marked as inserts at add-time, independent of From/To validity.
   * Prevents empty→filled drafts from being treated as warehouse baselines.
   */
  private insertIds = new Set<string>();
  /**
   * Last From key registered under a local editor row id (dirty session).
   * Survives empty/invalid From so delete/rename can retract prior upserts.
   */
  private keyByLocalId = new Map<string, string>();
  /**
   * Warehouse From key at load/bind time — independent of the editable From cell.
   * Used when the user clears From before delete/rename.
   */
  private originKeyByLocalId = new Map<string, string>();
  /** Warehouse row snapshot at bind (for baseline if never edited before delete). */
  private originSnapByLocalId = new Map<string, KeyMapEntry>();

  clear() {
    this.upserts.clear();
    this.deleted.clear();
    this.baselines.clear();
    this.insertIds.clear();
    this.keyByLocalId.clear();
    this.originKeyByLocalId.clear();
    this.originSnapByLocalId.clear();
  }

  /** Call when the user adds a blank/suggested row that is not yet in the warehouse. */
  markInsert(localId: string) {
    if (localId) this.insertIds.add(localId);
  }

  isInsert(localId: string | undefined | null): boolean {
    return !!localId && this.insertIds.has(localId);
  }

  /**
   * Remember the warehouse identity of a loaded editor row.
   * Frozen on first bind — page reloads must not overwrite after local edits.
   */
  bindOrigin(localId: string, warehouseEntry: KeyMapEntry) {
    if (!localId || this.originKeyByLocalId.has(localId)) return;
    const parts = fromPartsEff(warehouseEntry).map((p) => p.trim());
    if (!validKeyParts(parts)) return;
    const key = tupleKey(parts);
    this.originKeyByLocalId.set(localId, key);
    this.originSnapByLocalId.set(localId, snapshotEntry(warehouseEntry));
  }

  /** Resolve the From key for this editor row even when the cell is empty. */
  resolveKey(
    localId: string | undefined | null,
    partsOrFrom?: string | string[],
  ): string | undefined {
    if (localId) {
      const tracked =
        this.keyByLocalId.get(localId) ?? this.originKeyByLocalId.get(localId);
      if (tracked) return tracked;
    }
    if (partsOrFrom === undefined) return undefined;
    const parts = (
      Array.isArray(partsOrFrom) ? partsOrFrom : [partsOrFrom]
    ).map((p) => p.trim());
    if (!validKeyParts(parts)) return undefined;
    return tupleKey(parts);
  }

  private forgetLocal(localId: string) {
    this.keyByLocalId.delete(localId);
    this.originKeyByLocalId.delete(localId);
    this.originSnapByLocalId.delete(localId);
    this.insertIds.delete(localId);
  }

  /**
   * Prior From for this editor row changed: retract insert dirty, or WH-delete
   * the previous/origin key for loaded rows.
   */
  private detachPriorKey(localId: string, nextKey: string) {
    const prior =
      this.keyByLocalId.get(localId) ?? this.originKeyByLocalId.get(localId);
    if (!prior || prior === nextKey) return;

    if (this.isInsert(localId)) {
      this.upserts.delete(prior);
      this.baselines.delete(prior);
      this.deleted.delete(prior);
    } else {
      this.upserts.delete(prior);
      if (!this.baselines.has(prior)) {
        const snap = this.originSnapByLocalId.get(localId);
        if (snap) {
          this.baselines.set(prior, snap);
        } else {
          const keyParts = partsFromKey(prior);
          this.baselines.set(prior, {
            from: keyParts[0]!,
            from_parts: keyParts,
            to: "",
          });
        }
      }
      this.deleted.add(prior);
    }
    if (this.keyByLocalId.get(localId) === prior) {
      this.keyByLocalId.delete(localId);
    }
  }

  /**
   * @param baseline Warehouse (or prior) row before this session's first edit.
   *   `null` = insert (row must be absent). Omit to leave an existing baseline alone;
   *   if no baseline yet and omitted, treated as insert (`null`).
   * @param localId Editor row id — when marked via `markInsert`, forces insert baseline.
   */
  noteUpsert(
    entry: KeyMapEntry,
    baseline?: KeyMapEntry | null,
    localId?: string,
  ) {
    const parts = fromPartsEff(entry).map((p) => p.trim());
    if (!validKeyParts(parts)) return;
    const key = tupleKey(parts);
    if (localId) {
      this.detachPriorKey(localId, key);
    }
    this.deleted.delete(key);
    const forceInsert = this.isInsert(localId);
    if (!this.baselines.has(key)) {
      this.baselines.set(
        key,
        forceInsert || baseline === undefined || baseline === null
          ? null
          : snapshotEntry(baseline),
      );
    } else if (forceInsert) {
      // Insert marker wins over a mistaken draft snapshot from an earlier path.
      this.baselines.set(key, null);
    }
    this.upserts.set(key, snapshotEntry(entry));
    if (localId) this.keyByLocalId.set(localId, key);
  }

  noteDelete(
    partsOrFrom: string | string[],
    baseline?: KeyMapEntry,
    localId?: string,
  ) {
    if (localId && this.isInsert(localId)) {
      const tracked =
        this.keyByLocalId.get(localId) ?? this.originKeyByLocalId.get(localId);
      if (tracked) {
        this.upserts.delete(tracked);
        this.baselines.delete(tracked);
        this.deleted.delete(tracked);
      }
      this.forgetLocal(localId);
      return;
    }

    const key = this.resolveKey(localId, partsOrFrom);
    if (!key) return;

    // Rename-target / insert key (baseline null) — retract only, no WH DELETE.
    if (this.baselines.has(key) && this.baselines.get(key) === null) {
      this.upserts.delete(key);
      this.baselines.delete(key);
      this.deleted.delete(key);
      if (localId) this.forgetLocal(localId);
      return;
    }

    this.upserts.delete(key);
    if (!this.baselines.has(key)) {
      const originSnap = localId
        ? this.originSnapByLocalId.get(localId)
        : undefined;
      if (originSnap) {
        this.baselines.set(key, originSnap);
      } else if (baseline) {
        const bParts = fromPartsEff(baseline).map((p) => p.trim());
        if (validKeyParts(bParts)) {
          this.baselines.set(key, snapshotEntry(baseline));
        } else {
          const keyParts = partsFromKey(key);
          this.baselines.set(key, {
            from: keyParts[0]!,
            from_parts: keyParts,
            to: baseline.to,
            ...(baseline.attrs && Object.keys(baseline.attrs).length
              ? { attrs: { ...baseline.attrs } }
              : {}),
          });
        }
      } else {
        const keyParts = partsFromKey(key);
        this.baselines.set(key, {
          from: keyParts[0]!,
          from_parts: keyParts,
          to: "",
        });
      }
    }
    this.deleted.add(key);
    if (localId) this.forgetLocal(localId);
  }

  /** From tuple renamed: treat old as delete, new as upsert. */
  noteRename(
    oldParts: string[],
    entry: KeyMapEntry,
    oldRow?: KeyMapEntry,
    localId?: string,
  ) {
    const prev = oldParts.map((p) => p.trim());
    const next = fromPartsEff(entry).map((p) => p.trim());
    const forceInsert = this.isInsert(localId);
    if (validKeyParts(prev) && tupleKey(prev) !== tupleKey(next)) {
      const oldKey = tupleKey(prev);
      const oldWasInsert =
        forceInsert ||
        (this.baselines.has(oldKey) && this.baselines.get(oldKey) === null);
      if (oldWasInsert) {
        this.upserts.delete(oldKey);
        this.baselines.delete(oldKey);
        this.deleted.delete(oldKey);
        if (localId && this.keyByLocalId.get(localId) === oldKey) {
          this.keyByLocalId.delete(localId);
        }
      } else if (localId) {
        // Prefer localId path so origin key survives empty `oldParts` callers;
        // here oldParts are valid — still route through noteDelete for baseline.
        this.noteDelete(prev, oldRow, localId);
        // noteDelete forgets localId; re-bind origin is N/A (row left WH key).
        // noteUpsert below will register the new key under a fresh tracking entry:
        // restore localId maps by only clearing key/origin that noteDelete removed.
        // Re-attach localId for the new upsert (insert-like new From).
        if (localId) {
          // New From is an insert of a renamed identity; keep same localId.
          // origin cleared — correct (no longer the WH row under old key).
        }
      } else {
        this.noteDelete(prev, oldRow);
      }
    } else if (
      localId &&
      !validKeyParts(prev) &&
      validKeyParts(next) &&
      !forceInsert
    ) {
      // Rename through temporarily empty From: detach origin/prior → WH delete.
      this.detachPriorKey(localId, tupleKey(next));
    }
    this.noteUpsert(entry, null, localId);
  }

  isEmpty() {
    return this.upserts.size === 0 && this.deleted.size === 0;
  }

  toDelta(): KeyMapDirtyDelta | null {
    if (this.isEmpty()) return null;
    const deletedFromParts = [...this.deleted].map(partsFromKey);
    const baselines: KeyMapDirtyBaseline[] = [];
    const seen = new Set<string>();
    for (const key of [...this.upserts.keys(), ...this.deleted]) {
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = partsFromKey(key);
      const base = this.baselines.get(key);
      if (base === undefined) continue;
      baselines.push({
        fromParts: parts,
        existed: base !== null,
        to: base?.to ?? "",
        attrs: base?.attrs && Object.keys(base.attrs).length ? { ...base.attrs } : undefined,
      });
    }
    return {
      upserts: [...this.upserts.values()],
      deletedFroms: deletedFromParts
        .filter((p) => p.length === 1)
        .map((p) => p[0]!),
      deletedFromParts,
      baselines,
    };
  }

  dirtyCount() {
    return this.upserts.size + this.deleted.size;
  }
}

/**
 * Stamp stable local ids on a warehouse page and bind origin keys before dirty overlay.
 * Reuses ids from `prev` when the From key still matches.
 */
export function adoptWarehousePage(
  page: KeyMapEntry[],
  prev: KeyMapEntry[],
  dirty: KeyMapDirtyBuffer,
): EditorKeyMapEntry[] {
  const prevByKey = new Map<string, EditorKeyMapEntry>();
  for (const e of prev) {
    const parts = fromPartsEff(e).map((p) => p.trim());
    if (!validKeyParts(parts)) continue;
    prevByKey.set(tupleKey(parts), e as EditorKeyMapEntry);
  }
  const stamped = page.map((e) => {
    const parts = fromPartsEff(e).map((p) => p.trim());
    const key = validKeyParts(parts) ? tupleKey(parts) : "";
    const reuse = key ? prevByKey.get(key) : undefined;
    const row = withLocalId(e, reuse?.__dwhLocalId);
    if (key && row.__dwhLocalId) {
      dirty.bindOrigin(row.__dwhLocalId, e);
    }
    return row;
  });
  return applyDirtyToPage(stamped, dirty) as EditorKeyMapEntry[];
}

/**
 * Overlay unsaved dirty state onto a warehouse page so paging/reload does not
 * show stale server values or let a later edit clobber earlier unsaved attrs.
 */
export function applyDirtyToPage(
  page: KeyMapEntry[],
  dirty: KeyMapDirtyBuffer,
): KeyMapEntry[] {
  if (dirty.isEmpty()) return page;
  const delta = dirty.toDelta();
  if (!delta) return page;
  const deleted = new Set(
    (delta.deletedFromParts?.length
      ? delta.deletedFromParts
      : delta.deletedFroms.map((f) => [f])
    ).map((parts) => tupleKey(parts)),
  );
  const upserts = new Map<string, KeyMapEntry>();
  for (const e of delta.upserts) {
    upserts.set(tupleKey(fromPartsEff(e)), e);
  }
  const pageKeys = new Set(page.map((e) => tupleKey(fromPartsEff(e))));
  const overlay = page
    .filter((e) => !deleted.has(tupleKey(fromPartsEff(e))))
    .map((e) => {
      const key = tupleKey(fromPartsEff(e));
      const u = upserts.get(key);
      if (!u) return e;
      const localId = (e as EditorKeyMapEntry).__dwhLocalId;
      return localId ? { ...u, __dwhLocalId: localId } : u;
    });
  // New inserts not on this page still belong in the editor when on first page? Skip —
  // inserts stay on the page where they were added via local state.
  for (const [key, e] of upserts) {
    if (!pageKeys.has(key) && !deleted.has(key)) {
      void key;
      void e;
    }
  }
  return overlay;
}

export const KEYMAP_PAGE_SIZE = 200;
