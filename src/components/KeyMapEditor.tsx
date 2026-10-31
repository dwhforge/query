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
import { listPostgresObjects, readKeyMap, type KeyMapDirtyDelta } from "../lib/bridge";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KeyMapFuzzyPanel } from "./KeyMapFuzzyPanel";
import { mergeKeyMapProposals } from "../lib/keyMap";
import type { Workspace } from "../types/pipeline";
import {
  fromColumnsEff,
  fromPartsEff,
  keyMapSeedName,
  parseFromToPaste,
  tupleKey,
  validateKeyMapEntries,
  type ApplySide,
} from "../lib/keyMap";
import {
  applyDirtyToPage,
  KeyMapDirtyBuffer,
  KEYMAP_PAGE_SIZE,
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
   * Bumped by App after a successful warehouse Save so the editor clears its
   * internal dirty buffer (App alone clearing dirtyDelta is not enough).
   */
  dirtyResetSeq?: number;
  onApply?: (side: ApplySide) => void;
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

function storageKind(s: KeyMapStorage | undefined): "seed" | "ref" | "source" {
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
  dirtyResetSeq,
  onApply,
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
  const dirtyRef = useRef(new KeyMapDirtyBuffer());
  const dirtyResetSeen = useRef(dirtyResetSeq);
  const gridRef = useRef<HTMLDivElement>(null);
  const isSource = map.storage?.kind === "source";
  const editableCols = map.editable_columns ?? [];
  const fromCols = fromColumnsEff(map);
  const arity = fromCols.length;

  function bumpDirty() {
    onDirtyChange?.(dirtyRef.current.toDelta());
    setDirtyTick((n) => n + 1);
  }

  // App clears tab.dirtyDelta on Save; mirror that into the editor buffer.
  useEffect(() => {
    if (dirtyResetSeq === undefined) return;
    if (dirtyResetSeen.current === dirtyResetSeq) return;
    dirtyResetSeen.current = dirtyResetSeq;
    dirtyRef.current.clear();
    setDirtyTick((n) => n + 1);
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
        const entries = applyDirtyToPage(r.entries, dirtyRef.current);
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
    if (isSource) {
      // Server-side fromPrefix already applied.
      return map.entries.map((e, i) => ({ e, i }));
    }
    const q = filter.trim().toLowerCase();
    if (!q) return map.entries.map((e, i) => ({ e, i }));
    return map.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        const parts = fromPartsEff(e);
        return (
          parts.some((p) => p.toLowerCase().includes(q)) ||
          e.to.toLowerCase().includes(q)
        );
      });
  }, [map.entries, filter, isSource]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rows[index]!.i,
    getScrollElement: () => gridRef.current,
    estimateSize: () => compact ? 38 : 42,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();

  function setEntries(entries: KeyMapEntry[], opts?: { trackAll?: boolean }) {
    const v = validateKeyMapEntries(entries, arity);
    if (!v.ok) {
      setError(v.error);
      onChange({ ...map, entries });
      return;
    }
    setError(null);
    if (isSource && opts?.trackAll) {
      for (const e of v.entries) {
        const key = tupleKey(fromPartsEff(e));
        const old = map.entries.find(
          (x) => tupleKey(fromPartsEff(x)) === key,
        );
        dirtyRef.current.noteUpsert(e, old ?? null);
      }
      bumpDirty();
    }
    onChange({ ...map, entries: v.entries });
  }

  function updateRow(index: number, patch: Partial<KeyMapEntry>) {
    const prev = map.entries[index];
    if (!prev) return;
    const merged: KeyMapEntry = {
      ...prev,
      ...patch,
      attrs:
        patch.attrs !== undefined
          ? patch.attrs
          : prev.attrs,
    };
    if (patch.attrs === undefined && prev.attrs) {
      merged.attrs = { ...prev.attrs };
    }
    const next = map.entries.map((e, i) => (i === index ? merged : e));
    const v = validateKeyMapEntries(next, arity);
    if (!v.ok) {
      setError(v.error);
      onChange({ ...map, entries: next });
      return;
    }
    setError(null);
    if (isSource) {
      const prevParts = fromPartsEff(prev);
      const nextParts = fromPartsEff(merged);
      if (tupleKey(prevParts) !== tupleKey(nextParts)) {
        dirtyRef.current.noteRename(prevParts, merged, prev);
      } else {
        dirtyRef.current.noteUpsert(merged, prev);
      }
      bumpDirty();
    }
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
    const entry: KeyMapEntry = {
      from: parts[0] ?? "",
      from_parts: parts,
      to,
    };
    if (editableCols.length) {
      entry.attrs = Object.fromEntries(editableCols.map((c) => [c, ""]));
    }
    if (isSource) {
      dirtyRef.current.noteUpsert(entry, null);
      bumpDirty();
    }
    setEntries([...map.entries, entry]);
  }

  function deleteRow(index: number) {
    const prev = map.entries[index];
    if (isSource && prev) {
      dirtyRef.current.noteDelete(fromPartsEff(prev), prev);
      bumpDirty();
    }
    setEntries(map.entries.filter((_, j) => j !== index));
  }

  function addSuggested() {
    const have = new Set(map.entries.map((e) => tupleKey(fromPartsEff(e))));
    const fromTuples: string[][] =
      suggestedFromParts.length > 0
        ? suggestedFromParts
        : suggestedFrom.map((s) => [s.trim()]);
    const extra = fromTuples
      .map((parts) => parts.map((p) => p.trim()))
      .filter((parts) => parts.every(Boolean) && !have.has(tupleKey(parts)))
      .map((parts) => ({
        from: parts[0]!,
        from_parts: parts,
        to: "",
      }));
    if (extra.length) setEntries([...map.entries, ...extra], { trackAll: true });
  }

  function applyPaste() {
    const parsed = parseFromToPaste(pasteText, arity);
    if (!parsed.length) {
      setError("Paste TSV/CSV with from,to columns");
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
    setEntries(merged, { trackAll: true });
    setPasteOpen(false);
    setPasteText("");
  }

  function onCellKeyDown(
    e: KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    col: "from" | "to",
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (rowIndex === map.entries.length - 1 && col === "to") {
        addRow();
        return;
      }
      if (col === "from") {
        (
          e.currentTarget
            .closest("tr")
            ?.querySelector<HTMLInputElement>('input[data-col="to"]') ?? null
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
            const kind = e.target.value as "seed" | "ref" | "source";
            const storage: KeyMapStorage =
              kind === "seed"
                ? { kind: "seed" }
                : kind === "ref"
                  ? { kind: "ref", model: "" }
                  : {
                      kind: "source",
                      source: "",
                      table: "",
                    };
            onChange({ ...map, storage });
            if (kind === "source") setRebindOpen(true);
          }}
          className={fieldClass}
        >
          <option value="seed">dbt seed (seeds/map_*.csv)</option>
          <option value="ref">Existing dbt ref(model)</option>
          <option value="source">Warehouse source table</option>
        </select>
      </label>
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
          <span className={labelClass}>From columns</span>
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
            + From
          </button>
        </div>
        {fromCols.map((col, i) => (
          <label key={`from-col-${i}`} className={labelClass}>
            From[{i + 1}]
            <div className="mt-1 flex gap-1">
              <input
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
                  aria-label="Remove From column"
                >
                  ×
                </button>
              )}
            </div>
          </label>
        ))}
        <label className={labelClass}>
          To column
          <input
            value={map.to_column ?? "to"}
            onChange={(e) => onChange({ ...map, to_column: e.target.value })}
            className={`${fieldClass} font-mono`}
          />
        </label>
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Map relation column names. Arity {arity}: uniqueness is the From{" "}
        <span className="font-mono text-slate-400">tuple</span> (ADR-0024).
        Default seed header is{" "}
        <span className="font-mono text-slate-400">
          {fromCols.join(",")},{map.to_column ?? "to"}
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
      <button
        type="button"
        onClick={() => addRow()}
        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-200 hover:border-teal-600 hover:text-teal-100"
      >
        Add row
      </button>
      {map.storage?.kind === "source" &&
        map.storage.source &&
        map.storage.table && (
          <button
            type="button"
            onClick={() => {
              dirtyRef.current.clear();
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
      <button
        type="button"
        onClick={() => setPasteOpen((v) => !v)}
        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
      >
        Paste CSV
      </button>
      <span className="text-[11px] text-slate-500">
        {isSource
          ? `${map.entries.length} on page`
          : filter.trim()
            ? `${rows.length} / ${map.entries.length} rows`
            : `${map.entries.length} rows`}
        {dirtyTick >= 0 && dirtyRef.current.dirtyCount() > 0
          ? ` · ${dirtyRef.current.dirtyCount()} dirty`
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
        <thead className="sticky top-0 z-10 bg-[#0a1520] text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-10 px-3 py-2 font-semibold">#</th>
            {fromCols.map((col, fi) => (
              <th key={`fh-${fi}`} className="px-3 py-2 font-semibold">
                From
                <span className="ml-1 font-mono normal-case text-slate-600">
                  ({col})
                </span>
              </th>
            ))}
            <th className="px-3 py-2 font-semibold">
              To
              {map.to_column && map.to_column !== "to" ? (
                <span className="ml-1 font-mono normal-case text-slate-600">
                  ({map.to_column})
                </span>
              ) : null}
            </th>
            {editableCols.map((c) => (
              <th key={c} className="px-3 py-2 font-semibold font-mono normal-case">
                {c}
              </th>
            ))}
            <th className="w-12" />
          </tr>
        </thead>
        <tbody>
          {virtualRows.length > 0 && virtualRows[0]!.start > 0 && <tr aria-hidden="true"><td colSpan={3 + fromCols.length + editableCols.length} style={{height: virtualRows[0]!.start, padding: 0}} /></tr>}
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
              <td className="px-2 py-1">
                <input
                  data-col="to"
                  list={
                    pickToOptions.length > 0
                      ? `keymap-to-${map.id}`
                      : undefined
                  }
                  value={e.to}
                  onChange={(ev) => updateRow(i, { to: ev.target.value })}
                  onKeyDown={(ev) => onCellKeyDown(ev, i, "to")}
                  className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-teal-200/90 focus:border-slate-600 focus:bg-slate-950"
                />
              </td>
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
          {virtualRows.length > 0 && <tr aria-hidden="true"><td colSpan={3 + fromCols.length + editableCols.length} style={{height: Math.max(0,virtualizer.getTotalSize()-virtualRows[virtualRows.length-1]!.end), padding: 0}} /></tr>}
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
                Use a different KeyMap…
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
          {!compact && workspace && <KeyMapFuzzyPanel
            key={map.id}
            workspace={workspace}
            connections={connections}
            onAccept={(suggestions) =>
              setEntries(mergeKeyMapProposals(map.entries, suggestions), {
                trackAll: true,
              })
            }
          />}
          {pasteOpen && (
            <div className="shrink-0 space-y-2 border-b border-slate-800 px-4 py-3">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={compact ? 3 : 6}
                placeholder={
                  arity > 1
                    ? `${fromCols.join(",")},${map.to_column ?? "to"}\nid,2024-06-01,sk1`
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

      {!compact && (onSave || onDelete || onApply) && (() => {
        const probeSide = joinApplyContext?.probeSide;
        const primarySide: ApplySide | null = probeSide ?? null;
        const otherSides: ApplySide[] = primarySide
          ? (["left", "right", "both"] as ApplySide[]).filter(
              (s) => s !== primarySide,
            )
          : ["left", "right", "both"];

        const runApply = (side: ApplySide) => {
          const v = validateKeyMapEntries(map.entries, arity);
          if (!v.ok) {
            setError(v.error);
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
                  onClick={onSave}
                  className={
                    onApply
                      ? "rounded-lg border border-slate-700 px-3 py-2.5 text-sm text-slate-300 hover:border-teal-700"
                      : "rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-teal-400"
                  }
                >
                  {saveLabel}
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
            dirtyRef.current.clear();
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
