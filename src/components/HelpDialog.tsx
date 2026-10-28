import { useEffect } from "react";
import { HELP_INTRO, HELP_SECTIONS, HELP_TITLE } from "../help/userGuide";

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

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
        aria-labelledby="help-dialog-title"
        className="flex max-h-[min(90vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0a1219] shadow-2xl shadow-black/50"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div>
            <h2
              id="help-dialog-title"
              className="text-sm font-semibold text-teal-100"
            >
              {HELP_TITLE}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {HELP_INTRO}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <nav className="mb-4 flex flex-wrap gap-1.5">
            {HELP_SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#help-${s.id}`}
                className="rounded border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] text-slate-400 hover:border-slate-600 hover:text-teal-200"
              >
                {s.title}
              </a>
            ))}
          </nav>

          <div className="space-y-5">
            {HELP_SECTIONS.map((s) => (
              <section key={s.id} id={`help-${s.id}`} className="scroll-mt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  {s.title}
                </h3>
                {s.paragraphs?.map((p) => (
                  <p
                    key={p.slice(0, 24)}
                    className="mt-1.5 text-xs leading-relaxed text-slate-400"
                  >
                    {p}
                  </p>
                ))}
                {s.bullets && s.bullets.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-300">
                    {s.bullets.map((b) => (
                      <li key={b.slice(0, 48)}>{b}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </div>

        <footer className="shrink-0 border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
          Edit content in <span className="font-mono text-slate-400">src/help/userGuide.ts</span>
          . Engineering detail: docs/ in the repo.
        </footer>
      </div>
    </div>
  );
}
