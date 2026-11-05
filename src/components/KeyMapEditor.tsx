import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ConnectionDef,
  KeyMapDef,
  KeyMapEntry,
  KeyMapStorage,
} from "../types/pipeline";
import {
  describeWorkspace,
  listPostgresObjects,
  previewWorkspace,
  readKeyMap,
  type KeyMapDirtyDelta,
} from "../lib/bridge";
import {
  isQueryBackedMap,
  queryMapPreviewQuery,
  validateQueryMapRows,
} from "../lib/keyMapQuery";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KeyMapFuzzyPanel } from "./KeyMapFuzzyPanel";
import type { Workspace } from "../types/pipeline";
import {
  applyReviewBindingsForSide,
  buildApplyReviewState,
  confirmApplyReview,
  formatJoinOn,
  fromColumnsEff,
  fromPartsEff,
  keyMapSeedName,
  mergeLensOutputCells,
  outputColumnsEff,
  outputValuesEff,
  parseFromToPaste,
  tupleKey,
  validateKeyMapEntries,
  type ApplyReviewState,
  type ApplySide,
} from "../lib/keyMap";
import {
  KeyMapEditStore,
  KEYMAP_PAGE_SIZE,
  type EditorKeyMapEntry,
  type PageSlot,
  type RowId,
} from "../lib/keyMapDirty";
import {
  KeyMapBindWizard,
  applyKeyMapBind,
  type KeyMapBindResult,
} from "./KeyMapBindWizard";

export type KeyMapSourceOption = {
  source: string;
  table: string;
  label: string;
};

export type KeyMapEditorProps = {
  map: KeyMapDef;
  workspace?: Workspace;
  connections?: ConnectionDef[];
  /** Distinct partner keys for Pick To (optional). */
  pickToOptions?: string[];
  /** Prefill From rows (e.g. unmatched keys). */
  suggestedFrom?: string[];
  /** Prefill composite From tuples (ADR-0024). */
  suggestedFromParts?: string[][];
  /** Known dbt sources (Explorer / LoadPostgres) for storage=source datalist. */
  sourceOptions?: KeyMapSourceOption[];
  /** Postgres connections for source write-back / read. */
  postgresConnections?: ConnectionDef[];
  /** Candidate dbt model names for storage=ref combo. */
  refOptions?: string[];
  onChange: (map: KeyMapDef) => void;
  /** Fired after a successful warehouse read (optimistic concurrency token). */
  onWarehouseRead?: (contentHash: string, totalCount?: number | null) => void;
  /** Dirty delta for source Save (ADR-0022). */
  onDirtyChange?: (delta: KeyMapDirtyDelta | null) => void;
  /**
   * Save lifecycle: one in-flight capture per map. `captureSave` returns
   * `{ token, delta }` or `null` if already saving; confirm/abort take that token.
   */
  onSaveApi?: (api: {
    captureSave: () => { token: number; delta: KeyMapDirtyDelta | null } | null;
    confirmSave: (token: number) => void;
    abortSave: (token: number) => void;
    isSaving: () => boolean;
  }) => void;
  /** When true, Save button is disabled (App tracks in-flight WH write). */
  saveInFlight?: boolean;
  /** Bumped by App after WH Save when saveApi was absent (legacy clear). */
  dirtyResetSeq?: number;
  /**
   * Multi-output maps with a Join context open an inline review first
   * (ADR-0037); opts carry the confirmed destinations / Join rewrite.
   */
  onApply?: (
    side: ApplySide,
    opts?: {
      outputBindingsLeft?: import("../lib/keyMap").ApplyKeyMapOutputBinding[];
      outputBindingsRight?: import("../lib/keyMap").ApplyKeyMapOutputBinding[];
      joinRewrite?: { leftOn: string[]; rightOn: string[] };
    },
  ) => void;
  /** Create a Join-anchored mapping quality check for this KeyMap (ADR-0035). */
  onMappingCheck?: () => void;
  onClose?: () => void;
  onSave?: () => void;
  onDelete?: () => void;
  saveLabel?: string;
  /** Linked dbt export folder — drives seed SoT strip (ADR-0020). */
  exportPath?: string | null;
  /** Opened from Join Lens — show Apply guidance. */
  joinApplyHint?: string | null;
  /** Concrete Join Lens session — which query/keys Apply will touch. */
  joinApplyContext?: {
    hostQueryName: string;
    rightQueryName: string;
    leftOn: string;
    rightOn: string;
    leftOnCols?: string[];
    rightOnCols?: string[];
    /** Unmatched side that opened Add to map… */
    probeSide?: "left" | "right";
  } | null;
  /**
   * Opened via existing ApplyKeyMap preference — quiet escape hatch
   * to pick a different KeyMap / create new.
   */
  onChooseOtherMap?: () => void;
  /** Compact for Hero playground. */
  compact?: boolean;
  title?: string;
};

function storageKind(
  s: KeyMapStorage | undefined,
): "seed" | "ref" | "source" | "query" {
  return s?.kind ?? "seed";
}

