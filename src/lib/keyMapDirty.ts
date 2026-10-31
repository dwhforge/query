import type { KeyMapEntry } from "../types/pipeline";
import type { KeyMapDirtyDelta } from "./bridge";

/** Session dirty buffer for source KeyMap edits (ADR-0022). */
export class KeyMapDirtyBuffer {
  private upserts = new Map<string, KeyMapEntry>();
  private deleted = new Set<string>();

  clear() {
    this.upserts.clear();
    this.deleted.clear();
  }

  noteUpsert(entry: KeyMapEntry) {
    const from = entry.from.trim();
    if (!from) return;
    this.deleted.delete(from);
    this.upserts.set(from, {
      from,
      to: entry.to,
      ...(entry.attrs && Object.keys(entry.attrs).length
        ? { attrs: { ...entry.attrs } }
        : {}),
    });
  }

  noteDelete(fromRaw: string) {
    const from = fromRaw.trim();
    if (!from) return;
    this.upserts.delete(from);
    this.deleted.add(from);
  }

  /** From key renamed: treat old as delete, new as upsert. */
  noteRename(oldFrom: string, entry: KeyMapEntry) {
    const prev = oldFrom.trim();
    if (prev && prev !== entry.from.trim()) {
      this.noteDelete(prev);
    }
    this.noteUpsert(entry);
  }

  isEmpty() {
    return this.upserts.size === 0 && this.deleted.size === 0;
  }

  toDelta(): KeyMapDirtyDelta | null {
    if (this.isEmpty()) return null;
    return {
      upserts: [...this.upserts.values()],
      deletedFroms: [...this.deleted],
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
    delta.deletedFroms.map((f) => f.trim()).filter(Boolean),
  );
  const upserts = new Map<string, KeyMapEntry>();
  for (const e of delta.upserts) {
    const from = e.from.trim();
    if (from) upserts.set(from, e);
  }
  return page
    .filter((e) => !deleted.has(e.from.trim()))
    .map((e) => upserts.get(e.from.trim()) ?? e);
}

export const KEYMAP_PAGE_SIZE = 200;
