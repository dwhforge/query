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

  clear() {
    this.upserts.clear();
    this.deleted.clear();
    this.baselines.clear();
    this.insertIds.clear();
  }

  /** Call when the user adds a blank/suggested row that is not yet in the warehouse. */
  markInsert(localId: string) {
    if (localId) this.insertIds.add(localId);
  }

  isInsert(localId: string | undefined | null): boolean {
    return !!localId && this.insertIds.has(localId);
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
    if (!parts.length || parts.some((p) => !p)) return;
    const key = tupleKey(parts);
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
  }

  noteDelete(
    partsOrFrom: string | string[],
    baseline?: KeyMapEntry,
    localId?: string,
  ) {
    const parts = (
      Array.isArray(partsOrFrom) ? partsOrFrom : [partsOrFrom]
    ).map((p) => p.trim());
    if (this.isInsert(localId)) {
      // Never existed in WH — drop local dirty only.
      if (parts.length && parts.every(Boolean)) {
        const key = tupleKey(parts);
        this.upserts.delete(key);
        this.baselines.delete(key);
        this.deleted.delete(key);
      }
      this.insertIds.delete(localId!);
      return;
    }
    if (!parts.length || parts.some((p) => !p)) return;
    const key = tupleKey(parts);
    this.upserts.delete(key);
    if (!this.baselines.has(key) && baseline) {
      this.baselines.set(key, snapshotEntry(baseline));
    } else if (!this.baselines.has(key)) {
      // Delete without snapshot — still record key; server treats as "must exist".
      this.baselines.set(key, {
        from: parts[0]!,
        from_parts: parts,
        to: "",
      });
    }
    this.deleted.add(key);
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
    if (
      prev.length &&
      prev.every(Boolean) &&
      tupleKey(prev) !== tupleKey(next)
    ) {
      const oldKey = tupleKey(prev);
      // Inserts (marked or baseline null) never existed in WH — retract only.
      const oldWasInsert =
        forceInsert ||
        (this.baselines.has(oldKey) && this.baselines.get(oldKey) === null);
      if (oldWasInsert) {
        this.upserts.delete(oldKey);
        this.baselines.delete(oldKey);
        this.deleted.delete(oldKey);
      } else {
        this.noteDelete(prev, oldRow, localId);
      }
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
    .map((e) => upserts.get(tupleKey(fromPartsEff(e))) ?? e);
  // New inserts not on this page still belong in the editor when on first page? Skip —
  // inserts stay on the page where they were added via local entries.
  for (const [key, e] of upserts) {
    if (!pageKeys.has(key) && !deleted.has(key)) {
      // Keep insert visible only if it was already shown (handled by local state).
      void key;
      void e;
    }
  }
  return overlay;
}

export const KEYMAP_PAGE_SIZE = 200;
