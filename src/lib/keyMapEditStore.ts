import type { KeyMapEntry } from "../types/pipeline";
import type { KeyMapDirtyBaseline, KeyMapDirtyDelta } from "./bridge";
import { fromPartsEff, tupleKey } from "./keyMap";

export type RowId = string;

/** Missing attr key ≡ SQL NULL. Present `""` ≡ empty string. */
export type AttrMap = Record<string, string>;

export type RowSnapshot = {
  fromParts: string[];
  to: string;
  attrs: AttrMap;
};

export type RowEdit = {
  /** `null` = row did not exist in the warehouse (INSERT). */
  original: RowSnapshot | null;
  /** May contain temporarily invalid From/To while typing. */
  draft: RowSnapshot;
  deleted: boolean;
};

export type PageSlot = {
  id: RowId;
  loaded: RowSnapshot;
};

export type EditorKeyMapEntry = KeyMapEntry & { __dwhRowId?: string };

export type SaveCapture = {
  token: number;
  delta: KeyMapDirtyDelta | null;
  /**
   * Exact rows that produced wire ops in `delta` (invalid/unsent drafts excluded).
   * confirmSave only rebases these; mid-save delete of a sent INSERT becomes DELETE.
   */
  sent: Map<RowId, RowEdit>;
};

function newRowId(): RowId {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneSnap(s: RowSnapshot): RowSnapshot {
  return {
    fromParts: [...s.fromParts],
    to: s.to,
    attrs: { ...s.attrs },
  };
}

function cloneEdit(e: RowEdit): RowEdit {
  return {
    original: e.original ? cloneSnap(e.original) : null,
    draft: cloneSnap(e.draft),
    deleted: e.deleted,
  };
}

export function snapshotFromEntry(entry: KeyMapEntry): RowSnapshot {
  const fromParts = fromPartsEff(entry).map((p) => p.trim());
  return {
    fromParts,
    to: entry.to ?? "",
    attrs: entry.attrs ? { ...entry.attrs } : {},
  };
}

export function entryFromSnapshot(
  snap: RowSnapshot,
  rowId: RowId,
): EditorKeyMapEntry {
  return {
    from: snap.fromParts[0] ?? "",
    from_parts: [...snap.fromParts],
    to: snap.to,
    ...(Object.keys(snap.attrs).length ? { attrs: { ...snap.attrs } } : {}),
    __dwhRowId: rowId,
  };
}

function validKey(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => !!p.trim());
}

function snapEqual(a: RowSnapshot, b: RowSnapshot, editable: string[]): boolean {
  if (tupleKey(a.fromParts) !== tupleKey(b.fromParts)) return false;
  if (a.to !== b.to) return false;
  for (const c of editable) {
    if ((a.attrs[c] ?? null) !== (b.attrs[c] ?? null)) return false;
  }
  return true;
}

function emptyDraft(arity: number, editable: string[]): RowSnapshot {
  return {
    fromParts: Array.from({ length: Math.max(1, arity) }, () => ""),
    to: "",
    attrs: Object.fromEntries(editable.map((c) => [c, ""])),
  };
}

function baselineFromOriginal(
  original: RowSnapshot | null,
  fromPartsForInsert: string[],
  editable: string[],
): KeyMapDirtyBaseline {
  if (!original) {
    return {
      fromParts: [...fromPartsForInsert],
      existed: false,
      to: "",
      attrs: Object.fromEntries(editable.map((c) => [c, null])),
    };
  }
  return {
    fromParts: [...original.fromParts],
    existed: true,
    to: original.to,
    attrs: Object.fromEntries(
      editable.map((c) => [c, original.attrs[c] ?? null]),
    ),
  };
}

/**
 * Dirty-row store: only changed rows live here.
 * Page (loaded slots) stays outside; identity is RowId, not From.
 */
export class KeyMapEditStore {
  private rows = new Map<RowId, RowEdit>();
  /** Warehouse origin snapshot per RowId (page bind; not a dirty row by itself). */
  private origins = new Map<RowId, RowSnapshot>();
  /** original From tupleKey → RowId */
  private byOriginFrom = new Map<string, RowId>();
  private editable: string[] = [];
  private arity = 1;
  private captureToken = 0;
  private lastCapture: SaveCapture | null = null;

  setSchema(opts: { arity: number; editable: string[] }) {
    this.arity = Math.max(1, opts.arity);
    this.editable = [...opts.editable];
  }

  clear() {
    this.rows.clear();
    this.origins.clear();
    this.byOriginFrom.clear();
    this.lastCapture = null;
  }

  get(id: RowId): RowEdit | undefined {
    return this.rows.get(id);
  }

