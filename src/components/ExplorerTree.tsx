import { useEffect, useRef, useState } from "react";
import type { ReferenceStatus } from "../lib/bridge";
import {
  referenceStateLabel,
  referenceStateTone,
} from "../lib/projectRefs";
import {
  isPublishedOutput,
  type ConnectionDef,
  type KeyMapDef,
  type Project,
  type ProjectReference,
  type QueryDef,
  type SourceDef,
} from "../types/pipeline";

interface ExplorerTreeProps {
  project: Project;
  activeQueryId: string | null;
  selectedSourceId: string | null;
  selectedKeyMapId?: string | null;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onSelectQuery: (id: string) => void;
  onSelectSource: (source: SourceDef) => void;
  onSelectConnection: (conn: ConnectionDef) => void;
  onExport: () => void;
  onRevealExport?: () => void;
  exportFiles?: string[];
  referenceStatuses?: ReferenceStatus[];
  /** Owner catalogs keyed by reference id (for browse + use-in-new-query). */
  referenceCatalogs?: Record<
    string,
    {
      alias: string;
      queries: { id: string; name: string }[];
      maps: { id: string; name: string }[];
    }
  >;
  onAddReference: () => void;
  onRefreshReference: (ref: ProjectReference) => void;
  onRelinkReference: (ref: ProjectReference) => void;
  onOpenReferenceOwner: (ref: ProjectReference) => void;
  onRemoveReference: (ref: ProjectReference) => void;
  /** Local derivation: FromQuery → referenced query (ADR-0025). */
  onUseReferencedQuery: (referenceId: string, queryId: string, nameHint: string) => void;
  onAddConnection: () => void;
  /** Catalog only — no query. */
  onAddSourceCsv: () => void;
  onAddSourceParquet: () => void;
  onAddSourceHiveParquet: () => void;
  onAddSourceS3: () => void;
  onAddSourcePostgres: () => void;
  /** New source + query in one go (Queries menu). */
  onNewQueryCsv: () => void;
  onNewQueryParquet: () => void;
  onNewQueryHiveParquet: () => void;
  onNewQueryS3: () => void;
  onNewQueryPostgres: () => void;
  onNewQueryFromSource: (source: SourceDef) => void;
  onNewSqlModel: () => void;
  onRenameQuery: (queryId: string, name: string) => void;
  onRenameSource: (sourceId: string, name: string) => void;
  onSelectKeyMap: (map: KeyMapDef) => void;
  onAddKeyMap: () => void;
  onRenameKeyMap: (mapId: string, name: string) => void;
  onDeleteKeyMap: (mapId: string) => void;
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

function MenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-teal-500/15 hover:text-teal-100"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && (
        <span className="shrink-0 text-[9px] uppercase text-slate-500">
          {hint}
        </span>
      )}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 border-t border-slate-800" />;
}

