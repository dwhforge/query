import type { KeyMapEntry } from "../types/pipeline";
import type { KeyMapDirtyBaseline, KeyMapDirtyDelta } from "./bridge";
import { fromPartsEff, outputValuesEff, tupleKey } from "./keyMap";

export type RowId = string;

/** Missing attr key ≡ SQL NULL. Present `""` ≡ empty string. */
export type AttrMap = Record<string, string>;

export type RowSnapshot = {
  fromParts: string[];
  /** First output (legacy single-To); always mirrors `outputs[0]`. */
  to: string;
  /** Values aligned to the map's output columns (ADR-0037); length ≥ 1. */
  outputs: string[];
  attrs: AttrMap;
};

function normOutputs(outputs: string[] | undefined, arity: number): string[] {
  const n = Math.max(1, arity);
  const out = (outputs ?? []).slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

function outputsFilled(outputs: string[]): boolean {
  return outputs.length > 0 && outputs.every((v) => !!v);
}

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
    outputs: [...s.outputs],
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
  const eff = outputValuesEff(entry);
  const outputs = eff.length ? [...eff] : [""];
  return {
    fromParts,
    to: outputs[0] ?? "",
    outputs,
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
    to: snap.outputs[0] ?? snap.to,
    output_values: [...snap.outputs],
    ...(Object.keys(snap.attrs).length ? { attrs: { ...snap.attrs } } : {}),
    __dwhRowId: rowId,
  };
}

function validKey(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => !!p.trim());
}

function snapEqual(a: RowSnapshot, b: RowSnapshot, editable: string[]): boolean {
  if (tupleKey(a.fromParts) !== tupleKey(b.fromParts)) return false;
  const n = Math.max(a.outputs.length, b.outputs.length);
  for (let i = 0; i < n; i++) {
    if ((a.outputs[i] ?? "") !== (b.outputs[i] ?? "")) return false;
  }
  for (const c of editable) {
    if ((a.attrs[c] ?? null) !== (b.attrs[c] ?? null)) return false;
  }
  return true;
}

function emptyDraft(
  arity: number,
  editable: string[],
  outputArity = 1,
): RowSnapshot {
  return {
    fromParts: Array.from({ length: Math.max(1, arity) }, () => ""),
    to: "",
    outputs: normOutputs([], outputArity),
    attrs: Object.fromEntries(editable.map((c) => [c, ""])),
  };
}

