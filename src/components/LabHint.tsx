import "./LabHint.css";

/** Inline beside its actual target: no overlay, coordinates, timers or focus moves. */
export function LabHint({ children, onDismiss, fallback = false }: {
  children: string;
  onDismiss: () => void;
  fallback?: boolean;
}) {
  return <span role="status" data-testid="lab-hint"
    className="inline-flex max-w-full flex-wrap items-center gap-2 rounded border border-teal-700/70 bg-[#0a2529] px-2 py-1 text-[11px] leading-snug text-teal-100">
    {!fallback && <span aria-hidden="true">↖</span>}
    <span>{children}</span>
    <button type="button" onClick={(event) => { event.stopPropagation(); onDismiss(); }}
      className="shrink-0 rounded border border-teal-700 px-1.5 py-0.5 font-semibold hover:bg-teal-500/20">Got it</button>
  </span>;
}
