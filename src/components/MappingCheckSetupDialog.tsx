import { useEffect, useMemo, useState } from "react";
import type { InferredCheckAttrs } from "../app/mappingChecks";

export type MappingCheckSetupResult = {
  leftAttrs: string[];
  rightAttrs: string[];
  sampleColumns: string[];
};

type Props = {
  open: boolean;
  mode: "create" | "edit";
  mapName: string;
  hostName: string;
  leftOn: string[];
  rightOn: string[];
  leftColumns: string[];
  rightColumns: string[];
  inferred: InferredCheckAttrs;
  initial?: MappingCheckSetupResult | null;
  onClose: () => void;
  onConfirm: (result: MappingCheckSetupResult) => void;
};

function toggleIn(list: string[], col: string): string[] {
  return list.includes(col) ? list.filter((c) => c !== col) : [...list, col];
}

export function MappingCheckSetupDialog({
  open,
  mode,
  mapName,
  hostName,
  leftOn,
  rightOn,
  leftColumns,
  rightColumns,
  inferred,
  initial,
  onClose,
  onConfirm,
}: Props) {
  const [leftAttrs, setLeftAttrs] = useState<string[]>([]);
  const [rightAttrs, setRightAttrs] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    const seed = initial ?? {
      leftAttrs: inferred.leftAttrs,
      rightAttrs: inferred.rightAttrs,
      sampleColumns: inferred.sampleColumns,
    };
    setLeftAttrs(seed.leftAttrs.slice());
    setRightAttrs(seed.rightAttrs.slice());
  }, [open, inferred, initial]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const grain = useMemo(
    () =>
      leftOn.length && rightOn.length
        ? leftOn.map((l, i) => `${l} = ${rightOn[i] ?? "?"}`).join(" · ")
        : "—",
    [leftOn, rightOn],
  );

  const onOnWarning =
    leftAttrs.length > 0 &&
    rightAttrs.length > 0 &&
    leftAttrs.every((c) => leftOn.includes(c)) &&
    rightAttrs.every((c) => rightOn.includes(c));

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mapping-check-setup-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0a1219] shadow-2xl shadow-black/50"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div>
            <h2
              id="mapping-check-setup-title"
              className="text-sm font-semibold text-teal-100"
            >
              {mode === "edit" ? "Change check attributes" : "New mapping check"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {mapName} · host {hostName}. Axes come from left/right of the Join
              (not whatever survived the final SELECT). ADR-0035.
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <p className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300">Joined on</span>
            {" · "}
            <span className="font-mono text-teal-200/90">{grain}</span>
            <span className="mt-1 block text-slate-500">{inferred.reason}</span>
          </p>

          {(inferred.onOnFallback || onOnWarning) && (
            <p
              role="status"
              className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-100/90"
            >
              ON×ON axes only show coverage on the diagonal. Prefer a name-like
              column on at least one side.
            </p>
          )}

          <fieldset>
            <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Row axis (left side)
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {leftColumns.map((col) => {
                const on = leftAttrs.includes(col);
                const grainCol = leftOn.includes(col);
                return (
                  <button
                    key={`L:${col}`}
                    type="button"
                    onClick={() => setLeftAttrs((xs) => toggleIn(xs, col))}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                      on
                        ? "border-teal-600/60 bg-teal-500/15 text-teal-100"
                        : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500"
                    }`}
                    title={grainCol ? "Join ON (grain)" : "Left-side column"}
                  >
                    {col}
                    {grainCol ? " · ON" : ""}
                  </button>
                );
              })}
              {!leftColumns.length && (
                <span className="text-[11px] text-slate-500">No left columns</span>
              )}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Column axis (right side)
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {rightColumns.map((col) => {
                const on = rightAttrs.includes(col);
                const grainCol = rightOn.includes(col);
                return (
                  <button
                    key={`R:${col}`}
                    type="button"
                    onClick={() => setRightAttrs((xs) => toggleIn(xs, col))}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                      on
                        ? "border-teal-600/60 bg-teal-500/15 text-teal-100"
                        : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500"
                    }`}
                    title={grainCol ? "Join ON (grain)" : "Right-side column"}
                  >
                    {col}
                    {grainCol ? " · ON" : ""}
                  </button>
                );
              })}
              {!rightColumns.length && (
                <span className="text-[11px] text-slate-500">No right columns</span>
              )}
            </div>
          </fieldset>

          <p className="font-mono text-[11px] text-slate-500">
            Preview · {leftAttrs.join(" · ") || "—"} ×{" "}
            {rightAttrs.join(" · ") || "—"}
          </p>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            onClick={() => {
              setLeftAttrs(inferred.leftAttrs.slice());
              setRightAttrs(inferred.rightAttrs.slice());
            }}
          >
            Reset to suggested
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!leftAttrs.length || !rightAttrs.length}
              onClick={() =>
                onConfirm({
                  leftAttrs,
                  rightAttrs,
                  sampleColumns: leftAttrs.slice(),
                })
              }
              className="rounded-lg bg-teal-500/20 px-3 py-1.5 text-xs font-semibold text-teal-100 hover:bg-teal-500/30 disabled:opacity-40"
            >
              {mode === "edit" ? "Apply attributes" : "Create check"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