function baselineFromOriginal(
  original: RowSnapshot | null,
  fromPartsForInsert: string[],
  editable: string[],
  outputColumns: string[] = [],
): KeyMapDirtyBaseline {
  const outputsMap = (values: string[]): Record<string, string> =>
    Object.fromEntries(outputColumns.map((c, i) => [c, values[i] ?? ""]));
  if (!original) {
    return {
      fromParts: [...fromPartsForInsert],
      existed: false,
      to: "",
      ...(outputColumns.length ? { outputs: outputsMap([]) } : {}),
      attrs: Object.fromEntries(editable.map((c) => [c, null])),
    };
  }
  return {
    fromParts: [...original.fromParts],
    existed: true,
    to: original.outputs[0] ?? original.to,
    ...(outputColumns.length ? { outputs: outputsMap(original.outputs) } : {}),
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
  private outputColumns: string[] = ["to"];
  private captureToken = 0;
  private lastCapture: SaveCapture | null = null;

  setSchema(opts: {
    arity: number;
    editable: string[];
    /** Output column names (ADR-0037); default `["to"]`. */
    outputColumns?: string[];
  }) {
    this.arity = Math.max(1, opts.arity);
    this.editable = [...opts.editable];
    const cols = opts.outputColumns?.length ? opts.outputColumns : ["to"];
    this.outputColumns = [...cols];
  }

  /** Current output arity (≥ 1). */
  get outputArity(): number {
    return this.outputColumns.length;
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
      const loaded = this.normSnap(snapshotFromEntry(e));
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

  private normSnap(s: RowSnapshot): RowSnapshot {
    const outputs = normOutputs(s.outputs, this.outputArity);
    return { ...s, outputs, to: outputs[0] ?? "" };
  }

  private ensureEdit(id: RowId, fallback?: RowSnapshot | null): RowEdit {
    let edit = this.rows.get(id);
    if (edit) return edit;
    const original = this.origins.get(id) ?? fallback ?? null;
    edit = {
      original: original ? cloneSnap(original) : null,
      draft: original
        ? cloneSnap(original)
        : emptyDraft(this.arity, this.editable, this.outputArity),
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
      /** Sets the first output (legacy). */
      to?: string;
      /** Full output vector aligned to output columns (ADR-0037). */
      outputs?: string[];
      attrs?: AttrMap;
    },
    fallback?: RowSnapshot | null,
  ) {
    const edit = this.ensureEdit(id, fallback);
    edit.deleted = false;
    if (patch.fromParts) {
      edit.draft.fromParts = patch.fromParts.map((p) => p.trim());
    }
    if (patch.outputs) {
      edit.draft.outputs = normOutputs(patch.outputs, this.outputArity);
    }
    if (patch.to !== undefined) edit.draft.outputs[0] = patch.to;
    edit.draft.to = edit.draft.outputs[0] ?? "";
    if (patch.attrs) edit.draft.attrs = { ...edit.draft.attrs, ...patch.attrs };
    this.pruneIfPristine(id);
  }

  /** Brand-new row (INSERT). Returns RowId. */
  addRow(init?: Partial<RowSnapshot>): RowId {
    const id = newRowId();
    const draft = emptyDraft(this.arity, this.editable, this.outputArity);
    if (init?.fromParts) draft.fromParts = init.fromParts.map((p) => p.trim());
    if (init?.outputs) draft.outputs = normOutputs(init.outputs, this.outputArity);
    if (init?.to !== undefined) draft.outputs[0] = init.to;
    draft.to = draft.outputs[0] ?? "";
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
    proposals: { fromParts: string[]; to: string; outputs?: string[] }[],
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
        const eff = normOutputs(p.outputs ?? [p.to], this.outputArity);
        if (edit.draft.outputs.some((v) => v.trim())) continue; // leave filled mappings
        if (eff.some((v) => v)) {
          edit.draft.outputs = eff;
          edit.draft.to = eff[0] ?? "";
        }
        dirtyByFrom.set(key, id);
        this.pruneIfPristine(id);
      } else {
        const nid = this.addRow({
          fromParts: parts,
          outputs: p.outputs ?? [p.to],
        });
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
    if (!validKey(draftParts) || !outputsFilled(edit.draft.outputs)) return false;
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
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable, this.outputColumns));
        continue;
      }

      const draftParts = edit.draft.fromParts.map((p) => p.trim());
      if (!validKey(draftParts) || !outputsFilled(edit.draft.outputs)) continue;

      const draftEntry: KeyMapEntry = {
        from: draftParts[0]!,
        from_parts: draftParts,
        to: edit.draft.outputs[0]!,
        output_values: [...edit.draft.outputs],
        ...(Object.keys(edit.draft.attrs).length
          ? { attrs: { ...edit.draft.attrs } }
          : {}),
      };

      if (!edit.original) {
        upserts.push(draftEntry);
        pushBaseline(
          baselineFromOriginal(null, draftParts, this.editable, this.outputColumns),
        );
        continue;
      }

      const origKey = tupleKey(edit.original.fromParts);
      const draftKey = tupleKey(draftParts);

      if (origKey !== draftKey) {
        deletedFromParts.push([...edit.original.fromParts]);
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable, this.outputColumns));
        upserts.push(draftEntry);
        pushBaseline(
          baselineFromOriginal(null, draftParts, this.editable, this.outputColumns),
        );
        continue;
      }

      if (!snapEqual(edit.original, edit.draft, this.editable)) {
        upserts.push(draftEntry);
        pushBaseline(baselineFromOriginal(edit.original, [], this.editable, this.outputColumns));
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

  /** True while a warehouse Save capture is outstanding. */
  isSaveInFlight(): boolean {
    return this.lastCapture != null;
  }

  /**
   * Freeze only rows that will be sent. Rejects if a Save is already in flight
   * (one capture per mapping). Invalid drafts stay dirty and are untouched by
   * confirmSave.
   */
  captureSave(): SaveCapture | null {
    if (this.lastCapture) return null;
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
   * End an in-flight Save without rebasing (error / conflict / cancel).
   * Releases the pin, then prunes sent rows that again match the pre-save
   * baseline (e.g. user reverted Y→X while Save of Y was in flight).
   */
  abortSave(token: number) {
    if (!this.lastCapture || this.lastCapture.token !== token) return;
    const sentIds = [...this.lastCapture.sent.keys()];
    this.lastCapture = null;
    for (const id of sentIds) {
      this.pruneIfPristine(id);
    }
  }

  /**
   * After successful WH write for this exact capture token: baseline becomes the
   * sent value; the user's *latest* draft is compared to it.
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
