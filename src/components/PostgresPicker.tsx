import { useEffect, useMemo, useState } from "react";
import {
  listPostgresObjects,
  type PostgresObject,
} from "../lib/tauri";

const STORAGE_KEY = "dwh-rs-query.pg.connection";

export interface PostgresSelection {
  connection_string: string;
  schema: string;
  table_name: string;
  kind: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (sel: PostgresSelection) => void;
}

function kindBadge(kind: string): string {
  switch (kind) {
    case "view":
      return "view";
    case "materialized_view":
      return "matview";
    case "foreign":
      return "fdw";
    case "partitioned_table":
      return "part";
    default:
      return "table";
  }
}

export function PostgresPicker({ open, onClose, onSelect }: Props) {
  const [conn, setConn] = useState(
    () =>
      localStorage.getItem(STORAGE_KEY) ??
      "postgresql://user:pass@localhost:5432/db",
  );
  const [objects, setObjects] = useState<PostgresObject[]>([]);
  const [schemaFilter, setSchemaFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const schemas = useMemo(() => {
    const set = new Set(objects.map((o) => o.schema));
    return [...set].sort();
  }, [objects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return objects.filter((o) => {
      if (schemaFilter && o.schema !== schemaFilter) return false;
      if (!q) return true;
      return (
        o.name.toLowerCase().includes(q) ||
        o.schema.toLowerCase().includes(q) ||
        o.kind.toLowerCase().includes(q) ||
        `${o.schema}.${o.name}`.toLowerCase().includes(q)
      );
    });
  }, [objects, schemaFilter, search]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return objects.find((o) => `${o.schema}.${o.name}` === selectedKey) ?? null;
  }, [objects, selectedKey]);

  async function browse() {
    const connection = conn.trim();
    if (!connection) {
      setError("Connection string is required");
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    setSelectedKey(null);
    try {
      const list = await listPostgresObjects(connection);
      setObjects(list);
      localStorage.setItem(STORAGE_KEY, connection);
      const schemaSet = new Set(list.map((o) => o.schema));
      if (schemaSet.has("public")) setSchemaFilter("public");
      else if (schemaSet.size === 1) setSchemaFilter([...schemaSet][0] ?? "");
      else setSchemaFilter("");
      setStatus(
        list.length === 0
          ? "Connected — no user tables/views found"
          : `Connected — ${list.length} object${list.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      setObjects([]);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    if (!selected) return;
    onSelect({
      connection_string: conn.trim(),
      schema: selected.schema,
      table_name: selected.name,
      kind: selected.kind,
    });
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pg-picker-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(720px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[#0a121c] shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2
              id="pg-picker-title"
              className="text-sm font-semibold tracking-tight text-teal-300"
            >
              Connect Postgres
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Browse schemas and pick a table or view — not a free-typed name.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            Esc
          </button>
        </div>

        <div className="space-y-3 border-b border-[var(--line)] px-5 py-4">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Connection string
            </label>
            <input
              value={conn}
              onChange={(e) => setConn(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void browse()}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:ring-2 focus:ring-teal-700"
              placeholder="postgresql://user:pass@host:5432/dbname"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void browse()}
              disabled={loading}
              className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400 disabled:opacity-50"
            >
              {loading ? "Browsing…" : "Browse objects"}
            </button>
            {status && (
              <span className="text-xs text-teal-400/90">{status}</span>
            )}
          </div>
          {error && (
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-2">
          <select
            value={schemaFilter}
            onChange={(e) => setSchemaFilter(e.target.value)}
            disabled={objects.length === 0}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 disabled:opacity-40"
          >
            <option value="">All schemas</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={objects.length === 0}
            placeholder="Filter objects…"
            className="min-w-[160px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-teal-700 disabled:opacity-40"
          />
          <span className="text-[11px] text-slate-500">
            {filtered.length}/{objects.length}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {objects.length === 0 && !loading ? (
            <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-slate-500">
              Enter a connection string and browse to list tables and views.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {filtered.map((o) => {
                const key = `${o.schema}.${o.name}`;
                const active = key === selectedKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      onDoubleClick={() => {
                        setSelectedKey(key);
                        onSelect({
                          connection_string: conn.trim(),
                          schema: o.schema,
                          table_name: o.name,
                          kind: o.kind,
                        });
                      }}
                      className={`flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors ${
                        active
                          ? "bg-teal-500/15 text-teal-100"
                          : "text-slate-200 hover:bg-slate-900/80"
                      }`}
                    >
                      <span className="w-14 shrink-0 rounded border border-slate-700/80 px-1.5 py-0.5 text-center font-mono text-[10px] uppercase tracking-wide text-slate-400">
                        {kindBadge(o.kind)}
                      </span>
                      <span className="min-w-0 flex-1 font-mono text-xs">
                        <span className="text-slate-500">{o.schema}.</span>
                        <span className="text-slate-100">{o.name}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && objects.length > 0 && (
                <li className="px-5 py-8 text-center text-sm text-slate-500">
                  No objects match this filter.
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
          <p className="truncate font-mono text-[11px] text-slate-500">
            {selected
              ? `${selected.schema}.${selected.name}`
              : "Select an object"}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!selected}
              className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400 disabled:opacity-40"
            >
              Add as query
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
