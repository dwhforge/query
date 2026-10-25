import { useEffect, useRef, useState } from "react";
import type { WarehouseDialect } from "../types/pipeline";
import type { DemoId } from "./EmptyHero";

export interface AppMenuProps {
  projectName: string;
  projectPath?: string;
  targetDialect: WarehouseDialect;
  canExport: boolean;
  canCopySql: boolean;
  sqlCopied: boolean;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onViewData: () => void;
  onViewModel: () => void;
  onCopySql: () => void;
  onNewConnection: () => void;
  onSetTargetDialect: (d: WarehouseDialect) => void;
  onLoadDemo: (id: DemoId) => void;
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
  /** A menu is open — hover switches to this one. */
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
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={onClick}
        className={`rounded px-2.5 py-1 text-xs font-medium transition ${
          open
            ? "bg-slate-800 text-teal-200"
            : "text-slate-300 hover:bg-slate-800/80 hover:text-slate-100"
        }`}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-0.5 min-w-[12rem] rounded-lg border border-slate-700 bg-[#0a1219] py-1 shadow-xl shadow-black/50"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function Item({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-teal-500/15 hover:text-teal-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="min-w-0 flex-1">{label}</span>
      {hint && (
        <span className="shrink-0 font-mono text-[10px] text-slate-500">
          {hint}
        </span>
      )}
    </button>
  );
}

function Sep() {
  return <div className="my-1 border-t border-slate-800" role="separator" />;
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
      {children}
    </div>
  );
}

export function AppMenu({
  projectName,
  projectPath,
  targetDialect,
  canExport,
  canCopySql,
  sqlCopied,
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  onViewData,
  onViewModel,
  onCopySql,
  onNewConnection,
  onSetTargetDialect,
  onLoadDemo,
}: AppMenuProps) {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const menubarActive = openMenu !== null;

  useEffect(() => {
    if (!menubarActive) return;
    function onDoc(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menubarActive]);

  function close() {
    setOpenMenu(null);
  }

  function toggle(id: MenuId) {
    setOpenMenu((cur) => (cur === id ? null : id));
  }

  function run(fn: () => void) {
    close();
    fn();
  }

  return (
    <header className="relative z-20 flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5 backdrop-blur">
      <nav
        ref={navRef}
        className="flex items-center gap-0.5"
        aria-label="Application"
      >
        <MenuBarItem
          label="File"
          open={openMenu === "file"}
          menubarActive={menubarActive}
          onClick={() => toggle("file")}
          onHoverOpen={() => setOpenMenu("file")}
        >
          <Item label="Open project…" hint="⌘O" onClick={() => run(onOpen)} />
          <Item label="Save" hint="⌘S" onClick={() => run(onSave)} />
          <Item label="Save as…" onClick={() => run(onSaveAs)} />
          <Sep />
          <Item
            label="Export dbt…"
            hint="E"
            disabled={!canExport}
            onClick={() => run(onExport)}
          />
        </MenuBarItem>

        <MenuBarItem
          label="View"
          open={openMenu === "view"}
          menubarActive={menubarActive}
          onClick={() => toggle("view")}
          onHoverOpen={() => setOpenMenu("view")}
        >
          <Item label="Data tab" hint="/" onClick={() => run(onViewData)} />
          <Item label="Model tab" onClick={() => run(onViewModel)} />
          <Sep />
          <Item
            label={sqlCopied ? "Copied" : "Copy SQL"}
            disabled={!canCopySql}
            onClick={() => run(onCopySql)}
          />
        </MenuBarItem>

        <MenuBarItem
          label="Project"
          open={openMenu === "project"}
          menubarActive={menubarActive}
          onClick={() => toggle("project")}
          onHoverOpen={() => setOpenMenu("project")}
        >
          <Item
            label="New connection…"
            onClick={() => run(onNewConnection)}
          />
          <Sep />
          <SubLabel>Export warehouse</SubLabel>
          <Item
            label={
              targetDialect === "duckdb"
                ? "✓ DuckDB"
                : "DuckDB"
            }
            onClick={() => run(() => onSetTargetDialect("duckdb"))}
          />
          <Item
            label={
              targetDialect === "postgres"
                ? "✓ Postgres"
                : "Postgres"
            }
            onClick={() => run(() => onSetTargetDialect("postgres"))}
          />
          <p className="px-3 py-1.5 text-[10px] leading-snug text-slate-500">
            Dialect for dbt emit. Preview: local=DuckDB; query
            execution=target runs on warehouse.
          </p>
        </MenuBarItem>

        <MenuBarItem
          label="Help"
          open={openMenu === "help"}
          menubarActive={menubarActive}
          onClick={() => toggle("help")}
          onHoverOpen={() => setOpenMenu("help")}
        >
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
        </MenuBarItem>
      </nav>

      <div
        className="ml-auto flex min-w-0 max-w-[60%] items-center gap-2"
      >
        <span
          className="shrink-0 rounded border border-slate-700 bg-slate-950/80 px-2 py-0.5 font-mono text-[10px] text-slate-300"
          title="Project warehouse dialect (dbt export). DuckDB preview emulates dbt-on-duckdb; postgres target needs execution=target for honest live SQL."
        >
          export → {targetDialect}
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
