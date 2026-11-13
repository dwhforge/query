import { useRef, useState } from "react";

import type { StepEditorProps } from "./QueryStepEditor";

export function TextStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit">) {
  const { index: selectedStepIndex, step: selectedStep, commit: replaceStepAt } = props;
  const [filterCondition, setFilterCondition] = useState(selectedStep.type === "Filter" ? selectedStep.payload.condition : "");
  const [groupDims, setGroupDims] = useState(selectedStep.type === "GroupBy" ? selectedStep.payload.dimensions.join(", ") : "");
  const [groupAggs, setGroupAggs] = useState(selectedStep.type === "GroupBy" ? selectedStep.payload.aggregates.join(", ") : "count(*) as n");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const customSqlRef = useRef<HTMLTextAreaElement>(null);
  const groupDimsRef = useRef<HTMLInputElement>(null);
  const groupAggsRef = useRef<HTMLInputElement>(null);
  const sortColRef = useRef<HTMLInputElement>(null);
  const limitNRef = useRef<HTMLInputElement>(null);
  const renameFromRef = useRef<HTMLInputElement>(null);
  const renameToRef = useRef<HTMLInputElement>(null);
  const [sortCol, setSortCol] = useState(selectedStep.type === "SortBy" ? selectedStep.payload.column : "");
  const [sortDesc, setSortDesc] = useState(selectedStep.type === "SortBy" ? selectedStep.payload.descending : true);
  const [limitN, setLimitN] = useState(selectedStep.type === "Limit" ? String(selectedStep.payload.n) : "10");
  const [renameFrom, setRenameFrom] = useState(selectedStep.type === "RenameColumn" ? selectedStep.payload.from : "");
  const [renameTo, setRenameTo] = useState(selectedStep.type === "RenameColumn" ? selectedStep.payload.to : "");
  const [customSql, setCustomSql] = useState(selectedStep.type === "CustomSql" || selectedStep.type === "SqlModel" ? selectedStep.payload.raw_sql : "select * from {{prev_step}}");
  return (<>
    {selectedStep.type === "SqlModel" && (
      <>
        <p className="text-[10px] text-slate-500">
          Root model SQL (prod dialect). Preview runs in-app;
          export is this body.
        </p>
        <textarea
          ref={customSqlRef}
          defaultValue={customSql}
          rows={8}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const raw =
              customSqlRef.current?.value.trim() ??
              customSql.trim();
            setCustomSql(raw);
            replaceStepAt(selectedStepIndex, {
              type: "SqlModel",
              payload: { raw_sql: raw },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "Filter" && (
      <>
        <input
          ref={filterInputRef}
          type="text"
          defaultValue={filterCondition}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              selectedStepIndex !== null
            ) {
              const condition = e.currentTarget.value.trim();
              setFilterCondition(condition);
              replaceStepAt(selectedStepIndex, {
                type: "Filter",
                payload: { condition },
              });
            }
          }}
          placeholder="amount > 1000"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const condition =
              filterInputRef.current?.value.trim() ??
              filterCondition.trim();
            setFilterCondition(condition);
            replaceStepAt(selectedStepIndex, {
              type: "Filter",
              payload: { condition },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "GroupBy" && (
      <>
        <input
          ref={groupDimsRef}
          type="text"
          defaultValue={groupDims}
          placeholder="dimensions: region"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
        />
        <input
          ref={groupAggsRef}
          type="text"
          defaultValue={groupAggs}
          placeholder="sum(qty) as qty"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const dimsRaw =
              groupDimsRef.current?.value ?? groupDims;
            const aggsRaw =
              groupAggsRef.current?.value ?? groupAggs;
            const dimensions = dimsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const aggregates = aggsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            if (!dimensions.length || !aggregates.length) return;
            setGroupDims(dimsRaw);
            setGroupAggs(aggsRaw);
            replaceStepAt(selectedStepIndex, {
              type: "GroupBy",
              payload: { dimensions, aggregates },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "SortBy" && (
      <>
        <div className="flex gap-1">
          <input
            ref={sortColRef}
            list="inspector-cols"
            defaultValue={sortCol}
            placeholder="column"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
          />
          <label className="flex items-center gap-1 rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={sortDesc}
              onChange={(e) => setSortDesc(e.target.checked)}
            />
            desc
          </label>
        </div>
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const column =
              sortColRef.current?.value.trim() ??
              sortCol.trim();
            if (!column) return;
            setSortCol(column);
            replaceStepAt(selectedStepIndex, {
              type: "SortBy",
              payload: {
                column,
                descending: sortDesc,
              },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "Limit" && (
      <>
        <input
          ref={limitNRef}
          type="number"
          min={1}
          defaultValue={limitN}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const raw =
              limitNRef.current?.value ?? limitN;
            const n = Number.parseInt(raw, 10);
            if (!Number.isFinite(n) || n < 1) return;
            setLimitN(String(n));
            replaceStepAt(selectedStepIndex, {
              type: "Limit",
              payload: { n },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "RenameColumn" && (
      <>
        <input
          ref={renameFromRef}
          defaultValue={renameFrom}
          placeholder="from"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
        />
        <input
          ref={renameToRef}
          defaultValue={renameTo}
          placeholder="to"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const from =
              renameFromRef.current?.value.trim() ??
              renameFrom.trim();
            const to =
              renameToRef.current?.value.trim() ??
              renameTo.trim();
            if (!from || !to) return;
            setRenameFrom(from);
            setRenameTo(to);
            replaceStepAt(selectedStepIndex, {
              type: "RenameColumn",
              payload: { from, to },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "CustomSql" && (
      <>
        <p className="text-[10px] text-slate-500">
          Mid-chain snippet. Use {"{{prev_step}}"} for prior CTE;
          optional {"{{query:id}}"}.
        </p>
        <textarea
          ref={customSqlRef}
          defaultValue={customSql}
          rows={5}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
        />
        <button
          type="button"
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
          onClick={() => {
            if (selectedStepIndex === null) return;
            const raw =
              customSqlRef.current?.value.trim() ??
              customSql.trim();
            setCustomSql(raw);
            replaceStepAt(selectedStepIndex, {
              type: "CustomSql",
              payload: { raw_sql: raw },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
  </>);
}
