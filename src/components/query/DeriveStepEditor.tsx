import { useRef, useState } from "react";

import { projectEngine, type DeriveMode, type DeriveOp, type DeriveOpId } from "../../types/pipeline";

import type { StepEditorProps } from "./QueryStepEditor";

export function DeriveStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "project" | "columns">) {
  const { project, index: selectedStepIndex, step: selectedStep, columns, commit: replaceStepAt } = props;
  const deriveNameRef = useRef<HTMLInputElement>(null);
  const deriveExprRef = useRef<HTMLInputElement>(null);
  const [deriveName, setDeriveName] = useState(selectedStep.type === "DeriveColumn" ? selectedStep.payload.name : "");
  const [deriveExpr, setDeriveExpr] = useState(selectedStep.type === "DeriveColumn" ? selectedStep.payload.expression ?? "" : "");
  const [deriveMode, setDeriveMode] = useState<DeriveMode>(selectedStep.type === "DeriveColumn" ? selectedStep.payload.mode ?? (selectedStep.payload.op ? "op" : "sql") : "sql");
  const [deriveOpId, setDeriveOpId] = useState<DeriveOpId>(selectedStep.type === "DeriveColumn" ? selectedStep.payload.op?.id ?? "month_start" : "month_start");
  const [deriveOpCol, setDeriveOpCol] = useState(selectedStep.type === "DeriveColumn" ? selectedStep.payload.op?.column ?? "" : "");
  const [deriveOpColB, setDeriveOpColB] = useState(selectedStep.type === "DeriveColumn" ? selectedStep.payload.op?.column_b ?? "" : "");
  const [deriveOpValue, setDeriveOpValue] = useState(selectedStep.type === "DeriveColumn" ? selectedStep.payload.op?.value ?? "" : "");
  const columnChoices = columns;
  return (<>
    {selectedStep.type === "DeriveColumn" && (
      <>
        <input
          ref={deriveNameRef}
          defaultValue={deriveName}
          placeholder="column name"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
        />
        <label className="block text-[10px] text-slate-500">
          Mode
          <select
            value={deriveMode}
            onChange={(e) =>
              setDeriveMode(e.target.value as DeriveMode)
            }
            className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
          >
            <option value="op">Ready-made operation</option>
            <option value="sql">SQL expression</option>
          </select>
        </label>
        {deriveMode === "op" ? (
          <>
            <select
              value={deriveOpId}
              onChange={(e) =>
                setDeriveOpId(e.target.value as DeriveOpId)
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
            >
              <option value="month_start">
                Month start (DATE)
              </option>
              <option value="year_month">
                Year-month text (YYYY-MM)
              </option>
              <option value="coalesce_null">
                Replace NULL
              </option>
              <option value="cast">Cast type</option>
              <option value="col_diff">
                Difference of two columns
              </option>
              <option value="trim_case">
                Trim / lower / upper
              </option>
            </select>
            <input
              value={deriveOpCol}
              onChange={(e) => setDeriveOpCol(e.target.value)}
              placeholder="column"
              list="derive-cols"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
            />
            <datalist id="derive-cols">
              {columnChoices.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {deriveOpId === "col_diff" && (
              <input
                value={deriveOpColB}
                onChange={(e) =>
                  setDeriveOpColB(e.target.value)
                }
                placeholder="column_b"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
              />
            )}
            {(deriveOpId === "coalesce_null" ||
              deriveOpId === "cast") && (
                <input
                  value={deriveOpValue}
                  onChange={(e) =>
                    setDeriveOpValue(e.target.value)
                  }
                  placeholder={
                    deriveOpId === "cast"
                      ? "type (varchar, date…)"
                      : "replacement"
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                />
              )}
            <p className="text-[10px] text-slate-500">
              Regenerates for {projectEngine(project)} on
              export/preview. Edit as SQL to unlock free text.
            </p>
            <button
              type="button"
              className="w-full rounded-lg border border-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              onClick={() => setDeriveMode("sql")}
            >
              Edit as SQL…
            </button>
          </>
        ) : (
          <>
            <input
              ref={deriveExprRef}
              defaultValue={deriveExpr}
              placeholder="SQL expression"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
            />
            <p className="text-[10px] text-amber-400/80">
              Preview engine: {projectEngine(project)}.
              Arbitrary SQL for another dialect is not
              validated locally.
            </p>
          </>
        )}
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const name =
              deriveNameRef.current?.value.trim() ??
              deriveName.trim();
            if (!name) return;
            if (deriveMode === "op") {
              if (!deriveOpCol.trim()) return;
              const op: DeriveOp = {
                id: deriveOpId,
                column: deriveOpCol.trim(),
                column_b: deriveOpColB.trim() || undefined,
                value: deriveOpValue.trim() || undefined,
                case_mode:
                  deriveOpId === "trim_case"
                    ? "trim_lower"
                    : undefined,
              };
              setDeriveName(name);
              replaceStepAt(selectedStepIndex, {
                type: "DeriveColumn",
                payload: {
                  name,
                  mode: "op",
                  op,
                  expression: "",
                  sql_dialect: projectEngine(project),
                },
              });
            } else {
              const expression =
                deriveExprRef.current?.value.trim() ??
                deriveExpr.trim();
              if (!expression) return;
              setDeriveName(name);
              setDeriveExpr(expression);
              replaceStepAt(selectedStepIndex, {
                type: "DeriveColumn",
                payload: {
                  name,
                  mode: "sql",
                  expression,
                  sql_dialect: projectEngine(project),
                },
              });
            }
          }}
        >
          Apply
        </button>
      </>
    )}
  </>);
}
