import { useEffect, useState } from "react";
import type { AppSettings, DbtSetupStatus } from "../lib/bridge";
import { dbtInstallScript, dbtSetupStatus, openDialog } from "../lib/bridge";
import type { DestinationKind, ExecutionEngine } from "../types/pipeline";
import { DbtSetupDialog } from "./DbtSetupDialog";

export interface OptionsDialogProps {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (next: AppSettings) => void | Promise<void>;
}

function engineFromSettings(s: AppSettings): ExecutionEngine {
  return (
    s.default_execution_engine ?? s.default_target_dialect ?? "duckdb"
  );
}

function destFromSettings(s: AppSettings): DestinationKind {
  return s.default_destination_kind ?? engineFromSettings(s);
}

function dbtHint(venv: string): string {
  const t = venv.trim();
  if (!t) return "Auto: ./dbt-venv, ~/.dwhforge-query/dbt-venv, or dbt on PATH";
  const isWin = t.includes("\\") || /^[A-Za-z]:/.test(t);
  const bin = isWin ? `${t}\\Scripts\\dbt.exe` : `${t}/bin/dbt`;
  return `Will prefer: ${bin}`;
}

export function OptionsDialog({
  open,
  settings,
  onClose,
  onSave,
}: OptionsDialogProps) {
  const [dbtVenv, setDbtVenv] = useState("");
  const [engine, setEngine] = useState<ExecutionEngine>("duckdb");
  const [dest, setDest] = useState<DestinationKind>("duckdb");
  const [dbtTarget, setDbtTarget] = useState<"v1" | "v2">("v1");
  const [saving, setSaving] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStatus, setSetupStatus] = useState<DbtSetupStatus | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDbtVenv(settings.dbt_venv_path ?? "");
    setEngine(engineFromSettings(settings));
    setDest(destFromSettings(settings));
    setDbtTarget(settings.default_dbt_target ?? "v1");
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function browseVenv() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDbtVenv(picked);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({
        ...settings,
        dbt_venv_path: dbtVenv.trim(),
        default_execution_engine: engine,
        default_destination_kind: dest,
        default_target_dialect: engine,
        default_dbt_target: dbtTarget,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="options-dialog-title"
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0a1219] shadow-2xl shadow-black/50"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div>
            <h2
              id="options-dialog-title"
              className="text-sm font-semibold text-teal-100"
            >
              Options
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              App defaults in ~/.dwhforge-query/settings.json (not the open
              project). ADR-0021.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Close
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              dbt virtualenv
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Path to a venv root that contains <code className="text-teal-200/90">bin/dbt</code>
              . Leave empty for auto-discovery.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={dbtVenv}
                onChange={(e) => setDbtVenv(e.target.value)}
                placeholder="/path/to/dbt-venv"
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200 placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => void browseVenv()}
                className="shrink-0 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:bg-slate-900"
              >
                Browse…
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">{dbtHint(dbtVenv)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setCopyMsg(null);
                  void dbtSetupStatus()
                    .then((s) => {
                      setSetupStatus(s);
                      setSetupOpen(true);
                    })
                    .catch((e) =>
                      setCopyMsg(typeof e === "string" ? e : String(e)),
                    );
                }}
                className="rounded border border-teal-900/60 px-2.5 py-1.5 text-xs text-teal-200/90 hover:border-teal-700 hover:bg-teal-950/40"
              >
                Install dbt…
              </button>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      const s = await dbtInstallScript();
                      await navigator.clipboard.writeText(s.script);
                      setCopyMsg("Install script copied to clipboard");
                    } catch (e) {
                      setCopyMsg(typeof e === "string" ? e : String(e));
                    }
                  })();
                }}
                className="rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 hover:bg-slate-900"
              >
                Copy install script
              </button>
            </div>
            {copyMsg && (
              <p className="mt-1.5 text-[11px] text-slate-500">{copyMsg}</p>
            )}
          </section>

          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Defaults for new projects
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Applied when creating Untitled / demos without an open file. The
              Project menu still edits the current project only.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-slate-400">
                Execution engine
                <select
                  value={engine}
                  onChange={(e) =>
                    setEngine(e.target.value as ExecutionEngine)
                  }
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="duckdb">DuckDB</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </label>
              <label className="block text-xs text-slate-400">
                Destination
                <select
                  value={dest}
                  onChange={(e) =>
                    setDest(e.target.value as DestinationKind)
                  }
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="duckdb">DuckDB file</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </label>
              <label className="block text-xs text-slate-400 sm:col-span-2">
                dbt Core line
                <select
                  value={dbtTarget}
                  onChange={(e) =>
                    setDbtTarget(e.target.value as "v1" | "v2")
                  }
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="v1">v1</option>
                  <option value="v2">v2</option>
                </select>
              </label>
            </div>
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-teal-950 hover:bg-teal-500 disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      </div>

      <DbtSetupDialog
        open={setupOpen}
        status={setupStatus}
        variant="options"
        onClose={() => setSetupOpen(false)}
        onInstalled={async (venvPath) => {
          setDbtVenv(venvPath);
          setSetupOpen(false);
          setCopyMsg(`Installed — venv set to ${venvPath}`);
          await onSave({
            ...settings,
            dbt_venv_path: venvPath,
            dbt_setup_dismissed: true,
            default_execution_engine: engine,
            default_destination_kind: dest,
            default_target_dialect: engine,
            default_dbt_target: dbtTarget,
          });
        }}
        onDismiss={async () => {
          /* Options repeat — no dismiss flag change required */
        }}
      />
    </div>
  );
}