  /** Origin snapshot if this id was bound from a warehouse page. */
  originOf(id: RowId): RowSnapshot | undefined {
    return this.origins.get(id);
  }

  rowIdByOriginFrom(fromParts: string[]): RowId | undefined {
    if (!validKey(fromParts)) return undefined;
    return this.byOriginFrom.get(tupleKey(fromParts.map((p) => p.trim())));
  }

  dirtyCount(): number {
    return this.rows.size;
  }

  isEmpty(): boolean {
    return this.rows.size === 0;
  }

  /**
   * Remember warehouse identity for a page row without marking dirty.
   * Reuses an existing RowId when the origin From was seen before.
   */
  bindPageRow(loaded: RowSnapshot, preferId?: RowId): RowId {
    const parts = loaded.fromParts.map((p) => p.trim());
    const key = validKey(parts) ? tupleKey(parts) : "";
    let id =
      (key ? this.byOriginFrom.get(key) : undefined) ?? preferId ?? newRowId();
    if (!this.origins.has(id)) {
      this.origins.set(id, cloneSnap({ ...loaded, fromParts: parts }));
    }
    if (key) this.byOriginFrom.set(key, id);
    return id;
  }

  /**
   * Build page slots from a warehouse page, reusing RowIds across reloads.
   */
  adoptPage(entries: KeyMapEntry[], prev: PageSlot[]): PageSlot[] {
    const prevByFrom = new Map<string, RowId>();
    for (const s of prev) {
      if (validKey(s.loaded.fromParts)) {
        prevByFrom.set(tupleKey(s.loaded.fromParts), s.id);
      }
    }
    return entries.map((e) => {
      const loaded = snapshotFromEntry(e);
      const prefer =
        (validKey(loaded.fromParts)
          ? prevByFrom.get(tupleKey(loaded.fromParts))
          : undefined) ?? undefined;
      const id = this.bindPageRow(loaded, prefer);
      return { id, loaded: this.origins.get(id) ?? loaded };
    });
  }

  /**
   * View rows for the current page + in-page new drafts.
   * Deleted loaded rows are omitted; dirty drafts overlay loaded.
   */
  viewEntries(page: PageSlot[], newIds: RowId[]): EditorKeyMapEntry[] {
    const out: EditorKeyMapEntry[] = [];
    const seen = new Set<RowId>();
    for (const slot of page) {
      seen.add(slot.id);
      const edit = this.rows.get(slot.id);
      if (edit?.deleted) continue;
      const snap = edit ? edit.draft : slot.loaded;
      out.push(entryFromSnapshot(snap, slot.id));
    }
    for (const id of newIds) {
      if (seen.has(id)) continue;
      const edit = this.rows.get(id);
      if (!edit || edit.deleted) continue;
      out.push(entryFromSnapshot(edit.draft, id));
    }
    return out;
  }

  private ensureEdit(id: RowId, fallback?: RowSnapshot | null): RowEdit {
    let edit = this.rows.get(id);
    if (edit) return edit;
    const original = this.origins.get(id) ?? fallback ?? null;
    edit = {
      original: original ? cloneSnap(original) : null,
      draft: original
        ? cloneSnap(original)
        : emptyDraft(this.arity, this.editable),
      deleted: false,
    };
    this.rows.set(id, edit);
    return edit;
  }

  private pruneIfPristine(id: RowId) {
    // In-flight Save: never drop a sent row — draft may match the *pre-save*
    // original while WH is becoming the sent value (e.g. revert Y→X during Save of Y).
    if (this.lastCapture?.sent.has(id)) return;
    const edit = this.rows.get(id);
    if (!edit || edit.deleted) return;
    if (edit.original === null) return; // new row stays until delete
    if (snapEqual(edit.original, edit.draft, this.editable)) {
      this.rows.delete(id);
    }
  }

  /** After WH accepted `saved`, rebase origins and keep the user's latest draft. */
  private rebaseAfterSave(id: RowId, savedDraft: RowSnapshot, latest: RowEdit) {
    if (validKey(savedDraft.fromParts)) {
      this.origins.set(id, cloneSnap(savedDraft));
      this.byOriginFrom.set(tupleKey(savedDraft.fromParts), id);
    }
    if (latest.deleted) {
      this.rows.set(id, {
        original: cloneSnap(savedDraft),
        draft: cloneSnap(savedDraft),
        deleted: true,
      });
      return;
    }
    this.rows.set(id, {
      original: cloneSnap(savedDraft),
      draft: cloneSnap(latest.draft),
      deleted: false,
    });
    // Compare against the *new* baseline (what was sent), not the pre-save one.
    this.pruneIfPristine(id);
  }

