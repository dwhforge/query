import { useEffect, useRef, useState } from "react";
import type {
  ConnectionDef,
  DestinationKind,
  ExecutionEngine,
  WarehouseDialect,
} from "../types/pipeline";
import type { DemoId } from "./EmptyHero";

export interface AppMenuProps {
  projectName: string;
  projectPath?: string;
  /** @deprecated prefer executionEngine + destinationKind */
  targetDialect: WarehouseDialect;
  executionEngine: ExecutionEngine;
  destinationKind: DestinationKind;
  destinationConnectionId?: string;
  postgresConnections: ConnectionDef[];
  canExport: boolean;
  canCopySql: boolean;
  sqlCopied: boolean;
  onOpen: () => void;
  recentProjects?: string[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  onOptions: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onParseExport?: () => void;
  onBuildExport?: () => void;
  onViewData: () => void;
  onViewModel: () => void;
  onCopySql: () => void;
  onNewConnection: () => void;
  onSetExecutionEngine: (e: ExecutionEngine) => void;
  onSetDestinationKind: (d: DestinationKind) => void;
  onSetDestinationConnection: (id: string | undefined) => void;
  /** Legacy: sets both engine and destination to the same dialect. */
  onSetTargetDialect: (d: WarehouseDialect) => void;
  onLoadDemo: (id: DemoId) => void;
  onOpenHelp: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onToggleFullscreen?: () => void;
  onCloseWindow?: () => void;
  routeBadge: string;
}

function recentLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

type MenuId = "file" | "view" | "project" | "help";

function MenuBarItem({
  label,
  open,
  menubarActive,
  onClick,
  onHoverOpen,
  children,
}: {
  label: string;
  open: boolean;
  menubarActive: boolean;
  onClick: () => void;
  onHoverOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative"
      onMouseEnter={() => {
        if (menubarActive) onHoverOpen();
      }}
    >
      <button
        type="button"
        className={`rounded px-2 py-1 text-[12px] ${
          open
            ? "bg-slate-800 text-slate-100"
            : "text-slate-300 hover:bg-slate-800/80"
        }`}
        onClick={onClick}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-0.5 min-w-[240px] rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {children}
        </div>
      )}
    </div>
  );
}

function Item({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-[12px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
      onClick={onClick}
    >
      <span>{label}</span>
      {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
    </button>
  );
}

function Sep() {
  return <div className="my-1 border-t border-slate-800" />;
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </div>
  );
}

function OpenRecentSubmenu({
  paths,
  onOpenRecent,
  onClearRecent,
  run,
}: {
  paths: string[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  run: (fn: () => void) => void;
}) {
  const [fly, setFly] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setFly(true)}
      onMouseLeave={() => setFly(false)}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-[12px] text-slate-200 hover:bg-slate-800"
        onClick={(e) => {
          e.stopPropagation();
          setFly((v) => !v);
        }}
      >
        <span>Open Recent</span>
        <span className="text-[10px] text-slate-500">▸</span>
      </button>
      {fly && (
        <div className="absolute left-full top-0 z-50 ml-0.5 min-w-[260px] max-w-[360px] rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {paths.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-slate-500">
              No recent projects
            </div>
          ) : (
            paths.map((p) => (
              <button
                key={p}
                type="button"
                title={p}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-slate-800"
                onClick={() => run(() => onOpenRecent(p))}
              >
                <span className="text-[12px] text-slate-200">
                  {recentLabel(p)}
                </span>
                <span className="max-w-full truncate text-[10px] text-slate-500">
                  {p}
                </span>
              </button>
            ))
          )}
          <Sep />
          <Item
            label="Clear recently opened"
            disabled={paths.length === 0}
            onClick={() => run(onClearRecent)}
          />
        </div>
      )}
    </div>
  );
}

