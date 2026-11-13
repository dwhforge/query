

import type { StepEditorProps } from "./QueryStepEditor";

export function LoadStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "project" | "changeLoadFile">) {
  const { project, step: selectedStep, changeLoadFile: changeSelectedLoadFile } = props;
  return (<>
    {(selectedStep.type === "LoadCsv" ||
      selectedStep.type === "LoadParquet") && (
        <div className="space-y-2 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] text-slate-500">
              Source step (pinned at s0)
            </p>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${(selectedStep.payload.path_kind ?? "absolute") ===
                "relative"
                ? "bg-teal-500/20 text-teal-100"
                : "bg-slate-700/80 text-slate-300"
                }`}
              title="ADR-0043 path_kind — relative is vs the project file directory"
            >
              {selectedStep.payload.path_kind ?? "absolute"}
            </span>
          </div>
          <p
            className="break-all font-mono text-[11px] text-slate-300"
            title={selectedStep.payload.path}
          >
            {selectedStep.payload.path}
          </p>
          {!project.root_path && (
            <p className="text-[10px] text-amber-200/80">
              Save the project to store paths relative to the
              project file.
            </p>
          )}
          <button
            type="button"
            className="w-full rounded-lg border border-teal-800/80 bg-teal-500/10 px-3 py-1.5 text-xs font-semibold text-teal-100 hover:bg-teal-500/20 disabled:opacity-40"
            disabled={
              selectedStep.type === "LoadParquet" &&
              !!selectedStep.payload.connection_id
            }
            title={
              selectedStep.type === "LoadParquet" &&
                selectedStep.payload.connection_id
                ? "Remote Parquet — use S3 / connection picker"
                : "Pick another file for this Load step"
            }
            onClick={() => void changeSelectedLoadFile()}
          >
            Change file…
          </button>
        </div>
      )}
    {selectedStep.type === "LoadPostgres" && (
      <p className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2 font-mono text-[11px] text-slate-400">
        Source step (pinned at s0). Table comes from the Postgres
        import / picker.
      </p>
    )}
  </>);
}
