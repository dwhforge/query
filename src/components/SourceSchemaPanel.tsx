import type { PostgresColumn } from "../lib/tauri";
import type { SourceDef } from "../types/pipeline";

interface SourceSchemaPanelProps {
  source: SourceDef;
  columns: PostgresColumn[] | null;
  loading: boolean;
  error: string | null;
}

export function SourceSchemaPanel({
  source,
  columns,
  loading,
  error,
}: SourceSchemaPanelProps) {
  const qualified =
    source.kind === "postgres"
      ? `${source.schema || "public"}.${source.table_name ?? "?"}`
      : source.path ?? source.name;

  return (
    <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950/50">
      <div className="border-b border-slate-800 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Source schema
        </p>
        <p className="truncate font-mono text-xs text-teal-200/90" title={qualified}>
          {qualified}
        </p>
      </div>
      {loading && (
        <p className="px-3 py-2 text-[11px] text-slate-500">Loading columns…</p>
      )}
      {error && (
        <p className="px-3 py-2 text-[11px] text-rose-300">{error}</p>
      )}
      {!loading && !error && columns && (
        <ul className="max-h-48 overflow-auto py-1">
          {columns.map((c) => (
            <li
              key={`${c.ordinal_position}:${c.name}`}
              className="flex items-baseline justify-between gap-2 px-3 py-1 text-[11px]"
            >
              <span className="truncate font-mono text-slate-200">{c.name}</span>
              <span className="shrink-0 font-mono text-slate-500">
                {c.data_type}
                {c.is_nullable ? "" : " not null"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