export function KeyMapEditor({
  map,
  workspace,
  connections = [],
  pickToOptions = [],
  suggestedFrom = [],
  suggestedFromParts = [],
  sourceOptions = [],
  postgresConnections = [],
  refOptions = [],
  onChange,
  onWarehouseRead,
  onDirtyChange,
  onSaveApi,
  dirtyResetSeq,
  saveInFlight = false,
  onApply,
  onMappingCheck,
  onClose,
  onSave,
  onDelete,
  saveLabel = "Save map",
  exportPath = null,
  joinApplyHint = null,
  joinApplyContext = null,
  onChooseOtherMap,
  compact = false,
  title,
}: KeyMapEditorProps) {
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [showOtherApplySides, setShowOtherApplySides] = useState(false);
  /** ADR-0037 inline Apply+Join review (multi-output + Join context). */
  const [applyReview, setApplyReview] = useState<ApplyReviewState | null>(null);
  const [applyReviewError, setApplyReviewError] = useState<string | null>(null);
  const [pgTableOptions, setPgTableOptions] = useState<KeyMapSourceOption[]>(
    [],
  );
  const [pgCatalogStatus, setPgCatalogStatus] = useState<string | null>(null);
  const [rowsStatus, setRowsStatus] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [serverFilter, setServerFilter] = useState("");
  const [rebindOpen, setRebindOpen] = useState(false);
  const [dirtyTick, setDirtyTick] = useState(0);
  const loadedTableKey = useRef<string>("");
  const storeRef = useRef(new KeyMapEditStore());
  const pageRef = useRef<PageSlot[]>([]);
  const newIdsRef = useRef<RowId[]>([]);
  const dirtyResetSeen = useRef(dirtyResetSeq);
  const gridRef = useRef<HTMLDivElement>(null);
  const isSource = map.storage?.kind === "source";
  const rowsReadOnly = isQueryBackedMap(map);
  const [queryPreviewNote, setQueryPreviewNote] = useState<string | null>(null);
  const [queryPreviewBusy, setQueryPreviewBusy] = useState(false);
  const [queryColOptions, setQueryColOptions] = useState<string[]>([]);
  const [queryPreviewEntries, setQueryPreviewEntries] = useState<KeyMapEntry[]>(
    [],
  );
  const [queryReloadNonce, setQueryReloadNonce] = useState(0);
  const queryPreviewSeq = useRef(0);
  const rangeCols =
    map.time_mode === "range_scd"
      ? [
          map.valid_from_column?.trim() || "valid_from",
          map.valid_to_column?.trim() || "valid_to",
        ]
      : [];
  /** Grid attr columns = SCD bounds (if any) + editable attrs (ADR-0028). */
  const editableCols = [
    ...rangeCols,
    ...(map.editable_columns ?? []).filter(
      (c) => !rangeCols.some((r) => r.toLowerCase() === c.toLowerCase()),
    ),
  ];
  const fromCols = fromColumnsEff(map);
  const arity = fromCols.length;
  const outCols = outputColumnsEff(map);
  const outArity = outCols.length;
  const validateOpts = {
    outputArity: outArity,
    timeMode: map.time_mode === "range_scd" ? ("range_scd" as const) : ("none" as const),
    validFromColumn: map.valid_from_column ?? "valid_from",
    validToColumn: map.valid_to_column ?? "valid_to",
  };
  function validateEntries(entries: typeof map.entries) {
    return validateKeyMapEntries(entries, arity, validateOpts);
  }
  const saving = saveInFlight || storeRef.current.isSaveInFlight();
  const duplicateMapColumn = (() => {
    const seen = new Set<string>();
    for (const c of [...fromCols, ...outCols]) {
      const k = c.trim().toLowerCase();
      if (!k) continue;
      if (seen.has(k)) return c;
      seen.add(k);
    }
    return null;
  })();

  /**
   * ADR-0037: change the ordered output set. Entries' `output_values` stay
   * aligned by position (rename keeps values; add pads; remove drops that slot).
   * Source maps with dirty rows need explicit discard; Cancel keeps the prior
   * binding (no `onChange`).
   */
  function commitOutputColumns(
    next: string[],
    kind: "add" | "rename" | "remove",
    removedIdx?: number,
  ) {
    if (!next.length) return;
    if (isSource) {
      if (saving) {
        setError("Wait for Save to finish before changing output columns.");
        return;
      }
      const dirty = storeRef.current.dirtyCount();
      if (dirty > 0) {
        const ok = window.confirm(
          `Changing output columns discards ${dirty} unsaved row(s) and reloads from the warehouse. Continue?`,
        );
        if (!ok) return; // Cancel: prior binding stays
      }
      storeRef.current.clear();
      pageRef.current = [];
      newIdsRef.current = [];
      loadedTableKey.current = "";
      bumpDirty();
    }
    const pad = (values: string[]): string[] => {
      let out = [...values];
      if (kind === "remove" && removedIdx !== undefined) {
        out = out.filter((_, j) => j !== removedIdx);
      }
      out = out.slice(0, next.length);
      while (out.length < next.length) out.push("");
      return out;
    };
    setError(null);
    onChange({
      ...map,
      output_columns: next,
      to_column: next[0],
      entries: (isSource ? [] : map.entries).map((e) => {
        const outputs = pad(outputValuesEff(e));
        return { ...e, to: outputs[0] ?? "", output_values: outputs };
      }),
    });
  }

  useEffect(() => {
    storeRef.current.setSchema({
      arity,
      editable: editableCols,
      outputColumns: outCols,
    });
  }, [arity, editableCols, outCols]);

  // ADR-0036: describe map query columns + refresh read-only preview rows.
  useEffect(() => {
    if (!rowsReadOnly || !workspace || map.storage?.kind !== "query") {
      setQueryColOptions([]);
      return;
    }
    const qid = map.storage.query_id.trim();
    if (!qid) return;
    const seq = ++queryPreviewSeq.current;
    setQueryPreviewBusy(true);
    setQueryPreviewNote(null);
    void (async () => {
      try {
        const focused = {
          ...workspace,
          focus_query_id: qid,
        };
        const desc = await describeWorkspace(focused, connections, []);
        if (seq !== queryPreviewSeq.current) return;
        setQueryColOptions(desc.columns.map((c) => c.name));
        const previewQ = queryMapPreviewQuery(map, 50);
        if (!previewQ) return;
        const ws = {
          ...workspace,
          focus_query_id: previewQ.id,
          queries: [
            ...workspace.queries.filter((q) => q.id !== previewQ.id),
            previewQ,
          ],
        };
        const result = await previewWorkspace(ws, connections, []);
        if (seq !== queryPreviewSeq.current) return;
        const fromN = fromColumnsEff(map).length;
        const outN = outputColumnsEff(map).length;
        const rows = result.rows.map((r) =>
          Array.from({ length: fromN + outN }, (_, i) => {
            const v = r[i];
            return v == null ? null : String(v);
          }),
        );
        const checked = validateQueryMapRows(map.id, fromN, rows, outN);
        const entries = result.rows.map((r) => {
          const parts = Array.from({ length: fromN }, (_, i) =>
            String(r[i] ?? ""),
          );
          const outputs = Array.from({ length: outN }, (_, o) =>
            String(r[fromN + o] ?? ""),
          );
          return {
            from: parts[0] ?? "",
            from_parts: parts,
            to: outputs[0] ?? "",
            output_values: outputs,
          } satisfies KeyMapEntry;
        });
        // Do not persist preview rows into the project map (ADR-0036).
        setQueryPreviewEntries(entries);
        setQueryPreviewNote(
          checked.ok
            ? `Preview ${entries.length} row(s) · full Apply uses entire query`
            : `Preview loaded — validation: ${checked.error}`,
        );
      } catch (e) {
        if (seq !== queryPreviewSeq.current) return;
        setQueryPreviewNote(typeof e === "string" ? e : String(e));
      } finally {
        if (seq === queryPreviewSeq.current) setQueryPreviewBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on binding identity
  }, [
    rowsReadOnly,
    map.storage?.kind === "query" ? map.storage.query_id : "",
    (map.from_columns ?? []).join(","),
    map.from_column,
    map.to_column,
    (map.output_columns ?? []).join(","),
    queryReloadNonce,
  ]);

  function publishView() {
    if (!isSource) return;
    const entries = storeRef.current.viewEntries(
      pageRef.current,
      newIdsRef.current,
    );
    onChange({ ...map, entries });
  }

  function bumpDirty() {
    onDirtyChange?.(storeRef.current.toDelta());
    setDirtyTick((n) => n + 1);
  }

  function afterSaveSettle() {
    newIdsRef.current = newIdsRef.current.filter((id) =>
      storeRef.current.get(id),
    );
    onDirtyChange?.(storeRef.current.toDelta());
    publishView();
    setDirtyTick((n) => n + 1);
  }

  useEffect(() => {
    if (!onSaveApi) return;
    onSaveApi({
      captureSave: () => {
        const cap = storeRef.current.captureSave();
        if (!cap) return null;
        onDirtyChange?.(cap.delta);
        setDirtyTick((n) => n + 1);
        return { token: cap.token, delta: cap.delta };
      },
      confirmSave: (token: number) => {
        storeRef.current.confirmSave(token);
        afterSaveSettle();
      },
      abortSave: (token: number) => {
        storeRef.current.abortSave(token);
        afterSaveSettle();
      },
      isSaving: () => storeRef.current.isSaveInFlight(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable API registration
  }, [onSaveApi, map.id]);

  // Legacy path when Save succeeds without saveApi (editor not mounted).
  useEffect(() => {
    if (dirtyResetSeq === undefined) return;
    if (dirtyResetSeen.current === dirtyResetSeq) return;
    dirtyResetSeen.current = dirtyResetSeq;
    storeRef.current.clear();
    pageRef.current = [];
    newIdsRef.current = [];
    afterSaveSettle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyResetSeq]);

  // Never invent a connection_id — empty means "not assigned for write".
  const activeConnectionId =
    map.storage?.kind === "source" ? map.storage.connection_id?.trim() ?? "" : "";

  useEffect(() => {
    if (map.storage?.kind !== "source") {
      setPgTableOptions([]);
      setPgCatalogStatus(null);
      return;
    }
    const conn = postgresConnections.find((c) => c.id === activeConnectionId);
    const dsn = conn?.postgres?.connection_string?.trim();
    if (!dsn) {
      setPgTableOptions([]);
      setPgCatalogStatus(
        postgresConnections.length === 0
          ? "No Postgres connection"
          : "Connection has no DSN",
      );
      return;
    }
    let cancelled = false;
    setPgCatalogStatus("Loading schemas…");
    void listPostgresObjects(dsn)
      .then((list) => {
        if (cancelled) return;
        setPgTableOptions(
          list.map((o) => ({
            source: o.schema,
            table: o.name,
            label: `${o.schema}.${o.name}`,
          })),
        );
        setPgCatalogStatus(
          list.length === 0 ? "No tables/views on this connection" : null,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setPgTableOptions([]);
        setPgCatalogStatus(typeof e === "string" ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [map.storage?.kind, activeConnectionId, postgresConnections]);

  // Debounce filter → server prefix for source maps.
  useEffect(() => {
    if (!isSource) return;
    const t = window.setTimeout(() => {
      setServerFilter(filter.trim());
      setPageOffset(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [filter, isSource]);

  // Paged WH read when schema+table are chosen (ADR-0022).
  useEffect(() => {
    if (map.storage?.kind !== "source") {
      loadedTableKey.current = "";
      setRowsStatus(null);
      setTotalCount(null);
      return;
    }
    const { source, table } = map.storage;
    if (!source.trim() || !table.trim() || !activeConnectionId) return;
    const conn = postgresConnections.find((c) => c.id === activeConnectionId);
    const dsn = conn?.postgres?.connection_string?.trim();
    if (!dsn) return;
    const key = [
      activeConnectionId,
      source,
      table,
      map.from_column ?? "from",
      (map.from_columns ?? []).join(","),
      map.to_column ?? "to",
      outCols.join(","),
      (map.editable_columns ?? []).join(","),
      pageOffset,
      serverFilter,
      reloadNonce,
    ].join("|");
    if (loadedTableKey.current === key) return;
    loadedTableKey.current = key;
    let cancelled = false;
    setRowsStatus("Loading rows…");
    void readKeyMap(
      {
        ...map,
        storage: {
          kind: "source",
          source,
          table,
          connection_id: activeConnectionId,
        },
      },
      dsn,
      {
        limit: KEYMAP_PAGE_SIZE,
        offset: pageOffset,
        fromPrefix: serverFilter || undefined,
      },
    )
      .then((r) => {
        if (cancelled) return;
        pageRef.current = storeRef.current.adoptPage(
          r.entries,
          pageRef.current,
        );
        // Keep in-page inserts that are still dirty.
        newIdsRef.current = newIdsRef.current.filter((id) =>
          storeRef.current.get(id),
        );
        const entries = storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        );
        onChange({ ...map, entries });
        onWarehouseRead?.(r.content_hash, r.total_count);
        setTotalCount(r.total_count ?? null);
        const total = r.total_count;
        setRowsStatus(
          r.entries.length === 0
            ? "No rows on this page — add below or clear filter"
            : total != null
              ? `Page ${Math.floor(pageOffset / KEYMAP_PAGE_SIZE) + 1} · ${r.entries.length} shown · ${total} total`
              : `Loaded ${r.entries.length} rows`,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setRowsStatus(
          typeof e === "string" ? e : `Could not load rows: ${String(e)}`,
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when binding/page/filter changes
  }, [
    map.storage,
    map.from_column,
    map.from_columns,
    map.to_column,
    map.output_columns,
    map.editable_columns,
    activeConnectionId,
    postgresConnections,
    reloadNonce,
    pageOffset,
    serverFilter,
  ]);

  const tableOptions = useMemo(() => {
    const byKey = new Map<string, KeyMapSourceOption>();
    for (const o of [...sourceOptions, ...pgTableOptions]) {
      byKey.set(`${o.source}\0${o.table}`, o);
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [sourceOptions, pgTableOptions]);

  const schemaOptions = useMemo(() => {
    const set = new Set(tableOptions.map((o) => o.source));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tableOptions]);

  const selectedSchema =
    map.storage?.kind === "source" ? map.storage.source : "";

  const tablesInSchema = useMemo(() => {
    if (!selectedSchema) return [];
    return tableOptions
      .filter((o) => o.source === selectedSchema)
      .map((o) => o.table)
      .sort((a, b) => a.localeCompare(b));
  }, [tableOptions, selectedSchema]);

  const rows = useMemo(() => {
    const sourceEntries = rowsReadOnly ? queryPreviewEntries : map.entries;
    if (isSource) {
      // Server-side fromPrefix already applied.
      return map.entries.map((e, i) => ({ e, i }));
    }
    const q = filter.trim().toLowerCase();
    if (!q) return sourceEntries.map((e, i) => ({ e, i }));
    return sourceEntries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        const parts = fromPartsEff(e);
        return (
          parts.some((p) => p.toLowerCase().includes(q)) ||
          outputValuesEff(e).some((v) => v.toLowerCase().includes(q))
        );
      });
  }, [map.entries, filter, isSource, rowsReadOnly, queryPreviewEntries]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rows[index]!.i,
    getScrollElement: () => gridRef.current,
    estimateSize: () => compact ? 38 : 42,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();

  function setEntries(entries: KeyMapEntry[]) {
    const v = validateEntries(entries);
    if (!v.ok) {
      setError(v.error);
      onChange({ ...map, entries });
      return;
    }
    setError(null);
    onChange({ ...map, entries: v.entries });
  }

  function padOutputs(values: string[]): string[] {
    const out = values.slice(0, outArity);
    while (out.length < outArity) out.push("");
    return out;
  }

  function setOutput(index: number, oi: number, value: string) {
    const prev = map.entries[index];
    if (!prev) return;
    const outs = padOutputs(outputValuesEff(prev));
    outs[oi] = value;
    updateRow(index, { to: outs[0] ?? "", output_values: outs });
  }

  function updateRow(index: number, patch: Partial<KeyMapEntry>) {
    const raw = map.entries[index] as EditorKeyMapEntry | undefined;
    if (!raw) return;
    const rowId = raw.__dwhRowId;
    const merged: EditorKeyMapEntry = {
      ...raw,
      ...patch,
      attrs:
        patch.attrs !== undefined
          ? patch.attrs
          : raw.attrs,
      ...(rowId ? { __dwhRowId: rowId } : {}),
    };
    if (patch.attrs === undefined && raw.attrs) {
      merged.attrs = { ...raw.attrs };
    }
    const next = map.entries.map((e, i) => (i === index ? merged : e));

    if (isSource && rowId) {
      const slot = pageRef.current.find((s) => s.id === rowId);
      storeRef.current.updateDraft(
        rowId,
        {
          fromParts: fromPartsEff(merged),
          outputs: padOutputs(outputValuesEff(merged)),
          attrs: merged.attrs ?? {},
        },
        slot?.loaded ?? null,
      );
      bumpDirty();
      // Allow temporarily invalid From/To in the view (draft store keeps them).
      setError(null);
      const v = validateEntries(next);
      if (!v.ok) {
        setError(v.error);
        onChange({ ...map, entries: next });
        return;
      }
      onChange({
        ...map,
        entries: storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        ),
      });
      return;
    }

    const v = validateEntries(next);
    if (!v.ok) {
      setError(v.error);
      onChange({ ...map, entries: next });
      return;
    }
    setError(null);
    onChange({ ...map, entries: v.entries });
  }

  function updateAttr(index: number, col: string, value: string) {
    const prev = map.entries[index];
    if (!prev) return;
    updateRow(index, {
      attrs: { ...(prev.attrs ?? {}), [col]: value },
    });
  }

  function addRow(from = "", to = "") {
    const parts =
      arity > 1
        ? Array.from({ length: arity }, (_, i) => (i === 0 ? from : ""))
        : from
          ? [from]
          : Array.from({ length: arity }, () => "");
    if (isSource) {
      const id = storeRef.current.addRow({
        fromParts: parts,
        outputs: padOutputs([to]),
        attrs: Object.fromEntries(editableCols.map((c) => [c, ""])),
      });
      newIdsRef.current = [...newIdsRef.current, id];
      bumpDirty();
      onChange({
        ...map,
        entries: storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        ),
      });
      return;
    }
    const entry: KeyMapEntry = {
      from: parts[0] ?? "",
      from_parts: parts,
      to,
      output_values: padOutputs([to]),
    };
    if (editableCols.length) {
      entry.attrs = Object.fromEntries(editableCols.map((c) => [c, ""]));
    }
    setEntries([...map.entries, entry]);
  }

  function deleteRow(index: number) {
    const raw = map.entries[index] as EditorKeyMapEntry | undefined;
    if (isSource && raw?.__dwhRowId) {
      const id = raw.__dwhRowId;
      const slot = pageRef.current.find((s) => s.id === id);
      storeRef.current.deleteRow(id, slot?.loaded ?? null);
      newIdsRef.current = newIdsRef.current.filter((x) => x !== id);
      bumpDirty();
      onChange({
        ...map,
        entries: storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        ),
      });
      return;
    }
    setEntries(map.entries.filter((_, j) => j !== index));
  }

  function addSuggested() {
    const have = new Set(map.entries.map((e) => tupleKey(fromPartsEff(e))));
    const fromTuples: string[][] =
      suggestedFromParts.length > 0
        ? suggestedFromParts
        : suggestedFrom.map((s) => [s.trim()]);
    const proposals = fromTuples
      .map((parts) => parts.map((p) => p.trim()))
      .filter((parts) => parts.every(Boolean) && !have.has(tupleKey(parts)))
      .map((parts) => ({ fromParts: parts, to: "" }));
    if (!proposals.length) return;
    if (isSource) {
      const { newIds } = storeRef.current.applyProposals(
        proposals,
        pageRef.current,
      );
      if (newIds.length) {
        newIdsRef.current = [...newIdsRef.current, ...newIds];
      }
      bumpDirty();
      onChange({
        ...map,
        entries: storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        ),
      });
      return;
    }
    const extra = proposals.map((p) => ({
      from: p.fromParts[0]!,
      from_parts: p.fromParts,
      to: "",
      output_values: padOutputs([]),
    }));
    setEntries([...map.entries, ...extra]);
  }

  function applyPaste() {
    const parsed = parseFromToPaste(pasteText, arity, outArity);
    if (!parsed.length) {
      setError("Paste TSV/CSV with from,to columns");
      return;
    }
    if (isSource) {
      for (const e of parsed) {
        const parts = fromPartsEff(e);
        const key = tupleKey(parts);
        const pageHit = pageRef.current.find(
          (s) => tupleKey(s.loaded.fromParts) === key,
        );
        const existingId =
          pageHit?.id ??
          storeRef.current.rowIdByOriginFrom(parts) ??
          (map.entries as EditorKeyMapEntry[]).find(
            (x) => tupleKey(fromPartsEff(x)) === key,
          )?.__dwhRowId;
        if (existingId) {
          storeRef.current.updateDraft(
            existingId,
            {
              fromParts: parts,
              outputs: padOutputs(outputValuesEff(e)),
              attrs: e.attrs ?? {},
            },
            pageHit?.loaded ?? null,
          );
        } else {
          const id = storeRef.current.addRow({
            fromParts: parts,
            outputs: padOutputs(outputValuesEff(e)),
            attrs: e.attrs ?? {},
          });
          newIdsRef.current.push(id);
        }
      }
      bumpDirty();
      onChange({
        ...map,
        entries: storeRef.current.viewEntries(
          pageRef.current,
          newIdsRef.current,
        ),
      });
      setPasteOpen(false);
      setPasteText("");
      return;
    }
    const merged = [...map.entries];
    const byFrom = new Map(
      merged.map((e, i) => [tupleKey(fromPartsEff(e)), i] as const),
    );
    for (const e of parsed) {
      const i = byFrom.get(tupleKey(fromPartsEff(e)));
      if (i === undefined) {
        byFrom.set(tupleKey(fromPartsEff(e)), merged.length);
        merged.push(e);
      } else {
        merged[i] = e;
      }
    }
    setEntries(merged);
    setPasteOpen(false);
    setPasteText("");
  }

  function onCellKeyDown(
    e: KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    col: "from" | "to",
    outIdx = 0,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      const lastOut = col === "to" && outIdx >= outArity - 1;
      if (rowIndex === map.entries.length - 1 && lastOut) {
        addRow();
        return;
      }
      if (col === "from") {
        (
          e.currentTarget
            .closest("tr")
            ?.querySelector<HTMLInputElement>('input[data-col="to"]') ?? null
        )?.focus();
      } else if (!lastOut) {
        (
          e.currentTarget
            .closest("tr")
            ?.querySelector<HTMLInputElement>(
              `input[data-col="to-${outIdx + 1}"]`,
            ) ?? null
        )?.focus();
      } else {
        const next = e.currentTarget
          .closest("tr")
          ?.nextElementSibling?.querySelector<HTMLInputElement>(
            'input[data-col="from"]',
          );
        next?.focus();
      }
    }
  }

  const fieldClass =
    "mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-[12px] text-slate-100";
  const labelClass = "block text-[11px] font-medium text-slate-400";

  const seedName = keyMapSeedName(map.id);
  const sourceStorage =
    map.storage?.kind === "source" ? map.storage : null;
  const refStorage = map.storage?.kind === "ref" ? map.storage : null;
  const queryStorage =
    map.storage?.kind === "query" ? map.storage : null;
  const kind = storageKind(map.storage);
  const sotLine = (() => {
    if (kind === "source") {
      const loc =
        sourceStorage?.source && sourceStorage?.table
          ? `${sourceStorage.source}.${sourceStorage.table}`
          : "pick schema.table";
      return {
        label: "SoT · warehouse table",
        detail: `${loc} · Save upserts dirty From keys only`,
      };
    }
    if (kind === "ref") {
      return {
        label: "SoT · dbt ref (export only)",
        detail: refStorage?.model?.trim()
          ? `{{ ref('${refStorage.model}') }} · DuckDB preview cannot resolve this model; local rows are a draft cache, not the relation`
          : "set model name · local cache is not the dbt model",
      };
    }
    if (kind === "query") {
      const q = workspace?.queries.find(
        (x) => x.id === queryStorage?.query_id,
      );
      return {
        label: "SoT · workspace query",
        detail: q
          ? `${q.name} (${q.id}) · read-only · Apply joins live result (ADR-0036)`
          : queryStorage?.query_id
            ? `missing query ${queryStorage.query_id}`
            : "pick a local query",
      };
    }
    if (exportPath) {
      return {
        label: "SoT · export seed",
        detail: `seeds/${seedName}.csv · Save pushes CSV into linked export`,
      };
    }
    return {
      label: "SoT · project",
      detail: `not exported yet · Export creates seeds/${seedName}.csv`,
    };
  })();
  const settingsPanel = !compact && (
    <div className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-slate-800 p-4 md:w-72 md:border-r lg:w-80">
      <label className={labelClass}>
        Name
        <input
          value={map.name}
          onChange={(e) => onChange({ ...map, name: e.target.value })}
          className={fieldClass}
        />
      </label>
      {(map.storage?.kind ?? "seed") === "seed" && (
        <p className="text-[10px] leading-snug text-slate-600">
          Export seed:{" "}
          <span className="font-mono text-slate-500">
            seeds/{seedName}.csv
          </span>
        </p>
      )}
      <label className={labelClass}>
        Storage
        <select
          value={storageKind(map.storage)}
          onChange={(e) => {
            if (saving) return;
            const next = e.target.value as "seed" | "ref" | "source" | "query";
            const storage: KeyMapStorage =
              next === "seed"
                ? { kind: "seed" }
                : next === "ref"
                  ? { kind: "ref", model: "" }
                  : next === "query"
                    ? {
                        kind: "query",
                        query_id: workspace?.queries[0]?.id ?? "",
                      }
                    : {
                        kind: "source",
                        source: "",
                        table: "",
                      };
            onChange({
              ...map,
              storage,
              entries: next === "query" ? [] : map.entries,
              editable_columns: next === "query" ? [] : map.editable_columns,
              time_mode: next === "query" ? "none" : map.time_mode,
            });
            if (next === "source") setRebindOpen(true);
          }}
          disabled={saving}
          className={fieldClass}
        >
          <option value="seed">dbt seed (seeds/map_*.csv)</option>
          <option value="ref">Existing dbt ref(model)</option>
          <option value="source">Warehouse source table</option>
          <option value="query">Workspace query (ADR-0036)</option>
        </select>
      </label>
      {queryStorage && (
        <div className="space-y-3">
          <p className="rounded border border-teal-900/50 bg-teal-950/25 px-2 py-1.5 text-[10px] leading-snug text-teal-100/90">
            Correspondences come from the selected query. Rows are read-only;
            Save stores the binding only — not query results (ADR-0036).
          </p>
          <label className={labelClass}>
            Query
            <select
              value={queryStorage.query_id}
              onChange={(e) =>
                onChange({
                  ...map,
                  storage: { kind: "query", query_id: e.target.value },
                  from_columns: [],
                  from_column: "from",
                  to_column: "to",
                  output_columns: ["to"],
                  entries: [],
                })
              }
              className={fieldClass}
            >
              <option value="">Select query…</option>
              {(workspace?.queries ?? []).map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name} ({q.id})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {refStorage && (
        <>
          <p className="rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-[10px] leading-snug text-amber-100/90">
            Export joins{" "}
            <span className="font-mono">
              {`{{ ref('${refStorage.model?.trim() || "…"}') }}`}
            </span>
            . Preview will refuse ApplyKeyMap for this map — local rows below are
            a draft cache only (not write-back, not live preview).
          </p>
          <label className={labelClass}>
            Model
            <input
              list="keymap-ref-models"
              value={refStorage.model}
              onChange={(e) =>
                onChange({
                  ...map,
                  storage: { kind: "ref", model: e.target.value },
                })
              }
              placeholder="stg_channel_map"
              className={`${fieldClass} font-mono`}
            />
            {refOptions.length > 0 && (
              <datalist id="keymap-ref-models">
                {refOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </label>
        </>
      )}
      {sourceStorage && (
        <div className="space-y-3">
          <label className={labelClass}>
            Connection
            <select
              value={activeConnectionId}
              onChange={(e) =>
                onChange({
                  ...map,
                  storage: {
                    kind: "source",
                    source: sourceStorage.source,
                    table: sourceStorage.table,
                    connection_id: e.target.value || undefined,
                  },
                })
              }
              className={fieldClass}
            >
              <option value="">
                {postgresConnections.length === 0
                  ? "No Postgres connection"
                  : "Select connection…"}
              </option>
              {postgresConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Schema
            <select
              value={
                schemaOptions.includes(sourceStorage.source)
                  ? sourceStorage.source
                  : sourceStorage.source
                    ? "__custom__"
                    : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                const connection_id = activeConnectionId || undefined;
                if (!v || v === "__custom__") {
                  if (v === "__custom__") return;
                  onChange({
                    ...map,
                    storage: {
                      kind: "source",
                      source: "",
                      table: "",
                      connection_id,
                    },
                  });
                  return;
                }
                onChange({
                  ...map,
                  storage: {
                    kind: "source",
                    source: v,
                    table: "",
                    connection_id,
                  },
                });
              }}
              className={`${fieldClass} font-mono`}
            >
              <option value="">Pick schema…</option>
              {schemaOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {sourceStorage.source &&
                !schemaOptions.includes(sourceStorage.source) && (
                  <option value="__custom__">
                    {sourceStorage.source} (custom)
                  </option>
                )}
            </select>
          </label>
          <label className={labelClass}>
            Table
            <select
              value={
                tablesInSchema.includes(sourceStorage.table)
                  ? sourceStorage.table
                  : sourceStorage.table
                    ? "__custom__"
                    : ""
              }
              disabled={!sourceStorage.source}
              onChange={(e) => {
                const v = e.target.value;
                if (!v || v === "__custom__") {
                  if (v === "__custom__") return;
                  onChange({
                    ...map,
                    storage: {
                      kind: "source",
                      source: sourceStorage.source,
                      table: "",
                      connection_id: activeConnectionId || undefined,
                    },
                  });
                  return;
                }
                onChange({
                  ...map,
                  storage: {
                    kind: "source",
                    source: sourceStorage.source,
                    table: v,
                    connection_id: activeConnectionId || undefined,
                  },
                });
              }}
              className={`${fieldClass} font-mono disabled:opacity-40`}
            >
              <option value="">
                {sourceStorage.source
                  ? "Pick table…"
                  : "Select schema first"}
              </option>
              {tablesInSchema.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {sourceStorage.table &&
                !tablesInSchema.includes(sourceStorage.table) && (
                  <option value="__custom__">
                    {sourceStorage.table} (custom)
                  </option>
                )}
            </select>
          </label>
          {pgCatalogStatus && (
            <p className="text-[11px] text-slate-500">{pgCatalogStatus}</p>
          )}
          <p className="text-[11px] leading-snug text-teal-400/85">
            Edit the grid, then save — dirty-delta upsert to{" "}
            <span className="font-mono">
              {sourceStorage.source || "?"}.{sourceStorage.table || "?"}
            </span>
            .
          </p>
          <button
            type="button"
            onClick={() => setRebindOpen(true)}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-300 hover:border-teal-700 hover:text-teal-100"
          >
            Rebind…
          </button>
        </div>
      )}
      {refStorage && (
        <p className="text-[11px] leading-snug text-slate-500">
          ref storage: rows are project cache only (no warehouse write-back).
        </p>
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className={labelClass}>Match by columns</span>
          <button
            type="button"
            onClick={() => {
              const next = [...fromCols, `from_${fromCols.length + 1}`];
              onChange({
                ...map,
                from_columns: next,
                from_column: next[0],
                entries: map.entries.map((e) => {
                  const parts = fromPartsEff(e);
                  while (parts.length < next.length) parts.push("");
                  return {
                    ...e,
                    from: parts[0] ?? "",
                    from_parts: parts,
                  };
                }),
              });
            }}
            className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-teal-200"
          >
            + Column
          </button>
        </div>
        {queryColOptions.length > 0 && (
          <datalist id={`keymap-query-cols-${map.id}`}>
            {queryColOptions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        )}
        {fromCols.map((col, i) => (
          <label key={`from-col-${i}`} className={labelClass}>
            Match[{i + 1}]
            <div className="mt-1 flex gap-1">
              <input
                list={
                  queryColOptions.length
                    ? `keymap-query-cols-${map.id}`
                    : undefined
                }
                value={col}
                onChange={(e) => {
                  const next = [...fromCols];
                  next[i] = e.target.value;
                  onChange({
                    ...map,
                    from_columns: next,
                    from_column: next[0],
                  });
                }}
                className={`${fieldClass} mt-0 font-mono`}
              />
              {fromCols.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    const next = fromCols.filter((_, j) => j !== i);
                    onChange({
                      ...map,
                      from_columns: next,
                      from_column: next[0],
                      entries: map.entries.map((e) => {
                        const parts = fromPartsEff(e).filter((_, j) => j !== i);
                        return {
                          ...e,
                          from: parts[0] ?? "",
                          from_parts: parts,
                        };
                      }),
                    });
                  }}
                  className="rounded border border-slate-700 px-2 text-slate-500 hover:text-rose-300"
                  aria-label="Remove match column"
                >
                  ×
                </button>
              )}
            </div>
          </label>
        ))}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className={labelClass}>Output columns</span>
          <button
            type="button"
            onClick={() => {
              const used = new Set(
                [...fromCols, ...outCols].map((c) => c.toLowerCase()),
              );
              let n = outCols.length + 1;
              while (used.has(`to_${n}`)) n += 1;
              commitOutputColumns([...outCols, `to_${n}`], "add");
            }}
            className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-teal-200"
          >
            + Output
          </button>
        </div>
        {outCols.map((col, i) => (
          <label key={`out-col-${i}`} className={labelClass}>
            Output[{i + 1}]
            <div className="mt-1 flex gap-1">
              <input
                list={
                  queryColOptions.length
                    ? `keymap-query-cols-${map.id}`
                    : undefined
                }
                value={col}
                onChange={(e) => {
                  const next = [...outCols];
                  next[i] = e.target.value;
                  commitOutputColumns(next, "rename");
                }}
                className={`${fieldClass} mt-0 font-mono`}
              />
              {outCols.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    commitOutputColumns(
                      outCols.filter((_, j) => j !== i),
                      "remove",
                      i,
                    )
                  }
                  className="rounded border border-slate-700 px-2 text-slate-500 hover:text-rose-300"
                  aria-label="Remove output column"
                >
                  ×
                </button>
              )}
            </div>
          </label>
        ))}
        {duplicateMapColumn && (
          <p className="text-[11px] text-amber-300/90">
            Duplicate map column “{duplicateMapColumn}” — names must be unique
            across match and output columns.
          </p>
        )}
      </div>
      {!rowsReadOnly && (
      <div className="space-y-2 border-t border-slate-800/80 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className={labelClass}>Attribute columns</span>
          <button
            type="button"
            onClick={() => {
              const base = `attr_${(map.editable_columns ?? []).length + 1}`;
              const name =
                (map.editable_columns ?? []).includes("reason") ||
                (map.editable_columns ?? []).length > 0
                  ? base
                  : "reason";
              if ((map.editable_columns ?? []).includes(name)) return;
              onChange({
                ...map,
                editable_columns: [...(map.editable_columns ?? []), name],
              });
            }}
            className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-teal-200"
          >
            + Attr
          </button>
        </div>
        {(map.editable_columns ?? []).length === 0 ? (
          <p className="text-[11px] text-slate-500">
            Optional — e.g. reason, confidence. Not used in Join ON (ADR-0028).
          </p>
        ) : (
          (map.editable_columns ?? []).map((col, i) => (
            <div key={`attr-${i}`} className="flex gap-1">
              <input
                value={col}
                onChange={(e) => {
                  const next = [...(map.editable_columns ?? [])];
                  const prev = next[i]!;
                  next[i] = e.target.value;
                  onChange({
                    ...map,
                    editable_columns: next,
                    entries: map.entries.map((row) => {
                      if (!row.attrs || !(prev in row.attrs)) return row;
                      const attrs = { ...row.attrs };
                      const v = attrs[prev];
                      delete attrs[prev];
                      if (e.target.value.trim()) attrs[e.target.value] = v ?? "";
                      return { ...row, attrs };
                    }),
                  });
                }}
                className={`${fieldClass} mt-0 font-mono`}
              />
              <button
                type="button"
                onClick={() => {
                  const removed = (map.editable_columns ?? [])[i];
                  onChange({
                    ...map,
                    editable_columns: (map.editable_columns ?? []).filter(
                      (_, j) => j !== i,
                    ),
                    entries: map.entries.map((row) => {
                      if (!row.attrs || !removed) return row;
                      const attrs = { ...row.attrs };
                      delete attrs[removed];
                      return { ...row, attrs };
                    }),
                  });
                }}
                className="rounded border border-slate-700 px-2 text-slate-500 hover:text-rose-300"
                aria-label="Remove attribute column"
              >
                ×
              </button>
            </div>
          ))
        )}
        <label className={labelClass}>
          Time mode
          <select
            value={map.time_mode === "range_scd" ? "range_scd" : "none"}
            onChange={(e) => {
              const mode = e.target.value as "none" | "range_scd";
              onChange({
                ...map,
                time_mode: mode === "none" ? undefined : mode,
                valid_from_column:
                  mode === "range_scd"
                    ? map.valid_from_column ?? "valid_from"
                    : undefined,
                valid_to_column:
                  mode === "range_scd"
                    ? map.valid_to_column ?? "valid_to"
                    : undefined,
              });
            }}
            className={fieldClass}
          >
            <option value="none">None (unique From → To)</option>
            <option value="range_scd">
              Range SCD (valid_from / valid_to, half-open)
            </option>
          </select>
        </label>
        {map.time_mode === "range_scd" && (
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              valid_from column
              <input
                value={map.valid_from_column ?? "valid_from"}
                onChange={(e) =>
                  onChange({ ...map, valid_from_column: e.target.value })
                }
                className={`${fieldClass} font-mono`}
              />
            </label>
            <label className={labelClass}>
              valid_to column
              <input
                value={map.valid_to_column ?? "valid_to"}
                onChange={(e) =>
                  onChange({ ...map, valid_to_column: e.target.value })
                }
                className={`${fieldClass} font-mono`}
              />
            </label>
            <p className="col-span-2 text-[11px] leading-snug text-slate-500">
              Apply needs a fact <span className="font-mono">as_of_column</span>.
              Predicate:{" "}
              <span className="font-mono text-slate-400">
                event &gt;= from AND (to IS NULL OR event &lt; to)
              </span>
              .
            </p>
          </div>
        )}
      </div>
      )}
      <p className="text-[11px] leading-snug text-slate-500">
        Mapping relation column names. Arity {arity}: uniqueness is the match{" "}
        <span className="font-mono text-slate-400">key</span>
        {map.time_mode === "range_scd" ? " + non-overlapping ranges" : ""}{" "}
        (ADR-0024/0028). Seed header:{" "}
        <span className="font-mono text-slate-400">
          {[
            ...fromCols,
            ...outCols,
            ...(map.time_mode === "range_scd"
              ? [
                  map.valid_from_column ?? "valid_from",
                  map.valid_to_column ?? "valid_to",
                ]
              : []),
            ...(map.editable_columns ?? []),
          ].join(",")}
        </span>
        .
      </p>
    </div>
  );

  const toolbar = (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 ${
        compact ? "px-2 py-1.5" : "px-4 py-2.5"
      }`}
    >
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={isSource ? "Filter From prefix…" : "Filter rows…"}
        className={`rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-[12px] text-slate-200 ${
          compact ? "w-28 py-0.5 text-[11px]" : "w-48"
        }`}
      />
      {!rowsReadOnly && (
      <button
        type="button"
        onClick={() => addRow()}
        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-200 hover:border-teal-600 hover:text-teal-100"
      >
        Add row
      </button>
      )}
      {rowsReadOnly && (
        <button
          type="button"
          disabled={queryPreviewBusy}
          onClick={() => setQueryReloadNonce((n) => n + 1)}
          className="rounded-md border border-teal-800/50 px-2.5 py-1.5 text-[12px] text-teal-200 hover:bg-teal-500/10 disabled:opacity-40"
        >
          {queryPreviewBusy ? "Refreshing…" : "Refresh"}
        </button>
      )}
      {map.storage?.kind === "source" &&
        map.storage.source &&
        map.storage.table && (
          <button
            type="button"
            onClick={() => {
              storeRef.current.clear();
              pageRef.current = [];
              newIdsRef.current = [];
              bumpDirty();
              loadedTableKey.current = "";
              setRowsStatus(null);
              setPageOffset(0);
              setReloadNonce((n) => n + 1);
            }}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-400 hover:border-teal-700 hover:text-teal-200"
          >
            Reload
          </button>
        )}
      {(suggestedFromParts.length > 0 || suggestedFrom.length > 0) && (
        <button
          type="button"
          onClick={addSuggested}
          className="rounded-md border border-amber-900/50 px-2.5 py-1.5 text-[12px] text-amber-200/90 hover:border-amber-700"
        >
          Add unmatched (
          {suggestedFromParts.length > 0
            ? suggestedFromParts.length
            : suggestedFrom.length}
          )
        </button>
      )}
      {!rowsReadOnly && (
      <button
        type="button"
        onClick={() => setPasteOpen((v) => !v)}
        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
      >
        Paste CSV
      </button>
      )}
      {queryPreviewNote && (
        <span className="max-w-md truncate text-[11px] text-slate-500" title={queryPreviewNote}>
          {queryPreviewNote}
        </span>
      )}
      <span className="text-[11px] text-slate-500">
        {isSource
          ? `${map.entries.length} on page`
          : filter.trim()
            ? `${rows.length} / ${map.entries.length} rows`
            : `${map.entries.length} rows`}
        {dirtyTick >= 0 && storeRef.current.dirtyCount() > 0
          ? ` · ${storeRef.current.dirtyCount()} dirty`
          : ""}
      </span>
      {isSource && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            disabled={pageOffset <= 0}
            onClick={() => {
              loadedTableKey.current = "";
              setPageOffset((o) => Math.max(0, o - KEYMAP_PAGE_SIZE));
            }}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 disabled:opacity-30"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={
              totalCount != null
                ? pageOffset + KEYMAP_PAGE_SIZE >= totalCount
                : map.entries.length < KEYMAP_PAGE_SIZE
            }
            onClick={() => {
              loadedTableKey.current = "";
              setPageOffset((o) => o + KEYMAP_PAGE_SIZE);
            }}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 disabled:opacity-30"
          >
            Next
          </button>
        </span>
      )}
      {rowsStatus && (
        <span className="max-w-md truncate text-[11px] text-slate-500">
          {rowsStatus}
        </span>
      )}
    </div>
  );

  const grid = (
    <div ref={gridRef} className="min-h-0 flex-1 overflow-auto">
      <table
        className={`w-full border-collapse text-left ${
          compact ? "text-[11px]" : "text-[13px]"
        }`}
      >
        <thead className="sticky top-0 z-10 bg-[#0a1520] text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-10 px-3 py-2 font-semibold">#</th>
            {fromCols.map((col, fi) => (
              <th key={`fh-${fi}`} className="px-3 py-2 font-semibold font-mono normal-case text-slate-300">
                {col || `match_${fi + 1}`}
              </th>
            ))}
            {outCols.map((col, oi) => (
              <th
                key={`oh-${oi}`}
                className="px-3 py-2 font-semibold font-mono normal-case text-slate-300"
              >
                {col.trim() || `output_${oi + 1}`}
              </th>
            ))}
            {editableCols.map((c) => (
              <th key={c} className="px-3 py-2 font-semibold font-mono normal-case">
                {c}
              </th>
            ))}
            <th className="w-12" />
          </tr>
        </thead>
        <tbody>
          {virtualRows.length > 0 && virtualRows[0]!.start > 0 && <tr aria-hidden="true"><td colSpan={2 + fromCols.length + outArity + editableCols.length} style={{height: virtualRows[0]!.start, padding: 0}} /></tr>}
          {virtualRows.map((v) => { const {e,i}=rows[v.index]!; return (
            <tr
              key={i}
              style={{height: compact ? 38 : 42}}
              className="border-t border-slate-800/60 hover:bg-slate-900/40"
            >
              <td className="px-3 py-1 font-mono text-[11px] text-slate-600">
                {i + 1}
              </td>
              {fromCols.map((_, fi) => {
                const parts = fromPartsEff(e);
                return (
                  <td key={`fc-${fi}`} className="px-2 py-1">
                    <input
                      data-col={fi === 0 ? "from" : `from-${fi}`}
                      value={parts[fi] ?? ""}
                      onChange={(ev) => {
                        const nextParts = [...fromPartsEff(e)];
                        while (nextParts.length < arity) nextParts.push("");
                        nextParts[fi] = ev.target.value;
                        updateRow(i, {
                          from: nextParts[0] ?? "",
                          from_parts: nextParts,
                        });
                      }}
                      onKeyDown={(ev) =>
                        fi === 0
                          ? onCellKeyDown(ev, i, "from")
                          : undefined
                      }
                      className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-sky-200/90 focus:border-slate-600 focus:bg-slate-950"
                    />
                  </td>
                );
              })}
              {outCols.map((_, oi) => (
                <td key={`oc-${oi}`} className="px-2 py-1">
                  <input
                    data-col={oi === 0 ? "to" : `to-${oi}`}
                    list={
                      oi === 0 && pickToOptions.length > 0
                        ? `keymap-to-${map.id}`
                        : undefined
                    }
                    value={outputValuesEff(e)[oi] ?? ""}
                    onChange={(ev) => setOutput(i, oi, ev.target.value)}
                    onKeyDown={(ev) => onCellKeyDown(ev, i, "to", oi)}
                    className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-teal-200/90 focus:border-slate-600 focus:bg-slate-950"
                  />
                </td>
              ))}
              {editableCols.map((c) => (
                <td key={c} className="px-2 py-1">
                  <input
                    value={e.attrs?.[c] ?? ""}
                    onChange={(ev) => updateAttr(i, c, ev.target.value)}
                    className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-slate-300 focus:border-slate-600 focus:bg-slate-950"
                  />
                </td>
              ))}
              <td className="px-2 text-center">
                <button
                  type="button"
                  onClick={() => deleteRow(i)}
                  className="px-1 text-lg leading-none text-slate-600 hover:text-rose-400"
                  aria-label="Delete row"
                >
                  ×
                </button>
              </td>
            </tr>
          ); })}
          {virtualRows.length > 0 && <tr aria-hidden="true"><td colSpan={2 + fromCols.length + outArity + editableCols.length} style={{height: Math.max(0,virtualizer.getTotalSize()-virtualRows[virtualRows.length-1]!.end), padding: 0}} /></tr>}
        </tbody>
      </table>
      {pickToOptions.length > 0 && (
        <datalist id={`keymap-to-${map.id}`}>
          {pickToOptions.slice(0,1000).map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      {map.entries.length === 0 && (
        <p className="px-6 py-10 text-center text-[13px] text-slate-600">
          No rows yet — Add row, paste CSV, or pick schema/table to load from
          warehouse
        </p>
      )}
    </div>
  );

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-teal-900/50 bg-[#071018] shadow-2xl shadow-black/40 ${
        compact ? "max-h-[22rem]" : ""
      }`}
    >
      <div
        className={`flex shrink-0 items-center gap-3 border-b border-slate-800 ${
          compact ? "px-3 py-2" : "px-4 py-3"
        }`}
      >
        <div className="min-w-0 flex-1 text-left">
          <div
            className={`truncate font-semibold text-slate-100 ${
              compact ? "text-sm" : "text-base"
            }`}
          >
            {title ?? map.name}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500">
            {map.id}
            {map.storage?.kind === "source" &&
              map.storage.source &&
              map.storage.table && (
                <span className="text-slate-600">
                  {" "}
                  · {map.storage.source}.{map.storage.table}
                </span>
              )}
          </div>
        </div>
        {onMappingCheck && (
          <button
            type="button"
            onClick={onMappingCheck}
            className="rounded-md border border-teal-800/50 bg-teal-500/10 px-2.5 py-1 text-[12px] font-medium text-teal-200 hover:bg-teal-500/20"
            title="Open mapping quality overview for a Join that ApplyKeyMap-wires this map"
          >
            Mapping check…
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            Close
          </button>
        )}
      </div>

      {!compact && joinApplyHint && onApply && (
        <div className="shrink-0 border-b border-amber-900/40 bg-amber-950/30 px-4 py-2 text-[12px] leading-snug text-amber-100/90">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1">
              <span className="font-semibold text-amber-200">From Join Lens</span>
              {" — "}
              {joinApplyHint}
            </p>
            {onChooseOtherMap && (
              <button
                type="button"
                onClick={onChooseOtherMap}
                className="shrink-0 text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
              >
                Use a different mapping…
              </button>
            )}
          </div>
        </div>
      )}

      {!compact && (
        <div
          className="flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-slate-800/80 bg-slate-950/50 px-4 py-1.5"
          title={exportPath ?? undefined}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-teal-400/85">
            {sotLine.label}
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            {sotLine.detail}
          </span>
        </div>
      )}

      <div
        className={`flex min-h-0 flex-1 ${
          compact ? "flex-col" : "flex-col md:flex-row"
        }`}
      >
        {settingsPanel}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {toolbar}
          {!compact && workspace && !rowsReadOnly && <KeyMapFuzzyPanel
            key={map.id}
            workspace={workspace}
            connections={connections}
            onAccept={(suggestions) => {
              if (!isSource) {
                const merged = [...map.entries];
                const byFrom = new Map(
                  merged.map((e, i) => [tupleKey(fromPartsEff(e)), i] as const),
                );
                for (const s of suggestions) {
                  if (s.ambiguous) continue;
                  const parts =
                    s.from_parts?.length
                      ? s.from_parts
                      : s.from_key.trim()
                        ? [s.from_key]
                        : [];
                  if (!parts.length || !s.to_key.trim()) continue;
                  const key = tupleKey(parts);
                  const i = byFrom.get(key);
                  if (
                    i !== undefined &&
                    outputValuesEff(merged[i]!).some((v) => v.trim())
                  ) {
                    continue;
                  }
                  // Fuzzy To proposals fill the primary output only (ADR-0037).
                  const base: KeyMapEntry = i !== undefined
                    ? merged[i]!
                    : {
                        from: parts[0]!,
                        from_parts: parts,
                        to: "",
                        output_values: padOutputs([]),
                      };
                  const m = mergeLensOutputCells(base, outCols, [
                    { column: outCols[0]!, value: s.to_key },
                  ]);
                  if (!m.ok) continue;
                  const entry = m.entry;
                  if (i === undefined) {
                    byFrom.set(key, merged.length);
                    merged.push(entry);
                  } else {
                    merged[i] = entry;
                  }
                }
                setEntries(merged);
                return;
              }
              const proposals = suggestions
                .filter((s) => !s.ambiguous)
                .map((s) => ({
                  fromParts: s.from_parts?.length
                    ? s.from_parts
                    : s.from_key.trim()
                      ? [s.from_key]
                      : [],
                  to: s.to_key,
                }))
                .filter((p) => p.fromParts.every(Boolean) && p.to.trim());
              const { newIds } = storeRef.current.applyProposals(
                proposals,
                pageRef.current,
              );
              if (newIds.length) {
                newIdsRef.current = [...newIdsRef.current, ...newIds];
              }
              bumpDirty();
              onChange({
                ...map,
                entries: storeRef.current.viewEntries(
                  pageRef.current,
                  newIdsRef.current,
                ),
              });
            }}
          />}
          {pasteOpen && (
            <div className="shrink-0 space-y-2 border-b border-slate-800 px-4 py-3">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={compact ? 3 : 6}
                placeholder={
                  arity > 1 || outArity > 1
                    ? `${[...fromCols, ...outCols].join(",")}\nid,2024-06-01,sk1`
                    : "from,to\nwww,web\nshop,store"
                }
                className="w-full rounded-md border border-slate-700 bg-slate-950 p-2 font-mono text-[12px] text-slate-200"
              />
              <button
                type="button"
                onClick={applyPaste}
                className="rounded-md bg-teal-600 px-3 py-1.5 text-[12px] font-medium text-slate-950"
              >
                Merge paste
              </button>
            </div>
          )}
          {error && (
            <div className="shrink-0 border-b border-amber-900/40 bg-amber-950/40 px-4 py-2 text-[12px] text-amber-200">
              {error}
            </div>
          )}
          {grid}
        </div>
      </div>

      {!compact && onApply && joinApplyContext && applyReview && (() => {
        const review = applyReview;
        const leftOnCols = joinApplyContext.leftOnCols ?? [joinApplyContext.leftOn];
        const rightOnCols = joinApplyContext.rightOnCols ?? [joinApplyContext.rightOn];
        const canRewrite = review.side !== "right";
        const rewrite = canRewrite && review.rewriteJoin;
        const patchOutput = (
          i: number,
          p: Partial<(typeof review.outputs)[number]>,
        ) => {
          const outputs = review.outputs.map((o, j) =>
            j === i ? { ...o, ...p } : o,
          );
          setApplyReview({ ...review, outputs });
        };
        const patchKeep = (i: number, keep: boolean) => {
          const keepEqualities = review.keepEqualities.map((e, j) =>
            j === i ? { ...e, keep } : e,
          );
          setApplyReview({ ...review, keepEqualities });
        };
        const preview = (() => {
          if (!rewrite) return null;
          const left: string[] = [];
          const right: string[] = [];
          for (const eq of review.keepEqualities) {
            if (!eq.keep) continue;
            left.push(eq.left);
            right.push(eq.right);
          }
          for (const o of review.outputs) {
            if (!o.includeJoin) continue;
            left.push(o.destination.trim() || o.mapColumn);
            right.push(o.rightCol.trim() || "?");
          }
          return { left, right };
        })();
        const confirm = (withJoin: boolean) => {
          const state: ApplyReviewState = {
            ...review,
            rewriteJoin: withJoin && canRewrite,
          };
          const conf = confirmApplyReview(state);
          if (conf.error) {
            setApplyReviewError(conf.error);
            return;
          }
          setApplyReview(null);
          setApplyReviewError(null);
          onApply(review.side, {
            ...applyReviewBindingsForSide(review.side, conf.bindings),
            joinRewrite: withJoin ? conf.joinRewrite : undefined,
          });
        };
        const listId = "keymap-apply-review-right-cols";
        const applyCount = review.outputs.filter((o) => o.includeApply).length;
        return (
          <div className="shrink-0 space-y-3 border-t border-teal-900/50 bg-slate-900/70 px-4 py-3 text-[12px] text-slate-300">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold text-teal-200">
                Review Apply — {applyCount}/{review.outputs.length} outputs
                <span className="ml-2 font-normal text-slate-500">
                  on {joinApplyContext.hostQueryName} · {review.side}
                </span>
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-[11px] text-slate-500">
                Include in Apply → destination
                {rewrite ? " · Include in Join → right column" : ""}
              </p>
              {review.outputs.map((o, i) => (
                <div key={`${o.mapColumn}-${i}`} className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-slate-400">
                    <input
                      type="checkbox"
                      checked={o.includeApply}
                      onChange={(e) =>
                        patchOutput(i, {
                          includeApply: e.target.checked,
                          includeJoin: e.target.checked ? o.includeJoin : false,
                        })
                      }
                      aria-label={`Include ${o.mapColumn} in Apply`}
                      className="accent-teal-500"
                    />
                    <span className="w-28 truncate font-mono" title={o.mapColumn}>
                      {o.mapColumn}
                    </span>
                  </label>
                  <span className="text-slate-600">→</span>
                  <input
                    value={o.destination}
                    disabled={!o.includeApply}
                    onChange={(e) => patchOutput(i, { destination: e.target.value })}
                    aria-label={`Destination for ${o.mapColumn}`}
                    className="w-40 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px] text-slate-200 focus:border-teal-600 focus:outline-none disabled:opacity-40"
                  />
                  {rewrite && (
                    <>
                      <label className="ml-1 flex items-center gap-1 text-slate-500">
                        <input
                          type="checkbox"
                          checked={o.includeJoin}
                          disabled={!o.includeApply}
                          onChange={(e) =>
                            patchOutput(i, { includeJoin: e.target.checked })
                          }
                          aria-label={`Include ${o.mapColumn} in Join`}
                          className="accent-teal-500"
                        />
                        Join
                      </label>
                      <span className="text-slate-600">=</span>
                      <input
                        value={o.rightCol}
                        list={listId}
                        disabled={!o.includeApply || !o.includeJoin}
                        onChange={(e) =>
                          patchOutput(i, { rightCol: e.target.value })
                        }
                        aria-label={`Right Join column for ${o.destination}`}
                        className="w-40 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px] text-slate-200 focus:border-teal-600 focus:outline-none disabled:opacity-40"
                      />
                    </>
                  )}
                </div>
              ))}
              <datalist id={listId}>
                {rightOnCols.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </div>
            {canRewrite && (
              <label className="flex cursor-pointer items-center gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={review.rewriteJoin}
                  onChange={(e) =>
                    setApplyReview({ ...review, rewriteJoin: e.target.checked })
                  }
                  className="accent-teal-500"
                />
                Also change Join ON
              </label>
            )}
            {rewrite && review.keepEqualities.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-slate-500">
                  Keep existing equalities (e.g. day = day)
                </p>
                {review.keepEqualities.map((eq, i) => (
                  <label
                    key={`${eq.left}-${eq.right}-${i}`}
                    className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-slate-400"
                  >
                    <input
                      type="checkbox"
                      checked={eq.keep}
                      onChange={(e) => patchKeep(i, e.target.checked)}
                      className="accent-teal-500"
                    />
                    {eq.left} = {eq.right}
                  </label>
                ))}
              </div>
            )}
            <div className="space-y-0.5 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-[11px]">
              <p className="text-slate-500">
                old ON{" "}
                <span className="text-slate-300">
                  {formatJoinOn(leftOnCols, rightOnCols)}
                </span>
              </p>
              <p className={rewrite ? "text-teal-200" : "text-slate-600"}>
                new ON{" "}
                {rewrite && preview ? (
                  preview.left.length ? (
                    formatJoinOn(preview.left, preview.right)
                  ) : (
                    <span className="text-amber-200">(no equalities selected)</span>
                  )
                ) : (
                  <>unchanged — {formatJoinOn(leftOnCols, rightOnCols)}</>
                )}
              </p>
            </div>
            {applyReviewError && (
              <p className="text-[12px] text-amber-200">{applyReviewError}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => confirm(false)}
                className={
                  rewrite
                    ? "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-teal-700"
                    : "rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400"
                }
              >
                Apply map only
              </button>
              {canRewrite && (
                <button
                  type="button"
                  disabled={!review.rewriteJoin}
                  title={
                    review.rewriteJoin
                      ? undefined
                      : 'Turn on "Also change Join ON" first'
                  }
                  onClick={() => confirm(true)}
                  className="rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Apply map and change Join
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setApplyReview(null);
                  setApplyReviewError(null);
                }}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

      {!compact && (onSave || onDelete || onApply) && (() => {
        const probeSide = joinApplyContext?.probeSide;
        const primarySide: ApplySide | null = probeSide ?? null;
        const otherSides: ApplySide[] = primarySide
          ? (["left", "right", "both"] as ApplySide[]).filter(
              (s) => s !== primarySide,
            )
          : ["left", "right", "both"];

        const runApply = (side: ApplySide) => {
          const v = validateEntries(map.entries);
          if (!v.ok) {
            setError(v.error);
            return;
          }
          if (outCols.length > 1 && joinApplyContext) {
            const leftOnCols = joinApplyContext.leftOnCols ?? [
              joinApplyContext.leftOn,
            ];
            const rightOnCols = joinApplyContext.rightOnCols ?? [
              joinApplyContext.rightOn,
            ];
            setApplyReviewError(null);
            setApplyReview(
              buildApplyReviewState({
                side,
                outCols,
                leftOnCols,
                rightOnCols,
              }),
            );
            return;
          }
          onApply!(side);
        };

        const primaryTarget =
          primarySide === "left" && joinApplyContext
            ? `${joinApplyContext.hostQueryName}.${joinApplyContext.leftOn}`
            : primarySide === "right" && joinApplyContext
              ? `${joinApplyContext.rightQueryName}.${joinApplyContext.rightOn}`
              : null;

        return (
          <div className="flex shrink-0 flex-wrap items-start gap-3 border-t border-slate-800 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {onApply && primarySide && primaryTarget ? (
                <>
                  <button
                    type="button"
                    onClick={() => runApply(primarySide)}
                    className="rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400"
                  >
                    Apply to {primarySide}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowOtherApplySides((v) => !v)}
                    className="rounded-lg border border-slate-700 px-2.5 py-2 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  >
                    {showOtherApplySides ? "Hide other…" : "Other side…"}
                  </button>
                  {showOtherApplySides &&
                    otherSides.map((side) => (
                      <button
                        key={side}
                        type="button"
                        onClick={() => runApply(side)}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-[12px] text-slate-300 hover:border-teal-800 hover:text-teal-200"
                      >
                        Apply {side}
                      </button>
                    ))}
                </>
              ) : onApply ? (
                <>
                  <span className="mr-1 text-[11px] text-slate-500">
                    Insert ApplyKeyMap:
                  </span>
                  {otherSides.map((side) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => runApply(side)}
                      className="rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400"
                    >
                      Apply {side}
                    </button>
                  ))}
                </>
              ) : null}
              {onSave && (
                <button
                  type="button"
                  disabled={saving}
                  title={saving ? "Save in progress…" : undefined}
                  onClick={onSave}
                  className={
                    onApply
                      ? "rounded-lg border border-slate-700 px-3 py-2.5 text-sm text-slate-300 hover:border-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                      : "rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
                  }
                >
                  {saving ? "Saving…" : saveLabel}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="rounded-lg border border-rose-900/60 px-3 py-2.5 text-sm text-rose-300 hover:bg-rose-950/40"
                >
                  Delete
                </button>
              )}
            </div>
            {onApply && joinApplyContext && primarySide && primaryTarget ? (
              <div className="min-w-[16rem] flex-1 space-y-1 text-[11px] leading-snug text-slate-500">
                <p>
                  <span className="font-semibold text-slate-400">
                    Context (this Join only)
                  </span>
                  {" — "}
                  host{" "}
                  <span className="font-mono text-teal-300/90">
                    {joinApplyContext.hostQueryName}
                  </span>
                  {" · right "}
                  <span className="font-mono text-teal-300/90">
                    {joinApplyContext.rightQueryName}
                  </span>
                  {" · on "}
                  <span className="font-mono text-slate-300">
                    {(joinApplyContext.leftOnCols ?? [joinApplyContext.leftOn]).join(
                      ", ",
                    )}
                  </span>
                  {" = "}
                  <span className="font-mono text-slate-300">
                    {(
                      joinApplyContext.rightOnCols ?? [joinApplyContext.rightOn]
                    ).join(", ")}
                  </span>
                  . Opened from{" "}
                  <span className="font-semibold text-amber-100">
                    {primarySide} unmatched
                  </span>
                  , so one Apply is enough. Map stays reusable; only the step
                  is bound to this usage.
                </p>
                <p>
                  <span className="font-semibold text-teal-200">
                    Apply to {primarySide}
                  </span>
                  {" → inserts "}
                  <span className="font-mono text-slate-400">ApplyKeyMap</span>
                  {" on "}
                  <span className="font-mono text-slate-300">{primaryTarget}</span>
                  {primarySide === "left" ? " before Join" : ""}.{" "}
                  <span className="text-slate-600">
                    Other side… is rare (aliases on the other input, or both).
                  </span>
                </p>
              </div>
            ) : onApply && joinApplyContext ? (
              <div className="min-w-[16rem] flex-1 space-y-1 text-[11px] leading-snug text-slate-500">
                <p>
                  Remap the side with dirty aliases. Map stays reusable; only
                  the step is bound to this Join.
                </p>
              </div>
            ) : onApply ? (
              <p className="min-w-[14rem] flex-1 text-[11px] leading-snug text-slate-500">
                <span className="font-semibold text-slate-400">
                  Join Lens context only
                </span>
                {" — inserts "}
                <span className="font-mono text-slate-400">ApplyKeyMap</span>
                {" for this Join; map stays unbound."}
                {joinApplyHint ? ` ${joinApplyHint}` : ""}
              </p>
            ) : (
              <p className="ml-auto text-[11px] text-slate-600">
                Enter moves cells · Enter on last To adds a row
              </p>
            )}
          </div>
        );
      })()}
      {rebindOpen && (
        <KeyMapBindWizard
          postgresConnections={postgresConnections}
          initial={{
            storage:
              map.storage?.kind === "source" ? map.storage : undefined,
            from_column: map.from_column,
            from_columns: fromCols,
            to_column: map.to_column,
            editable_columns: map.editable_columns,
          }}
          onCancel={() => setRebindOpen(false)}
          onConfirm={(bind: KeyMapBindResult) => {
            // Do not clear drafts while a warehouse Save is in flight — parent
            // refuses binding changes and would leave an empty local store.
            if (saving) {
              setRebindOpen(false);
              return;
            }
            storeRef.current.clear();
            pageRef.current = [];
            newIdsRef.current = [];
            bumpDirty();
            loadedTableKey.current = "";
            setPageOffset(0);
            setRebindOpen(false);
            onChange(applyKeyMapBind(map, bind));
            setReloadNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
