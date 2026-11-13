import { useRef } from "react";

import { parseTargetKey } from "../../lib/projectRefs";

import { targetKey, externalTarget, type NormalizeOp, type ObjectTarget } from "../../types/pipeline";

import type { StepEditorProps } from "./QueryStepEditor";

export function MappingStepEditor(props: Pick<StepEditorProps, "step" | "index" | "commit" | "project" | "refCatalogs" | "openMap">) {
  const { project, index: selectedStepIndex, step: selectedStep, refCatalogs, commit: replaceStepAt, openMap: openKeyMapEditor } = props;
  const editorRoot = useRef<HTMLDivElement>(null);
  function objectTargetFromPicker(value: string): ObjectTarget { return parseTargetKey(value) ?? value; }
  return (<div ref={editorRoot} className="space-y-2">
    {selectedStep.type === "NormalizeKey" &&
      selectedStepIndex !== null && (
        <>
          <p className="text-[10px] text-slate-500">
            Deterministic key cleanup before Join (overwrite in
            place).
          </p>
          <label className="block text-[10px] text-slate-500">
            Columns (comma-separated)
            <input
              list="inspector-cols"
              defaultValue={selectedStep.payload.columns.join(", ")}
              id="normalize-cols-input"
              className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
            />
          </label>
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-300">
            {(
              [
                "trim",
                "lower",
                "upper",
                "collapse_space",
                "ltrim_zeros",
              ] as NormalizeOp[]
            ).map((op) => {
              const on = selectedStep.payload.ops.includes(op);
              return (
                <label
                  key={op}
                  className="flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      const ops = on
                        ? selectedStep.payload.ops.filter(
                          (o) => o !== op,
                        )
                        : [...selectedStep.payload.ops, op];
                      if (ops.length === 0) return;
                      replaceStepAt(selectedStepIndex, {
                        type: "NormalizeKey",
                        payload: {
                          columns: selectedStep.payload.columns,
                          ops,
                        },
                      });
                    }}
                  />
                  {op}
                </label>
              );
            })}
          </div>
          <button
            type="button"
            className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
            onClick={() => {
              const el = editorRoot.current?.querySelector<HTMLInputElement>(
                "#normalize-cols-input",
              ) as HTMLInputElement | null;
              const columns = (el?.value ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              if (!columns.length) return;
              replaceStepAt(selectedStepIndex, {
                type: "NormalizeKey",
                payload: {
                  columns,
                  ops: selectedStep.payload.ops,
                },
              });
            }}
          >
            Apply columns
          </button>
        </>
      )}
    {selectedStep.type === "ApplyKeyMap" &&
      selectedStepIndex !== null && (
        <>
          <p className="text-[10px] text-slate-500">
            Remap values via From→To table (dbt seed after export).
          </p>
          <label className="block text-[10px] text-slate-500">
            Column
            <input
              list="inspector-cols"
              defaultValue={selectedStep.payload.column}
              id="apply-keymap-col"
              className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
            />
          </label>
          {(() => {
            const mid = targetKey(selectedStep.payload.map_id);
            const km = (project.workspace.key_maps ?? []).find(
              (m) => m.id === mid,
            );
            if (km?.time_mode !== "range_scd") return null;
            return (
              <label className="block text-[10px] text-slate-500">
                As-of (fact event time) — required for SCD
                <input
                  list="inspector-cols"
                  defaultValue={
                    selectedStep.payload.as_of_column ?? ""
                  }
                  id="apply-keymap-asof"
                  placeholder="event_date"
                  className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                />
              </label>
            );
          })()}
          <label className="block text-[10px] text-slate-500">
            KeyMap
            <select
              value={targetKey(selectedStep.payload.map_id)}
              onChange={(e) => {
                const map_id = objectTargetFromPicker(
                  e.target.value,
                );
                const localId =
                  typeof map_id === "string" ? map_id : null;
                const map = localId
                  ? (project.workspace.key_maps ?? []).find(
                    (m) => m.id === localId,
                  )
                  : undefined;
                replaceStepAt(selectedStepIndex, {
                  type: "ApplyKeyMap",
                  payload: {
                    column: selectedStep.payload.column,
                    as_of_column:
                      selectedStep.payload.as_of_column,
                    map_id,
                    entries: map?.entries ?? [],
                  },
                });
              }}
              className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            >
              {(project.workspace.key_maps ?? []).length === 0 &&
                Object.values(refCatalogs).every(
                  (c) => c.maps.length === 0,
                ) && (
                  <option value={targetKey(selectedStep.payload.map_id)}>
                    {targetKey(selectedStep.payload.map_id)}
                  </option>
                )}
              <optgroup label="This project">
                {(project.workspace.key_maps ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.entries.length} rows)
                  </option>
                ))}
              </optgroup>
              {Object.entries(refCatalogs).map(([rid, cat]) =>
                cat.maps.length > 0 ? (
                  <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                    {cat.maps.map((m) => (
                      <option
                        value={targetKey(
                          externalTarget(rid, "mapping", m.id),
                        )}
                      >
                        {cat.alias}.{m.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </select>
          </label>
          <p className="font-mono text-[10px] text-slate-500">
            {(selectedStep.payload.entries ?? []).length} entries
            in step snapshot
            {(selectedStep.payload.entries ?? [])
              .slice(0, 3)
              .map((e) => ` · ${e.from}→${e.to}`)
              .join("")}
            {(selectedStep.payload.entries?.length ?? 0) > 3
              ? "…"
              : ""}
          </p>
          <button
            type="button"
            className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
            onClick={() => {
              const el = editorRoot.current?.querySelector<HTMLInputElement>(
                "#apply-keymap-col",
              ) as HTMLInputElement | null;
              const asOfEl = editorRoot.current?.querySelector<HTMLInputElement>(
                "#apply-keymap-asof",
              ) as HTMLInputElement | null;
              const column =
                el?.value.trim() || selectedStep.payload.column;
              const as_of_column =
                asOfEl?.value.trim() ||
                selectedStep.payload.as_of_column;
              replaceStepAt(selectedStepIndex, {
                type: "ApplyKeyMap",
                payload: {
                  ...selectedStep.payload,
                  column,
                  as_of_column: as_of_column || undefined,
                },
              });
            }}
          >
            Apply column
          </button>
          <button
            type="button"
            className="w-full rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400"
            onClick={() => {
              const maps = project.workspace.key_maps ?? [];
              const mid = targetKey(selectedStep.payload.map_id);
              const map =
                maps.find((m) => m.id === mid) ?? {
                  id: mid,
                  name: mid,
                  entries: selectedStep.payload.entries ?? [],
                };
              openKeyMapEditor(map, {
                suggestedFrom: [],
              });
            }}
          >
            Edit From→To map…
          </button>
        </>
      )}
  </div>);
}
