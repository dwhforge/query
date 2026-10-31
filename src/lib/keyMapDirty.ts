import type { KeyMapEntry } from "../types/pipeline";
import type { KeyMapDirtyDelta } from "./bridge";
import { fromPartsEff, tupleKey } from "./keyMap";

/** Session dirty buffer for source KeyMap edits (ADR-0022 / ADR-0024). */
export class KeyMapDirtyBuffer {
  private upserts = new Map<string, KeyMapEntry>();
  private deleted = new Set<string>();

  clear() {
    this.upserts.clear();
    this.deleted.clear();
  }

  noteUpsert(entry: KeyMapEntry) {
    const parts = fromPartsEff(entry).map((p) => p.trim());
    if (!parts.length || parts.some((p) => !p)) return;
    const key = tupleKey(parts);
    this.deleted.delete(key);
    this.upserts.set(key, {
      from: parts[0]!,
      from_parts: parts,
      to: entry.to,
      ...(entry.attrs && Object.keys(entry.attrs).length
        ? { attrs: { ...entry.attrs } }
        : {}),
    });
  }

  noteDelete(partsOrFrom: string | string[]) {
    const parts = (
      Array.isArray(partsOrFrom) ? partsOrFrom : [partsOrFrom]
    ).map((p) => p.trim());
    if (!parts.length || parts.some((p) => !p)) return;
    const key = tupleKey(parts);
    this.upserts.delete(key);
    this.deleted.add(key);
  }

  /** From tuple renamed: treat old as delete, new as upsert. */
  noteRename(oldParts: string[], entry: KeyMapEntry) {
    const prev = oldParts.map((p) => p.trim());
    const next = fromPartsEff(entry).map((p) => p.trim());
    if (
      prev.length &&
      prev.every(Boolean) &&
      tupleKey(prev) !== tupleKey(next)
    ) {
      this.noteDelete(prev);
    }
    this.noteUpsert(entry);
  }

  isEmpty() {
    return this.upserts.size === 0 && this.deleted.size === 0;
  }

  toDelta(): KeyMapDirtyDelta | null {
    if (this.isEmpty()) return null;
    const deletedFromParts = [...this.deleted].map((k) => {
      try {
        const parsed = JSON.parse(k) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* legacy single-from keys */
      }
      return [k];
    });
    return {
      upserts: [...this.upserts.values()],
      deletedFroms: deletedFromParts
        .filter((p) => p.length === 1)
        .map((p) => p[0]!),
      deletedFromParts,
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
  return page
    .filter((e) => !deleted.has(tupleKey(fromPartsEff(e))))
    .map((e) => upserts.get(tupleKey(fromPartsEff(e))) ?? e);
}

export const KEYMAP_PAGE_SIZE = 200;
