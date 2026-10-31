import { useState } from "react";
import {
  dbtInstallScript,
  installDbtVenv,
  type DbtSetupStatus,
} from "../lib/bridge";

export type DbtSetupDialogProps = {
  open: boolean;
  status: DbtSetupStatus | null;
  /** First-run vs Options repeat. */
  variant?: "first-run" | "options";
  onClose: () => void;
  onInstalled: (venvPath: string) => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
};

export function DbtSetupDialog({
  open,
  status,
  variant = "first-run",
  onClose,
  onInstalled,
  onDismiss,
}: DbtSetupDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  if (!open) return null;

  const venv = status?.suggestedVenv ?? "~/.dwhforge-query/dbt-venv";

  async function copyScript() {
    setError(null);
    setCopied(false);
    try {
      const s = await dbtInstallScript();
      await navigator.clipboard.writeText(s.script);
      setCopied(true);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function install() {
    setBusy(true);
    setError(null);
    setLog("Creating venv and installing dbt (may take a few minutes)…");
    try {
      const r = await installDbtVenv();
      setLog(`${r.versionLine}\n→ ${r.dbtPath}`);
      await onInstalled(r.venvPath);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setLog(null);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    await onDismiss();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dbt-setup-title"
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-teal-900/40 bg-[#0a1219] shadow-2xl shadow-black/50"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <h2
              id="dbt-setup-title"
              className="text-sm font-semibold text-teal-100"
            >
              {variant === "first-run" ? "Set up dbt" : "Install dbt"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Export Parse/Build need dbt Core 1.x. We can create a venv at{" "}
              <span className="font-mono text-slate-300">{venv}</span> or copy
              the install commands (ADR-0023).
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
          >
            Close
          </button>
        </header>

        <div className="space-y-3 px-4 py-4">
          {status && !status.pythonOk && (
            <p className="rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100/90">
              Python 3 not found on PATH — Install for me will fail. Copy the
              script and run it after installing Python.
            </p>
          )}
          {status?.found && status.dbtPath && (
            <p className="text-xs text-slate-400">
              dbt already found:{" "}
              <span className="font-mono text-slate-300">{status.dbtPath}</span>
            </p>
          )}
          {log && (
            <pre className="max-h-28 overflow-auto rounded border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] text-teal-200/90 whitespace-pre-wrap">
              {log}
            </pre>
          )}
          {error && (
            <p className="rounded border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">
          {variant === "first-run" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void dismiss()}
              className="mr-auto rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-900 disabled:opacity-50"
            >
              Not now
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="mr-auto rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-900 disabled:opacity-50"
            >
              Close
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void copyScript()}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-teal-800 hover:bg-slate-900 disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy install script"}
          </button>
          <button
            type="button"
            disabled={busy || (status != null && !status.pythonOk)}
            onClick={() => void install()}
            className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-teal-950 hover:bg-teal-500 disabled:opacity-50"
          >
            {busy ? "Installing…" : "Install for me"}
          </button>
        </footer>
      </div>
    </div>
  );
}
