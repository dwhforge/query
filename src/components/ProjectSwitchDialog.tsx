import { useEffect, useRef } from "react";
import type { SwitchDecision } from "../app/projectLifecycle";

export function ProjectSwitchDialog({ name, hasDrafts, onChoose }: {
  name: string;
  hasDrafts: boolean;
  onChoose: (decision: SwitchDecision) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog ref={dialog} aria-labelledby="project-switch-title" aria-describedby="project-switch-description"
      onCancel={(e) => { e.preventDefault(); onChoose("cancel"); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="fixed inset-0 m-auto w-[min(92vw,28rem)] rounded-xl border border-slate-700 bg-[#0a1219] p-5 text-slate-100 shadow-2xl backdrop:bg-black/60">
      <h2 id="project-switch-title" className="text-base font-semibold">Save changes before switching projects?</h2>
      <p id="project-switch-description" className="mt-3 text-sm text-slate-300">
        {name} has unsaved work. Save it before opening another project, or discard the changes.
      </p>
      {hasDrafts && <p className="mt-3 text-xs text-amber-200">
        Mapping or Matching has unsaved drafts. Save these in their editor first;
        saving the project file alone does not save those drafts. Discard will lose them.
      </p>}
      <div className="mt-5 flex justify-end gap-2 text-sm">
        <button autoFocus type="button" onClick={() => onChoose("cancel")}
          className="rounded border border-slate-700 px-3 py-1.5 hover:bg-slate-800">Cancel</button>
        <button type="button" onClick={() => onChoose("discard")}
          className="rounded border border-amber-800 px-3 py-1.5 text-amber-100 hover:bg-amber-900/30">Discard</button>
        <button type="button" onClick={() => onChoose("save")}
          className="rounded bg-teal-400 px-3 py-1.5 font-semibold text-slate-950 hover:bg-teal-300">Save</button>
      </div>
    </dialog>
  );
}