  /** Patch draft fields. Creates a dirty entry on first edit of a loaded row. */
  updateDraft(
    id: RowId,
    patch: {
      fromParts?: string[];
      to?: string;
      attrs?: AttrMap;
    },
    fallback?: RowSnapshot | null,
  ) {
    const edit = this.ensureEdit(id, fallback);
    edit.deleted = false;
    if (patch.fromParts) {
      edit.draft.fromParts = patch.fromParts.map((p) => p.trim());
    }
    if (patch.to !== undefined) edit.draft.to = patch.to;
    if (patch.attrs) edit.draft.attrs = { ...edit.draft.attrs, ...patch.attrs };
    this.pruneIfPristine(id);
  }

  /** Brand-new row (INSERT). Returns RowId. */
  addRow(init?: Partial<RowSnapshot>): RowId {
    const id = newRowId();
    const draft = emptyDraft(this.arity, this.editable);
    if (init?.fromParts) draft.fromParts = init.fromParts.map((p) => p.trim());
    if (init?.to !== undefined) draft.to = init.to;
    if (init?.attrs) draft.attrs = { ...draft.attrs, ...init.attrs };
    this.rows.set(id, { original: null, draft, deleted: false });
    return id;
  }

  /**
   * Delete a row. New rows are removed from the store immediately.
   * Loaded rows become a DELETE against `original`.
   */
  deleteRow(id: RowId, fallback?: RowSnapshot | null) {
    const existing = this.rows.get(id);
    if (existing) {
      if (existing.original === null) {
        this.rows.delete(id);
        return;
      }
      existing.deleted = true;
      return;
    }
    const original = this.origins.get(id) ?? fallback ?? null;
    if (!original) return; // unknown new-ish id with no store entry
    this.rows.set(id, {
      original: cloneSnap(original),
      draft: cloneSnap(original),
      deleted: true,
    });
  }

  /**
   * Apply many fuzzy proposals in one pass. Does not build a delta per row.
   * Matches by origin/draft From; creates INSERTs for unknown keys.
   */
  applyProposals(
    proposals: { fromParts: string[]; to: string }[],
    page: PageSlot[],
  ): { newIds: RowId[] } {
    const pageByFrom = new Map<string, RowId>();
    for (const s of page) {
      if (validKey(s.loaded.fromParts)) {
        pageByFrom.set(tupleKey(s.loaded.fromParts), s.id);
      }
    }
    // Draft index for already-dirty rows
    const dirtyByFrom = new Map<string, RowId>();
    for (const [id, edit] of this.rows) {
      if (edit.deleted) continue;
      if (validKey(edit.draft.fromParts)) {
        dirtyByFrom.set(tupleKey(edit.draft.fromParts), id);
      }
    }

    const newIds: RowId[] = [];
    for (const p of proposals) {
      const parts = p.fromParts.map((x) => x.trim());
      if (!validKey(parts)) continue;
      const key = tupleKey(parts);
      const id =
        dirtyByFrom.get(key) ??
        pageByFrom.get(key) ??
        this.byOriginFrom.get(key);

      if (id) {
        const fallback =
          page.find((s) => s.id === id)?.loaded ?? this.origins.get(id) ?? null;
        const edit = this.ensureEdit(id, fallback);
        if (edit.deleted) continue;
        if (edit.draft.to.trim()) continue; // leave filled mappings
        if (p.to) edit.draft.to = p.to;
        dirtyByFrom.set(key, id);
        this.pruneIfPristine(id);
      } else {
        const nid = this.addRow({ fromParts: parts, to: p.to });
        newIds.push(nid);
        dirtyByFrom.set(key, nid);
      }
    }
    return { newIds };
  }

  /**
   * Build wire delta in O(D). Invalid drafts (empty From/To) are skipped
   * (still kept in the store for further editing).
   */
  toDelta(): KeyMapDirtyDelta | null {
    return this.deltaFromEdits(this.rows);
  }

  /** True when this edit contributes at least one wire op. */
  private editIsSendable(edit: RowEdit): boolean {
    if (edit.deleted) {
      return edit.original !== null && validKey(edit.original.fromParts);
    }
    const draftParts = edit.draft.fromParts.map((p) => p.trim());
    if (!validKey(draftParts) || !edit.draft.to) return false;
    if (!edit.original) return true;
    if (tupleKey(edit.original.fromParts) !== tupleKey(draftParts)) return true;
    return !snapEqual(edit.original, edit.draft, this.editable);
  }

