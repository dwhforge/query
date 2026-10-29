import { memo, useEffect, useMemo, useState } from "react";
import type { ConnectionDef } from "../types/pipeline";

export interface S3SourceSelection {
  connection_id: string;
  path: string;
}

interface Props {
  open: boolean;
  connections: ConnectionDef[];
  onClose: () => void;
  onRequestNewConnection: () => void;
  onSelect: (sel: S3SourceSelection) => void;
}

function S3SourceDialogImpl({
  open,
  connections,
  onClose,
  onRequestNewConnection,
  onSelect,
}: Props) {
  const s3Conns = useMemo(
    () => connections.filter((c) => c.kind === "s3"),
    [connections],
  );
  const [connectionId, setConnectionId] = useState("");
  const [path, setPath] = useState("s3://bucket/path/file.parquet");

  useEffect(() => {
    if (!open) return;
    if (!connectionId && s3Conns[0]) setConnectionId(s3Conns[0].id);
  }, [open, s3Conns, connectionId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const selected = s3Conns.find((c) => c.id === connectionId);

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
            Add Parquet from S3
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Pick a Project Connection (endpoint, keys, VERIFY_SSL…) then the
            object path.
          </p>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                S3 connection
              </label>
              <button
                type="button"
                onClick={onRequestNewConnection}
                className="text-[11px] text-teal-400 hover:text-teal-300"
              >
                + New connection
              </button>
            </div>
            {s3Conns.length === 0 ? (
              <p className="rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/90">
                No S3 connections yet — create one first.
              </p>
            ) : (
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
              >
                {s3Conns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.s3?.endpoint ? ` · ${c.s3.endpoint}` : ""}
                    {c.s3 && !c.s3.verify_ssl ? " · VERIFY_SSL=off" : ""}
                  </option>
                ))}
              </select>
            )}
            {selected?.s3 && (
              <p className="mt-1 font-mono text-[10px] text-slate-600">
                region={selected.s3.region ?? "—"} · ssl={String(selected.s3.use_ssl)} ·
                verify={String(selected.s3.verify_ssl)} ·{" "}
                {selected.s3.provider}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Path
            </label>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
              placeholder="s3://bucket/key.parquet"
            />
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
            disabled={!connectionId || !path.trim()}
            onClick={() =>
              onSelect({ connection_id: connectionId, path: path.trim() })
            }
            className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
          >
            Add as query
          </button>
        </div>
      </div>
    </div>
  );
}

export const S3SourceDialog = memo(S3SourceDialogImpl);
