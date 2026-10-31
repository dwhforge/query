import { memo, useEffect, useState } from "react";
import { openDialog } from "../lib/bridge";

interface Props {
  open: boolean;
  confirmLabel: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

function HiveParquetDialogImpl({ open, confirmLabel, onClose, onSelect }: Props) {
  const [path, setPath] = useState("");

  useEffect(() => {
    if (open) setPath("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function browse() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string" && selected) setPath(selected);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--line)] bg-[#0a121c] shadow-2xl">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 className="text-sm font-semibold text-teal-300">
            Add Hive Parquet
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Directory of Parquet files. Folders like{" "}
            <span className="font-mono">year=2024/month=01</span> become
            columns.
          </p>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Directory path
            </label>
            <div className="flex gap-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                placeholder="/data/hive/warehouse/sales"
              />
              <button
                type="button"
                onClick={() => void browse()}
                className="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-teal-700"
              >
                Browse…
              </button>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              Table root, or a glob such as{" "}
              <span className="font-mono">…/sales/**/*.parquet</span>.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!path.trim()}
            onClick={() => onSelect(path.trim())}
            className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export const HiveParquetDialog = memo(HiveParquetDialogImpl);
