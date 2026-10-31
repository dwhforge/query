/** Indeterminate / phased progress for long File → Export / Parse / Build ops. */

export type OpProgressKind = "export" | "parse" | "build" | "prepare";

export interface OpProgressState {
  kind: OpProgressKind;
  /** Human label for the current phase (e.g. "Writing dbt project…"). */
  phase: string;
  /** 0–100 when known; omit / null → indeterminate bar. */
  percent?: number | null;
}

const KIND_TITLE: Record<OpProgressKind, string> = {
  export: "Export dbt",
  parse: "dbt parse",
  build: "dbt build",
  prepare: "Load join sides",
};

export function OpProgress({ state }: { state: OpProgressState }) {
  const determinate =
    typeof state.percent === "number" &&
    Number.isFinite(state.percent) &&
    state.percent >= 0;
  const pct = determinate ? Math.min(100, Math.max(0, state.percent!)) : 0;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] border-t border-teal-900/50 bg-[#071018]/95 px-4 py-3 shadow-[0_-8px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="font-medium text-teal-100">
            {KIND_TITLE[state.kind]}
          </span>
          <span className="truncate text-slate-400">{state.phase}</span>
          {determinate && (
            <span className="shrink-0 font-mono text-[11px] text-slate-500">
              {Math.round(pct)}%
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
          {determinate ? (
            <div
              className="h-full rounded-full bg-teal-400/90 transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="op-progress-indeterminate h-full w-1/3 rounded-full bg-teal-400/90" />
          )}
        </div>
      </div>
    </div>
  );
}
