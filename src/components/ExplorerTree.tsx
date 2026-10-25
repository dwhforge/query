import type {
  ConnectionDef,
  Project,
  QueryDef,
  SourceDef,
} from "../types/pipeline";

interface ExplorerTreeProps {
  project: Project;
  activeQueryId: string | null;
  selectedSourceId: string | null;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onSelectQuery: (id: string) => void;
  onSelectSource: (source: SourceDef) => void;
  onSelectConnection: (conn: ConnectionDef) => void;
  onExport: () => void;
  onRevealExport?: () => void;
  exportFiles?: string[];
  onAddConnection: () => void;
  onAddSourceCsv: () => void;
  onAddSourceParquet: () => void;
  onAddSourceS3: () => void;
  onAddSourcePostgres: () => void;
  /** New query that Loads this source (for a second model on the same object). */
  onNewQueryFromSource: (source: SourceDef) => void;
  /** Queries + : from selected source, or CSV picker if none. */
  onNewQuery: () => void;
}

function SectionHeader({
  title,
  open,
  count,
  onToggle,
  actions,
}: {
  title: string;
  open: boolean;
  count?: number;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="group flex items-center gap-0.5 py-1 pl-0.5 pr-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 hover:text-slate-300"
      >
        <span className="mr-1 w-3 text-[10px] text-slate-600">
          {open ? "▾" : "▸"}
        </span>
        <span className="truncate">{title}</span>
        {typeof count === "number" && (
          <span className="ml-1.5 tabular-nums text-slate-600">{count}</span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
        {actions}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-teal-300"
    >
      {children}
    </button>
  );
}

export function ExplorerTree({
  project,
  activeQueryId,
  selectedSourceId,
  expanded,
  onToggle,
  onSelectQuery,
  onSelectSource,
  onSelectConnection,
  onExport,
  onRevealExport,
  exportFiles = [],
  onAddConnection,
  onAddSourceCsv,
  onAddSourceParquet,
  onAddSourceS3,
  onAddSourcePostgres,
  onNewQueryFromSource,
  onNewQuery,
}: ExplorerTreeProps) {
  const connectionsOpen = expanded.connections !== false;
  const sourcesOpen = expanded.sources !== false;
  const queriesOpen = expanded.queries !== false;
  const exportOpen = expanded.export !== false;
  const focus = project.workspace.focus_query_id;

  return (
    <nav className="flex h-full flex-col text-sm">
      <div className="border-b border-[var(--line)] px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Explorer
        </div>
        <div className="mt-0.5 truncate font-semibold text-teal-200">
          {project.name}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
        <div className="px-1">
          <SectionHeader
            title="Connections"
            open={connectionsOpen}
            count={project.connections.length}
            onToggle={() => onToggle("connections")}
            actions={
              <IconBtn title="New connection" onClick={onAddConnection}>
                +
              </IconBtn>
            }
          />
          {connectionsOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.connections.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  PG / S3 credentials — use +
                </li>
              )}
              {project.connections.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelectConnection(c)}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-slate-300 hover:bg-slate-800/80"
                  >
                    <span className="w-8 shrink-0 text-[9px] uppercase text-amber-600/90">
                      {c.kind === "postgres" ? "pg" : "s3"}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-1">
          <SectionHeader
            title="Sources"
            open={sourcesOpen}
            count={project.sources.length}
            onToggle={() => onToggle("sources")}
            actions={
              <>
                <IconBtn title="Add CSV" onClick={onAddSourceCsv}>
                  +
                </IconBtn>
                <IconBtn title="Add local Parquet" onClick={onAddSourceParquet}>
                  <span className="text-[9px] font-bold">PQ</span>
                </IconBtn>
                <IconBtn title="Add S3 Parquet" onClick={onAddSourceS3}>
                  <span className="text-[9px] font-bold">S3</span>
                </IconBtn>
                <IconBtn title="Add Postgres table" onClick={onAddSourcePostgres}>
                  <span className="text-[9px] font-bold">PG</span>
                </IconBtn>
              </>
            }
          />
          {sourcesOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.sources.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  Objects bound to connections — use +
                </li>
              )}
              {project.sources.map((s) => {
                const selected = s.id === selectedSourceId;
                return (
                  <li key={s.id} className="group/src flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onSelectSource(s)}
                      className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${
                        selected
                          ? "bg-teal-500/15 text-teal-100"
                          : "text-slate-300 hover:bg-slate-800/80"
                      }`}
                    >
                      <span className="w-8 shrink-0 text-[9px] uppercase text-teal-600">
                        {s.kind === "postgres" ? "pg" : s.kind}
                      </span>
                      <span className="truncate">{s.name}</span>
                    </button>
                    <IconBtn
                      title="New query from this source"
                      onClick={() => onNewQueryFromSource(s)}
                    >
                      +
                    </IconBtn>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-1">
          <SectionHeader
            title="Queries"
            open={queriesOpen}
            count={project.workspace.queries.length}
            onToggle={() => onToggle("queries")}
            actions={
              <IconBtn
                title="New query (from selected source, or pick CSV)"
                onClick={onNewQuery}
              >
                +
              </IconBtn>
            }
          />
          {queriesOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.workspace.queries.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  No queries — use +
                </li>
              )}
              {project.workspace.queries.map((q: QueryDef) => {
                const active = q.id === activeQueryId;
                const isFocus = q.id === focus;
                return (
                  <li key={q.id}>
                    <button
                      type="button"
                      onClick={() => onSelectQuery(q.id)}
                      className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs ${
                        active
                          ? "bg-teal-500/15 text-teal-100"
                          : "text-slate-300 hover:bg-slate-800/80"
                      }`}
                    >
                      <span className="truncate">{q.name}</span>
                      {isFocus && (
                        <span className="ml-auto text-[9px] text-teal-400">
                          ★
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-1">
          <SectionHeader
            title="Export"
            open={exportOpen}
            count={exportFiles.length || undefined}
            onToggle={() => onToggle("export")}
            actions={
              <>
                {project.last_dbt_export_path && onRevealExport && (
                  <IconBtn title="Reveal in folder" onClick={onRevealExport}>
                    ↗
                  </IconBtn>
                )}
                <IconBtn title="Export dbt" onClick={onExport}>
                  +
                </IconBtn>
              </>
            }
          />
          {exportOpen && (
            <ul className="ml-3 border-l border-[var(--line)] pl-2">
              <li>
                <button
                  type="button"
                  onClick={onExport}
                  className="w-full rounded-md px-1.5 py-1 text-left text-xs text-slate-300 hover:bg-slate-800/80 hover:text-teal-200"
                >
                  dbt ({project.dbt_target})
                </button>
              </li>
              {project.last_dbt_export_path && (
                <li
                  className="truncate px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                  title={project.last_dbt_export_path}
                >
                  {project.last_dbt_export_path}
                </li>
              )}
              {exportFiles.length === 0 && !project.last_dbt_export_path && (
                <li className="px-1.5 py-1 text-[11px] text-slate-600">
                  No export yet
                </li>
              )}
              {exportFiles.map((rel) => {
                const depth = rel.replace(/\/$/, "").split("/").length - 1;
                const name = rel.endsWith("/")
                  ? rel.slice(0, -1).split("/").pop() + "/"
                  : (rel.split("/").pop() ?? rel);
                const isDir = rel.endsWith("/");
                return (
                  <li
                    key={rel}
                    className={`truncate font-mono text-[11px] ${
                      isDir ? "text-slate-500" : "text-slate-400"
                    }`}
                    style={{ paddingLeft: 6 + depth * 10 }}
                    title={rel}
                  >
                    {name}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </nav>
  );
}