function PlusMenu({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-40 mt-0.5 max-h-72 w-56 overflow-auto rounded-lg border border-slate-700 bg-[#0a1219] py-1 shadow-xl shadow-black/50"
      role="menu"
    >
      {children}
    </div>
  );
}

function InlineRename({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onCommit(draft);
        else onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          if (draft.trim()) onCommit(draft);
          else onCancel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="min-w-0 flex-1 rounded border border-teal-700/60 bg-slate-950 px-1 py-0.5 font-mono text-[11px] text-slate-100 outline-none"
    />
  );
}

function sourceKindHint(s: SourceDef): string {
  if (s.kind === "postgres") return "pg";
  return s.kind;
}

function keyMapStorageHint(m: KeyMapDef): string {
  const s = m.storage ?? { kind: "seed" as const };
  if (s.kind === "ref") return "ref";
  if (s.kind === "source") return "src";
  return "seed";
}

export function ExplorerTree({
  project,
  activeQueryId,
  selectedSourceId,
  selectedKeyMapId = null,
  expanded,
  onToggle,
  onSelectQuery,
  onSelectSource,
  onSelectConnection,
  onExport,
  onRevealExport,
  exportFiles = [],
  referenceStatuses = [],
  referenceCatalogs = {},
  onAddReference,
  onRefreshReference,
  onRelinkReference,
  onOpenReferenceOwner,
  onRemoveReference,
  onUseReferencedQuery,
  onAddConnection,
  onAddSourceCsv,
  onAddSourceParquet,
  onAddSourceHiveParquet,
  onAddSourceS3,
  onAddSourcePostgres,
  onNewQueryCsv,
  onNewQueryParquet,
  onNewQueryHiveParquet,
  onNewQueryS3,
  onNewQueryPostgres,
  onNewQueryFromSource,
  onNewSqlModel,
  onRenameQuery,
  onRenameSource,
  onSelectKeyMap,
  onAddKeyMap,
  onRenameKeyMap,
  onDeleteKeyMap,
}: ExplorerTreeProps) {
  const connectionsOpen = expanded.connections !== false;
  const sourcesOpen = expanded.sources !== false;
  const queriesOpen = expanded.queries !== false;
  const keyMapsOpen = expanded.keyMaps !== false;
  const referencesOpen = expanded.references !== false;
  const exportOpen = expanded.export !== false;
  const focus = project.workspace.focus_query_id;
  const keyMaps = project.workspace.key_maps ?? [];
  const references = project.references ?? [];
  const statusById = new Map(
    referenceStatuses.map((s) => [s.reference_id, s] as const),
  );

  const [sourcesMenuOpen, setSourcesMenuOpen] = useState(false);
  const [queriesMenuOpen, setQueriesMenuOpen] = useState(false);
  const [refRowOpen, setRefRowOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<
    { kind: "query" | "source" | "keymap"; id: string } | null
  >(null);

  function closeMenus() {
    setSourcesMenuOpen(false);
    setQueriesMenuOpen(false);
  }

  const sourceOnlyItems = (
    <>
      <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        New source
      </div>
      <MenuItem
        label="CSV…"
        hint="file"
        onClick={() => {
          closeMenus();
          onAddSourceCsv();
        }}
      />
      <MenuItem
        label="Parquet…"
        hint="file"
        onClick={() => {
          closeMenus();
          onAddSourceParquet();
        }}
      />
      <MenuItem
        label="Hive Parquet…"
        hint="directory"
        onClick={() => {
          closeMenus();
          onAddSourceHiveParquet();
        }}
      />
      <MenuItem
        label="S3 Parquet…"
        hint="s3"
        onClick={() => {
          closeMenus();
          onAddSourceS3();
        }}
      />
      <MenuItem
        label="Postgres table…"
        hint="pg"
        onClick={() => {
          closeMenus();
          onAddSourcePostgres();
        }}
      />
    </>
  );

  const newSourceAndQueryItems = (
    <>
      <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        New source + query
      </div>
      <MenuItem
        label="CSV…"
        hint="file"
        onClick={() => {
          closeMenus();
          onNewQueryCsv();
        }}
      />
      <MenuItem
        label="Parquet…"
        hint="file"
        onClick={() => {
          closeMenus();
          onNewQueryParquet();
        }}
      />
      <MenuItem
        label="Hive Parquet…"
        hint="directory"
        onClick={() => {
          closeMenus();
          onNewQueryHiveParquet();
        }}
      />
      <MenuItem
        label="S3 Parquet…"
        hint="s3"
        onClick={() => {
          closeMenus();
          onNewQueryS3();
        }}
      />
      <MenuItem
        label="Postgres table…"
        hint="pg"
        onClick={() => {
          closeMenus();
          onNewQueryPostgres();
        }}
      />
    </>
  );

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
              <>
                <span
                  className="mr-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-600"
                  title="Shared across all projects"
                >
                  Global
                </span>
                <IconBtn title="New connection" onClick={onAddConnection}>
                  +
                </IconBtn>
              </>
            }
          />
          {connectionsOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.connections.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  PG / S3 credentials (app-wide) — use +
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
              <div className="relative">
                <IconBtn
                  title="Add source (catalog only)"
                  onClick={() => {
                    setQueriesMenuOpen(false);
                    setSourcesMenuOpen((o) => !o);
                  }}
                >
                  +
                </IconBtn>
                <PlusMenu
                  open={sourcesMenuOpen}
                  onClose={() => setSourcesMenuOpen(false)}
                >
                  {sourceOnlyItems}
                </PlusMenu>
              </div>
            }
          />
          {sourcesOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.sources.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  No sources — + to add
                </li>
              )}
              {project.sources.map((s) => {
                const selected = s.id === selectedSourceId;
                const editing =
                  renaming?.kind === "source" && renaming.id === s.id;
                return (
                  <li key={s.id} className="group/src flex items-center gap-0.5">
                    {editing ? (
                      <div className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-0.5">
                        <span className="w-8 shrink-0 text-[9px] uppercase text-teal-600">
                          {sourceKindHint(s)}
                        </span>
                        <InlineRename
                          value={s.name}
                          onCommit={(name) => {
                            onRenameSource(s.id, name);
                            setRenaming(null);
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectSource(s)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "source", id: s.id });
                        }}
                        title="Double-click to rename"
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${
                          selected
                            ? "bg-teal-500/15 text-teal-100"
                            : "text-slate-300 hover:bg-slate-800/80"
                        }`}
                      >
                        <span className="w-8 shrink-0 text-[9px] uppercase text-teal-600">
                          {sourceKindHint(s)}
                        </span>
                        <span className="truncate">{s.name}</span>
                      </button>
                    )}
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
              <div className="relative">
                <IconBtn
                  title="New query — pick source or create"
                  onClick={() => {
                    setSourcesMenuOpen(false);
                    setQueriesMenuOpen((o) => !o);
                  }}
                >
                  +
                </IconBtn>
                <PlusMenu
                  open={queriesMenuOpen}
                  onClose={() => setQueriesMenuOpen(false)}
                >
                  {project.sources.length > 0 && (
                    <>
                      <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        From source
                      </div>
                      {project.sources.map((s) => (
                        <MenuItem
                          key={s.id}
                          label={s.name}
                          hint={sourceKindHint(s)}
                          onClick={() => {
                            closeMenus();
                            onNewQueryFromSource(s);
                          }}
                        />
                      ))}
                      <MenuDivider />
                    </>
                  )}
                  {newSourceAndQueryItems}
                  {references.some(
                    (r) => (referenceCatalogs[r.id]?.queries.length ?? 0) > 0,
                  ) && (
                    <>
                      <MenuDivider />
                      <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        From reference
                      </div>
                      {references.flatMap((r) => {
                        const cat = referenceCatalogs[r.id];
                        if (!cat?.queries.length) return [];
                        return cat.queries.map((q) => (
                          <MenuItem
                            key={`${r.id}:${q.id}`}
                            label={`${r.alias}.${q.name}`}
                            hint="ref"
                            onClick={() => {
                              closeMenus();
                              onUseReferencedQuery(
                                r.id,
                                q.id,
                                `${r.alias}_${q.name}`,
                              );
                            }}
                          />
                        ));
                      })}
                    </>
                  )}
                  <MenuDivider />
                  <MenuItem
                    label="SQL model"
                    hint="root"
                    onClick={() => {
                      closeMenus();
                      onNewSqlModel();
                    }}
                  />
                </PlusMenu>
              </div>
            }
          />
          {queriesOpen && (
            <ul className="mb-2 ml-3 border-l border-[var(--line)] pl-2">
              {project.workspace.queries.length === 0 && (
                <li className="py-1 text-xs text-slate-600">
                  + → pick source or new
                </li>
              )}
              {project.workspace.queries.map((q: QueryDef) => {
                const active = q.id === activeQueryId;
                const isFocus = q.id === focus;
                const published = isPublishedOutput(project, q.id);
                const editing =
                  renaming?.kind === "query" && renaming.id === q.id;
                return (
                  <li key={q.id}>
                    {editing ? (
                      <div className="flex w-full items-center gap-1 px-1.5 py-0.5">
                        <InlineRename
                          value={q.name}
                          onCommit={(name) => {
                            onRenameQuery(q.id, name);
                            setRenaming(null);
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectQuery(q.id)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "query", id: q.id });
                        }}
                        title="Double-click to rename"
                        className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs ${
                          active
                            ? "bg-teal-500/15 text-teal-100"
                            : "text-slate-300 hover:bg-slate-800/80"
                        }`}
                      >
                        <span className="truncate">{q.name}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {published && (
                            <span
                              className="text-[9px] text-amber-400/90"
                              title="Published to destination (mart)"
                            >
                              ↑
                            </span>
                          )}
                          {isFocus && (
                            <span className="text-[9px] text-teal-400">★</span>
                          )}
                        </span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-1">
          <SectionHeader
            title="Mappings"
            open={keyMapsOpen}
            count={keyMaps.length}
            onToggle={() => onToggle("keyMaps")}
            actions={
              <IconBtn title="New mapping" onClick={onAddKeyMap}>
                +
              </IconBtn>
            }
          />
          {keyMapsOpen && (
            <ul className="ml-3 border-l border-[var(--line)] pl-2">
              {keyMaps.length === 0 && (
                <li className="px-1.5 py-1 text-[11px] text-slate-600">
                  No maps — + to create
                </li>
              )}
              {keyMaps.map((m) => {
                const active = selectedKeyMapId === m.id;
                const isRenaming =
                  renaming?.kind === "keymap" && renaming.id === m.id;
                return (
                  <li key={m.id} className="group/row flex items-center gap-0.5">
                    {isRenaming ? (
                      <InlineRename
                        value={m.name}
                        onCommit={(name) => {
                          onRenameKeyMap(m.id, name);
                          setRenaming(null);
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectKeyMap(m)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "keymap", id: m.id });
                        }}
                        title="Open editor · double-click to rename"
                        className={`flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs ${
                          active
                            ? "bg-teal-500/15 text-teal-100"
                            : "text-slate-300 hover:bg-slate-800/80"
                        }`}
                      >
                        <span className="truncate">{m.name}</span>
                        <span className="ml-auto shrink-0 text-[9px] uppercase text-slate-600">
                          {keyMapStorageHint(m)} · {m.entries.length}
                        </span>
                      </button>
                    )}
                    {!isRenaming && (
                      <IconBtn
                        title="Delete KeyMap (ApplyKeyMap steps + seed CSV if exported)"
                        onClick={() => {
                          const seedCsv =
                            project.last_dbt_export_path &&
                            (!m.storage || m.storage.kind === "seed");
                          if (
                            window.confirm(
                              `Delete KeyMap “${m.name}”? ApplyKeyMap steps that use it will be removed.${
                                seedCsv
                                  ? " The export seed CSV will be deleted too."
                                  : ""
                              }`,
                            )
                          ) {
                            onDeleteKeyMap(m.id);
                          }
                        }}
                      >
                        ×
                      </IconBtn>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-1">
          <SectionHeader
            title="References"
            open={referencesOpen}
            count={references.length || undefined}
            onToggle={() => onToggle("references")}
            actions={
              <IconBtn title="Add reference to another project" onClick={onAddReference}>
                +
              </IconBtn>
            }
          />
          {referencesOpen && (
            <ul className="ml-3 border-l border-[var(--line)] pl-2">
              {references.length === 0 && (
                <li className="px-1.5 py-1 text-[11px] text-slate-600">
                  No referenced projects
                </li>
              )}
              {references.map((ref) => {
                const st = statusById.get(ref.id);
                const state = st?.state ?? "missing";
                const canUpdate = state === "update_available";
                const canRelink =
                  state === "missing" || state === "identity_mismatch";
                const cat = referenceCatalogs[ref.id];
                const open = refRowOpen[ref.id] !== false;
                const ownerQueries = cat?.queries ?? [];
                return (
                  <li
                    key={ref.id}
                    className="py-0.5"
                    title={st?.message ?? ref.locator}
                  >
                    <div className="group/ref flex items-start gap-0.5">
                      <button
                        type="button"
                        className="mt-1 w-3 shrink-0 text-[10px] text-slate-600 hover:text-slate-300"
                        title={open ? "Collapse" : "Show owner queries"}
                        onClick={() =>
                          setRefRowOpen((m) => ({
                            ...m,
                            [ref.id]: !open,
                          }))
                        }
                      >
                        {open ? "▾" : "▸"}
                      </button>
                      <div className="min-w-0 flex-1 rounded-md px-1 py-1">
                        <div className="truncate text-xs text-slate-200">
                          {ref.alias}
                        </div>
                        <div
                          className={`truncate text-[10px] ${referenceStateTone(state)}`}
                        >
                          {referenceStateLabel(state)}
                          {ownerQueries.length > 0
                            ? ` · ${ownerQueries.length} queries`
                            : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-0.5 opacity-70 group-hover/ref:opacity-100">
                        {canUpdate && (
                          <IconBtn
                            title="Update locked revision"
                            onClick={() => onRefreshReference(ref)}
                          >
                            ↻
                          </IconBtn>
                        )}
                        {canRelink && (
                          <IconBtn
                            title="Relink owner file"
                            onClick={() => onRelinkReference(ref)}
                          >
                            ⤴
                          </IconBtn>
                        )}
                        <IconBtn
                          title="Open owner project file"
                          onClick={() => onOpenReferenceOwner(ref)}
                        >
                          ↗
                        </IconBtn>
                        <IconBtn
                          title="Remove reference"
                          onClick={() => onRemoveReference(ref)}
                        >
                          ×
                        </IconBtn>
                      </div>
                    </div>
                    {open && (
                      <ul className="ml-4 mt-0.5 border-l border-slate-800 pl-2">
                        {ownerQueries.length === 0 && (
                          <li className="px-1.5 py-1 text-[10px] text-slate-600">
                            {state === "ready"
                              ? "No queries in owner"
                              : "Owner catalog unavailable"}
                          </li>
                        )}
                        {ownerQueries.map((q) => (
                          <li
                            key={q.id}
                            className="group/rq flex items-center gap-0.5"
                          >
                            <button
                              type="button"
                              title={`Use ${ref.alias}.${q.name} in a new local query`}
                              onClick={() =>
                                onUseReferencedQuery(
                                  ref.id,
                                  q.id,
                                  `${ref.alias}_${q.name}`,
                                )
                              }
                              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[11px] text-slate-300 hover:bg-sky-500/10 hover:text-sky-100"
                            >
                              <span className="truncate">{q.name}</span>
                              <span className="ml-auto shrink-0 text-[9px] uppercase text-sky-600/80 group-hover/rq:text-sky-400">
                                use
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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
                  dbt ({project.dbt_target}) ·{" "}
                  {project.execution_engine ?? project.target_dialect ?? "duckdb"}
                  {project.destination?.kind &&
                  project.destination.kind !==
                    (project.execution_engine ?? project.target_dialect)
                    ? `→${project.destination.kind}`
                    : ""}
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
