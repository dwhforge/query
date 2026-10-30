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
import { listPostgresObjects, readKeyMap } from "../lib/bridge";
import { useVirtualizer } from "@tanstack/react-virtual";
import { KeyMapFuzzyPanel } from "./KeyMapFuzzyPanel";
import { mergeKeyMapProposals } from "../lib/keyMap";
import type { Workspace } from "../types/pipeline";
import {
  keyMapSeedName,
  parseFromToPaste,
  validateKeyMapEntries,
  type ApplySide,
} from "../lib/keyMap";

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
  /** Known dbt sources (Explorer / LoadPostgres) for storage=source datalist. */
  sourceOptions?: KeyMapSourceOption[];
  /** Postgres connections for source write-back / read. */
  postgresConnections?: ConnectionDef[];
  /** Candidate dbt model names for storage=ref combo. */
  refOptions?: string[];
  onChange: (map: KeyMapDef) => void;
  /** Fired after a successful warehouse read (optimistic concurrency token). */
  onWarehouseRead?: (contentHash: string) => void;
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
  sourceOptions = [],
  postgresConnections = [],
  refOptions = [],
  onChange,
  onWarehouseRead,
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
  const loadedTableKey = useRef<string>("");
  const gridRef = useRef<HTMLDivElement>(null);

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

  // Load From→To rows when schema+table are chosen (in-place edit of warehouse table).
  useEffect(() => {
    if (map.storage?.kind !== "source") {
      loadedTableKey.current = "";
      setRowsStatus(null);
      return;
    }
    const { source, table } = map.storage;
    if (!source.trim() || !table.trim() || !activeConnectionId) return;
    const conn = postgresConnections.find((c) => c.id === activeConnectionId);
    const dsn = conn?.postgres?.connection_string?.trim();
    if (!dsn) return;
    const key = `${activeConnectionId}|${source}|${table}|${map.from_column ?? "from"}|${map.to_column ?? "to"}|${reloadNonce}`;
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
    )
      .then((r) => {
        if (cancelled) return;
        onChange({ ...map, entries: r.entries });
        onWarehouseRead?.(r.content_hash);
        setRowsStatus(
          r.entries.length === 0
            ? "Table empty — add rows below, then Save to warehouse"
            : `Loaded ${r.entries.length} rows — edit in place, then Save`,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        // Keep key so we don't hammer; allow Reload to reset.
        setRowsStatus(
          typeof e === "string" ? e : `Could not load rows: ${String(e)}`,
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load only when table binding changes
  }, [
    map.storage,
    map.from_column,
    map.to_column,
    activeConnectionId,
    postgresConnections,
    reloadNonce,
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
    const q = filter.trim().toLowerCase();
    if (!q) return map.entries.map((e, i) => ({ e, i }));
    return map.entries
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e }) =>
          e.from.toLowerCase().includes(q) || e.to.toLowerCase().includes(q),
      );
  }, [map.entries, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => rows[index]!.i,
    getScrollElement: () => gridRef.current,
    estimateSize: () => compact ? 38 : 42,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();

  function setEntries(entries: KeyMapEntry[]) {
    const v = validateKeyMapEntries(entries);
    if (!v.ok) {
      setError(v.error);
      onChange({ ...map, entries });
      return;
    }
    setError(null);
    onChange({ ...map, entries: v.entries });
  }

  function updateRow(index: number, patch: Partial<KeyMapEntry>) {
    const next = map.entries.map((e, i) =>
      i === index ? { ...e, ...patch } : e,
    );
    setEntries(next);
  }

  function addRow(from = "", to = "") {
    setEntries([...map.entries, { from, to }]);
  }

  function addSuggested() {
    const have = new Set(map.entries.map((e) => e.from.trim()));
    const extra = suggestedFrom
      .map((s) => s.trim())
      .filter((s) => s && !have.has(s))
      .map((from) => ({ from, to: "" }));
    if (extra.length) setEntries([...map.entries, ...extra]);
  }

  function applyPaste() {
    const parsed = parseFromToPaste(pasteText);
    if (!parsed.length) {
      setError("Paste TSV/CSV with from,to columns");
      return;
    }
    const merged = [...map.entries];
    const byFrom = new Map(merged.map((e, i) => [e.from.trim(), i] as const));
    for (const e of parsed) {
      const i = byFrom.get(e.from.trim());
      if (i === undefined) {
        byFrom.set(e.from.trim(), merged.length);
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
        detail: `${loc} · Save does full replace write-back`,
      };
    }
    if (kind === "ref") {
      return {
        label: "SoT · dbt ref",
        detail: refStorage?.model?.trim()
          ? `{{ ref('${refStorage.model}') }} · project cache only (no write-back)`
          : "set model name · project cache only",
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
          }}
          className={fieldClass}
        >
          <option value="seed">dbt seed (seeds/map_*.csv)</option>
          <option value="ref">Existing dbt ref(model)</option>
          <option value="source">Warehouse source table</option>
        </select>
      </label>
      {refStorage && (
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
            Edit the grid, then save — full replace write-back to{" "}
            <span className="font-mono">
              {sourceStorage.source || "?"}.{sourceStorage.table || "?"}
            </span>
            .
          </p>
        </div>
      )}
      {refStorage && (
        <p className="text-[11px] leading-snug text-slate-500">
          ref storage: rows are project cache only (no warehouse write-back).
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          From column
          <input
            value={map.from_column ?? "from"}
            onChange={(e) =>
              onChange({ ...map, from_column: e.target.value })
            }
            className={`${fieldClass} font-mono`}
          />
        </label>
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
        Names of the alias / canon columns in the seed or warehouse table.
        Leave as{" "}
        <span className="font-mono text-slate-400">from</span> /{" "}
        <span className="font-mono text-slate-400">to</span> for the default
        seed. Change only when storage is an existing table or model with
        different names (e.g.{" "}
        <span className="font-mono text-slate-400">alias</span> →{" "}
        <span className="font-mono text-slate-400">company_id</span>).
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
        placeholder="Filter rows…"
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
              loadedTableKey.current = "";
              setRowsStatus(null);
              setReloadNonce((n) => n + 1);
            }}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-400 hover:border-teal-700 hover:text-teal-200"
          >
            Reload
          </button>
        )}
      {suggestedFrom.length > 0 && (
        <button
          type="button"
          onClick={addSuggested}
          className="rounded-md border border-amber-900/50 px-2.5 py-1.5 text-[12px] text-amber-200/90 hover:border-amber-700"
        >
          Add unmatched ({suggestedFrom.length})
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
        {filter.trim()
          ? `${rows.length} / ${map.entries.length} rows`
          : `${map.entries.length} rows`}
      </span>
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
            <th className="px-3 py-2 font-semibold">
              From
              {map.from_column && map.from_column !== "from" ? (
                <span className="ml-1 font-mono normal-case text-slate-600">
                  ({map.from_column})
                </span>
              ) : null}
            </th>
            <th className="px-3 py-2 font-semibold">
              To
              {map.to_column && map.to_column !== "to" ? (
                <span className="ml-1 font-mono normal-case text-slate-600">
                  ({map.to_column})
                </span>
              ) : null}
            </th>
            <th className="w-12" />
          </tr>
        </thead>
        <tbody>
          {virtualRows.length > 0 && virtualRows[0]!.start > 0 && <tr aria-hidden="true"><td colSpan={4} style={{height: virtualRows[0]!.start, padding: 0}} /></tr>}
          {virtualRows.map((v) => { const {e,i}=rows[v.index]!; return (
            <tr
              key={i}
              style={{height: compact ? 38 : 42}}
              className="border-t border-slate-800/60 hover:bg-slate-900/40"
            >
              <td className="px-3 py-1 font-mono text-[11px] text-slate-600">
                {i + 1}
              </td>
              <td className="px-2 py-1">
                <input
                  data-col="from"
                  value={e.from}
                  onChange={(ev) => updateRow(i, { from: ev.target.value })}
                  onKeyDown={(ev) => onCellKeyDown(ev, i, "from")}
                  className="w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 font-mono text-sky-200/90 focus:border-slate-600 focus:bg-slate-950"
                />
              </td>
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
              <td className="px-2 text-center">
                <button
                  type="button"
                  onClick={() =>
                    setEntries(map.entries.filter((_, j) => j !== i))
                  }
                  className="px-1 text-lg leading-none text-slate-600 hover:text-rose-400"
                  aria-label="Delete row"
                >
                  ×
                </button>
              </td>
            </tr>
          ); })}
          {virtualRows.length > 0 && <tr aria-hidden="true"><td colSpan={4} style={{height: Math.max(0,virtualizer.getTotalSize()-virtualRows[virtualRows.length-1]!.end), padding: 0}} /></tr>}
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
            onAccept={(suggestions) => setEntries(mergeKeyMapProposals(map.entries, suggestions))}
          />}
          {pasteOpen && (
            <div className="shrink-0 space-y-2 border-b border-slate-800 px-4 py-3">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={compact ? 3 : 6}
                placeholder={"from,to\nwww,web\nshop,store"}
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
          const v = validateKeyMapEntries(map.entries);
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
                    {joinApplyContext.leftOn}
                  </span>
                  {" = "}
                  <span className="font-mono text-slate-300">
                    {joinApplyContext.rightOn}
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
    </div>
  );
}
