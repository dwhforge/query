import { RECON_TASK, type reconComparisonTargets, type ReconView } from "../help/reconLab";

export function LabTaskCard({ canStart, onStart, onDismiss, targets, onNavigate }: {
  canStart: boolean;
  onStart: () => void;
  onDismiss: () => void;
  targets: ReturnType<typeof reconComparisonTargets>;
  onNavigate: (view: ReconView) => void;
}) {
  return <section data-testid="lab-task-card" aria-labelledby="lab-task-title"
    className="mx-3 my-2 max-h-[28vh] shrink-0 overflow-auto rounded-lg border border-teal-800/60 bg-teal-950/20 px-4 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h2 id="lab-task-title" className="text-sm font-semibold text-teal-100">{RECON_TASK.title}</h2>
      <button type="button" onClick={onDismiss} className="rounded px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100">Dismiss</button>
    </div>
    <p className="mt-1 text-xs leading-relaxed text-slate-300">{RECON_TASK.problem}</p>
    <p className="mt-1 text-xs text-slate-300">{RECON_TASK.action}</p>
    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{RECON_TASK.next}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!canStart} onClick={onStart}
        className="rounded border border-teal-700 bg-teal-400/10 px-3 py-1 text-xs font-semibold text-teal-100 hover:bg-teal-400/20 disabled:opacity-40">
        Show me where to start
      </button>
      {!canStart && <span className="text-xs text-slate-400">The original Join is no longer available in this edited lab.</span>}
    </div>
    <nav aria-label="Lab comparison views" className="mt-2 flex flex-wrap gap-2">
      {targets.map((target) => <button key={target.view} type="button" disabled={!target.available}
        onClick={() => onNavigate(target.view)} title={target.available ? target.queryId : "This query/step is no longer available"}
        className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-teal-700 hover:text-teal-100 disabled:opacity-40">
        {target.label}
      </button>)}
    </nav>
    <p className="mt-2 text-[10px] leading-relaxed text-slate-400">These links open sample previews, not full-input proof. After editing a map, recompute the relevant preview before comparing results.</p>
  </section>;
}