export function AppMenu({
  projectName,
  projectPath,
  executionEngine,
  destinationKind,
  destinationConnectionId,
  postgresConnections,
  canExport,
  canCopySql,
  sqlCopied,
  onOpen,
  recentProjects = [],
  onOpenRecent,
  onClearRecent,
  onOptions,
  onSave,
  onSaveAs,
  onExport,
  onParseExport,
  onBuildExport,
  onViewData,
  onViewModel,
  onCopySql,
  onNewConnection,
  onSetExecutionEngine,
  onSetDestinationKind,
  onSetDestinationConnection,
  onLoadDemo,
  onOpenHelp,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleFullscreen,
  onCloseWindow,
  routeBadge,
}: AppMenuProps) {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const menubarActive = openMenu !== null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function toggle(id: MenuId) {
    setOpenMenu((m) => (m === id ? null : id));
  }

  function run(fn: () => void) {
    setOpenMenu(null);
    fn();
  }

  return (
    <header
      ref={rootRef}
      className="flex h-9 shrink-0 items-center gap-1 border-b border-slate-800 bg-slate-950 px-2"
    >
      <nav className="flex items-center gap-0.5">
        <MenuBarItem
          label="File"
          open={openMenu === "file"}
          menubarActive={menubarActive}
          onClick={() => toggle("file")}
          onHoverOpen={() => setOpenMenu("file")}
        >
          <Item label="Open…" hint="⌘O" onClick={() => run(onOpen)} />
          <OpenRecentSubmenu
            paths={recentProjects}
            onOpenRecent={onOpenRecent}
            onClearRecent={onClearRecent}
            run={run}
          />
          <Item label="Save" hint="⌘S" onClick={() => run(onSave)} />
          <Item label="Save as…" onClick={() => run(onSaveAs)} />
          <Sep />
          <Item
            label="Export dbt…"
            disabled={!canExport}
            onClick={() => run(onExport)}
          />
          {onParseExport && (
            <Item
              label="Parse export…"
              disabled={!canExport}
              onClick={() => run(onParseExport)}
            />
          )}
          {onBuildExport && (
            <Item
              label="Build export…"
              disabled={!canExport}
              onClick={() => run(onBuildExport)}
            />
          )}
          <Sep />
          <Item label="Options…" onClick={() => run(onOptions)} />
          {onCloseWindow && (
            <>
              <Sep />
              <Item label="Close window" onClick={() => run(onCloseWindow)} />
            </>
          )}
        </MenuBarItem>

        <MenuBarItem
          label="View"
          open={openMenu === "view"}
          menubarActive={menubarActive}
          onClick={() => toggle("view")}
          onHoverOpen={() => setOpenMenu("view")}
        >
          <Item label="Data preview" onClick={() => run(onViewData)} />
          <Item label="Model SQL" onClick={() => run(onViewModel)} />
          <Item
            label={sqlCopied ? "Copied!" : "Copy SQL"}
            disabled={!canCopySql}
            onClick={() => run(onCopySql)}
          />
          {(onZoomIn || onZoomOut || onZoomReset || onToggleFullscreen) && (
            <>
              <Sep />
              {onZoomIn && (
                <Item label="Zoom in" hint="⌘+" onClick={() => run(onZoomIn)} />
              )}
              {onZoomOut && (
                <Item
                  label="Zoom out"
                  hint="⌘-"
                  onClick={() => run(onZoomOut)}
                />
              )}
              {onZoomReset && (
                <Item
                  label="Actual size"
                  hint="⌘0"
                  onClick={() => run(onZoomReset)}
                />
              )}
              {onToggleFullscreen && (
                <Item
                  label="Toggle full screen"
                  hint="F11"
                  onClick={() => run(onToggleFullscreen)}
                />
              )}
            </>
          )}
        </MenuBarItem>

        <MenuBarItem
          label="Project"
          open={openMenu === "project"}
          menubarActive={menubarActive}
          onClick={() => toggle("project")}
          onHoverOpen={() => setOpenMenu("project")}
        >
          <Item label="New connection…" onClick={() => run(onNewConnection)} />
          <Sep />
          <SubLabel>Execution engine (SQL dialect)</SubLabel>
          <Item
            label={executionEngine === "duckdb" ? "✓ DuckDB" : "DuckDB"}
            onClick={() => run(() => onSetExecutionEngine("duckdb"))}
          />
          <Item
            label={executionEngine === "postgres" ? "✓ PostgreSQL" : "PostgreSQL"}
            onClick={() => run(() => onSetExecutionEngine("postgres"))}
          />
          <SubLabel>Destination (materialize)</SubLabel>
          <Item
            label={destinationKind === "duckdb" ? "✓ DuckDB file" : "DuckDB file"}
            onClick={() => run(() => onSetDestinationKind("duckdb"))}
          />
          <Item
            label={
              destinationKind === "postgres" ? "✓ PostgreSQL" : "PostgreSQL"
            }
            onClick={() => run(() => onSetDestinationKind("postgres"))}
          />
          {destinationKind === "postgres" && (
            <>
              <SubLabel>Destination connection</SubLabel>
              {postgresConnections.length === 0 ? (
                <p className="px-3 py-1.5 text-[10px] text-amber-400/90">
                  Add a Postgres connection first
                </p>
              ) : (
                postgresConnections.map((c) => (
                  <Item
                    key={c.id}
                    label={
                      destinationConnectionId === c.id
                        ? `✓ ${c.name || c.id}`
                        : c.name || c.id
                    }
                    onClick={() =>
                      run(() => onSetDestinationConnection(c.id))
                    }
                  />
                ))
              )}
            </>
          )}
          <p className="px-3 py-1.5 text-[10px] leading-snug text-slate-500">
            Engine = SQL dialect for emit/preview honesty. Destination = where
            dbt writes. Files/S3 need DuckDB engine (Files→PG via ATTACH).
          </p>
        </MenuBarItem>

        <MenuBarItem
          label="Help"
          open={openMenu === "help"}
          menubarActive={menubarActive}
          onClick={() => toggle("help")}
          onHoverOpen={() => setOpenMenu("help")}
        >
          <Item label="User guide…" onClick={() => run(onOpenHelp)} />
          <Sep />
          <SubLabel>Load demo</SubLabel>
          <Item
            label="Sales — medallion · join · top-N"
            onClick={() => run(() => onLoadDemo("sales"))}
          />
          <Item
            label="Union — Append multi-feed"
            onClick={() => run(() => onLoadDemo("union"))}
          />
          <Item
            label="SQL hybrid — SqlModel · window"
            onClick={() => run(() => onLoadDemo("sql"))}
          />
          <Item
            label="Right joins — two RIGHT OUTER · coverage"
            onClick={() => run(() => onLoadDemo("right"))}
          />
          <Item
            label="Key mapping — F&B aliases · daily → month"
            onClick={() => run(() => onLoadDemo("keymap"))}
          />
        </MenuBarItem>
      </nav>

      <div className="ml-auto flex min-w-0 max-w-[60%] items-center gap-2">
        <span
          className="shrink-0 rounded border border-slate-700 bg-slate-950/80 px-2 py-0.5 font-mono text-[10px] text-slate-300"
          title="execution_engine → destination"
        >
          {routeBadge}
        </span>
        <div
          className="min-w-0 flex-1 rounded-md border border-slate-800/80 bg-slate-950/50 px-2.5 py-1 text-right"
          title={projectPath || "Not saved to disk"}
        >
          <div className="truncate text-[11px] font-semibold text-teal-200/95">
            {projectName || "Untitled"}
            {!projectPath && (
              <span className="ml-1.5 font-normal text-amber-500/90">
                · unsaved
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-slate-400">
            {projectPath ?? "File → Save as… to choose a path"}
          </div>
        </div>
      </div>
    </header>
  );
}