  private deltaFromEdits(
    rows: Map<RowId, RowEdit>,
  ): KeyMapDirtyDelta | null {
    if (rows.size === 0) return null;

    const upserts: KeyMapEntry[] = [];
    const deletedFromParts: string[][] = [];
    const baselines: KeyMapDirtyBaseline[] = [];
    const baselineKeys = new Set<string>();

    const pushBaseline = (b: KeyMapDirtyBaseline) => {
      const k = `${b.existed ? 1 : 0}:${tupleKey(b.fromParts)}`;
      if (baselineKeys.has(k)) return;
      baselineKeys.add(k);
      baselines.push(b);
    };

    for (const edit of rows.values()) {
      if (edit.deleted) {
        if (!edit.original) continue;
        deletedFromParts.push([...edit.original.fromParts]);
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable));
        continue;
      }

      const draftParts = edit.draft.fromParts.map((p) => p.trim());
      if (!validKey(draftParts) || !edit.draft.to) continue;

      const draftEntry: KeyMapEntry = {
        from: draftParts[0]!,
        from_parts: draftParts,
        to: edit.draft.to,
        ...(Object.keys(edit.draft.attrs).length
          ? { attrs: { ...edit.draft.attrs } }
          : {}),
      };

      if (!edit.original) {
        upserts.push(draftEntry);
        pushBaseline(
          baselineFromOriginal(null, draftParts, this.editable),
        );
        continue;
      }

      const origKey = tupleKey(edit.original.fromParts);
      const draftKey = tupleKey(draftParts);

      if (origKey !== draftKey) {
        deletedFromParts.push([...edit.original.fromParts]);
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable));
        upserts.push(draftEntry);
        pushBaseline(
          baselineFromOriginal(null, draftParts, this.editable),
        );
        continue;
      }

      if (!snapEqual(edit.original, edit.draft, this.editable)) {
        upserts.push(draftEntry);
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable));
      }
    }

    if (!upserts.length && !deletedFromParts.length) return null;

    return {
      upserts,
      deletedFroms: deletedFromParts
        .filter((p) => p.length === 1)
        .map((p) => p[0]!),
      deletedFromParts,
      baselines,
    };
  }

  /**
   * Freeze only rows that will be sent. Invalid drafts stay dirty and are
   * untouched by confirmSave.
   */
  captureSave(): SaveCapture {
    const token = ++this.captureToken;
    const sent = new Map<RowId, RowEdit>();
    for (const [id, e] of this.rows) {
      if (this.editIsSendable(e)) sent.set(id, cloneEdit(e));
    }
    const delta = this.deltaFromEdits(sent);
    const cap = { token, delta, sent };
    this.lastCapture = cap;
    return cap;
  }

  /**
   * After successful WH write: for every sent row, baseline becomes the sent
   * value; the user's *latest* draft (pinned during Save) is compared to it.
   * Unsent drafts are untouched.
   */
  confirmSave(token: number) {
    if (!this.lastCapture || this.lastCapture.token !== token) return;
    const { sent } = this.lastCapture;
    // Clear capture first so pruneIfPristine may run against the new baseline.
    this.lastCapture = null;

    for (const [id, savedEdit] of sent) {
      // Latest user intention — pinned in-store for the whole Save.
      // If the row was removed (delete of a brand-new insert), treat as DELETE intent.
      const cur = this.rows.get(id);
      const latest: RowEdit = cur
        ? cloneEdit(cur)
        : savedEdit.original === null
          ? {
              original: null,
              draft: cloneSnap(savedEdit.draft),
              deleted: true,
            }
          : cloneEdit(savedEdit);

      if (savedEdit.deleted) {
        // WH delete of `savedEdit.original` succeeded.
        if (latest.deleted) {
          this.rows.delete(id);
          const orig = savedEdit.original;
          if (orig && validKey(orig.fromParts)) {
            this.byOriginFrom.delete(tupleKey(orig.fromParts));
          }
          this.origins.delete(id);
        }
        // else: undeleted mid-save — leave latest draft; rare, keep as-is with old original
        continue;
      }

      const savedDraft = savedEdit.draft;
      if (!validKey(savedDraft.fromParts)) continue;

      // Rename: old From is gone from WH.
      if (
        savedEdit.original &&
        tupleKey(savedEdit.original.fromParts) !== tupleKey(savedDraft.fromParts)
      ) {
        this.byOriginFrom.delete(tupleKey(savedEdit.original.fromParts));
      }

      this.rebaseAfterSave(id, savedDraft, latest);
    }
  }
}

export const KEYMAP_PAGE_SIZE = 200;

/** @deprecated Use KeyMapEditStore — kept as alias during migration. */
export { KeyMapEditStore as KeyMapDirtyBuffer };
