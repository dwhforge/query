import type { Project, QueryDef, SourceDef } from "../types/pipeline";

interface ExplorerTreeProps {
  project: Project;
  activeQueryId: string | null;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onSelectQuery: (id: string) => void;
  onSelectSource: (source: SourceDef) => void;
  onExport: () => void;
  onAddSourceCsv: () => void;
  onAddSourcePostgres: () => void;
  onAddQueryFromActiveSource?: () => void;
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
        <span className="mr-1 w-3 text-[10px] text-slate-600">{open ? "▾" : "▸"}</span>
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
  expanded,
  onToggle,
  onSelectQuery,
  onSelectSource,
  onExport,
  onAddSourceCsv,
  onAddSourcePostgres,
}: ExplorerTreeProps) {
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
            title="Sources"
            open={sourcesOpen}
            count={project.sources.length}
            onToggle={() => onToggle("sources")}
            actions={
              <>
                <IconBtn title="Add CSV source" onClick={onAddSourceCsv}>
                  +
                </IconBtn>
                <IconBtn title="Add Postgres source" onClick={onAddSourcePostgres}>
                  <span className="text-[9px] font-bold">PG</span>
                </IconBtn>
              </>
            }
          />
          {sourcesOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.sources.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  No sources — use +
                </li>
              )}
              {project.sources.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSource(s)}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-slate-300 hover:bg-slate-800/80"
                  >
                    <span className="w-8 shrink-0 text-[9px] uppercase text-teal-600">
                      {s.kind === "postgres" ? "pg" : s.kind}
                    </span>
                    <span className="truncate">{s.name}</span>
                  </button>
                </li>
              ))}
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
              <IconBtn title="New query from CSV" onClick={onAddSourceCsv}>
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
                        <span className="ml-auto text-[9px] text-teal-400">★</span>
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
            onToggle={() => onToggle("export")}
            actions={
              <IconBtn title="Export dbt" onClick={onExport}>
                +
              </IconBtn>
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
                  {project.last_dbt_export_path && (
                    <span className="mt-0.5 block truncate text-[10px] text-slate-600">
                      {project.last_dbt_export_path}
                    </span>
                  )}
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
    </nav>
  );
}
