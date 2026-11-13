import { useState } from "react";

import { parseTargetKey } from "../../lib/projectRefs";

import { targetKey, externalTarget, type ObjectTarget } from "../../types/pipeline";

import type { StepEditorProps } from "./QueryStepEditor";

export function RelationStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "project" | "queryId" | "refCatalogs">) {
  const { project, queryId: activeQueryId, index: selectedStepIndex, step: selectedStep, refCatalogs, commit: replaceStepAt } = props;
  const queries = project.workspace.queries;
  const otherQueries = queries.filter(q => q.id !== activeQueryId);
  function objectTargetFromPicker(value: string): ObjectTarget { return parseTargetKey(value) ?? value; }
  const [fromQueryId, setFromQueryId] = useState(selectedStep.type === "FromQuery" ? targetKey(selectedStep.payload.query_id) : "");
  const [appendOtherId, setAppendOtherId] = useState(selectedStep.type === "Append" && selectedStep.payload.other_query_ids[0] ? targetKey(selectedStep.payload.other_query_ids[0]) : "");
  return (<>
    {selectedStep.type === "FromQuery" && (
      <>
        <p className="text-[10px] text-slate-500">
          Child query root — dbt <span className="font-mono">ref</span>{" "}
          to parent (pinned at s0).
        </p>
        <select
          value={fromQueryId}
          onChange={(e) => setFromQueryId(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
        >
          <option value="">parent query…</option>
          <optgroup label="This project">
            {otherQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </optgroup>
          {Object.entries(refCatalogs).map(([rid, cat]) =>
            cat.queries.length > 0 ? (
              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                {cat.queries.map((q) => (
                  <option
                    value={targetKey(
                      externalTarget(rid, "query", q.id),
                    )}
                  >
                    {cat.alias}.{q.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        <button
          type="button"
          disabled={!fromQueryId}
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
          onClick={() => {
            if (selectedStepIndex === null || !fromQueryId)
              return;
            replaceStepAt(selectedStepIndex, {
              type: "FromQuery",
              payload: {
                query_id: objectTargetFromPicker(fromQueryId),
              },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
    {selectedStep.type === "Append" && (
      <>
        <select
          value={appendOtherId}
          onChange={(e) => setAppendOtherId(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
        >
          <option value="">other query…</option>
          <optgroup label="This project">
            {otherQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </optgroup>
          {Object.entries(refCatalogs).map(([rid, cat]) =>
            cat.queries.length > 0 ? (
              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                {cat.queries.map((q) => (
                  <option
                    value={targetKey(
                      externalTarget(rid, "query", q.id),
                    )}
                  >
                    {cat.alias}.{q.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        <button
          type="button"
          disabled={!appendOtherId}
          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
          onClick={() => {
            if (selectedStepIndex === null || !appendOtherId)
              return;
            replaceStepAt(selectedStepIndex, {
              type: "Append",
              payload: {
                other_query_ids: [
                  objectTargetFromPicker(appendOtherId),
                ],
              },
            });
          }}
        >
          Apply
        </button>
      </>
    )}
  </>);
}
