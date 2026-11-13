import type { ReactNode } from "react";
import { History } from "../History";
import { SourceSchemaPanel } from "../SourceSchemaPanel";
import { QueryStepEditor, type StepEditorProps } from "./QueryStepEditor";
import { isPublishedOutput, queryExecution, projectDialect, isExternalTarget, type Project, type TransformationStep, type QueryDef, type QueryExecution, type SourceDef } from "../../types/pipeline";
import { parseTargetKey, type ExternalBoundary } from "../../lib/projectRefs";
import type { PostgresColumn } from "../../lib/bridge";

export interface QueryInspectorProps {
  project: Project;
  session: number;
  query: QueryDef | null;
  index: number | null;
  width: number;
  externalKey: string | null;
  boundaries: ExternalBoundary[];
  source: { selected: SourceDef | null; columns: PostgresColumn[] | null; loading: boolean; error: string | null };
  historyAccessory?: { index: number; content: ReactNode };
  availableSteps: { id: string; label: string }[];
  columns: string[];
  editor: Omit<StepEditorProps, "queryId" | "index" | "step">;
  commands: {
    focus(id: string): void;
    togglePublished(id: string): void;
    execution(id: string, execution: QueryExecution): void;
    select(index: number): void;
    remove(index: number): void;
    move(index: number, direction: -1 | 1): void;
    add(kind: string): void;
    deriveExternal(key: string): void;
    copyExternal(key: string): Promise<void>;
  };
}
function stepEditorTitle(step: TransformationStep): string {
  switch (step.type) {
    case "SqlModel":
      return "SQL model";
    case "CustomSql":
      return "Custom SQL";
    case "DeriveColumn":
      return "Derived/Calculated";
    case "NormalizeKey":
      return "NormalizeKey";
    case "ApplyKeyMap":
      return "Apply Mapping";
    default:
      return step.type;
  }
}

export function QueryInspector({ project, session, query: activeQuery, index: selectedStepIndex, width,
  externalKey: selectedExternalKey, boundaries: externalBoundaries, source, historyAccessory,
  availableSteps, columns: columnChoices, editor, commands }: QueryInspectorProps) {
  const activeQueryId = activeQuery?.id;
  const focusQueryId = project.workspace.focus_query_id;
  const queries = project.workspace.queries;
  const selectedStep = selectedStepIndex === null ? undefined : activeQuery?.steps[selectedStepIndex];
  const { selected: selectedSource, columns: sourceColumns, loading: sourceSchemaLoading, error: sourceSchemaError } = source;
  const { select: selectStepAt, remove: removeStepAt, move: moveStepAt, add: addAvailableStep,
    deriveExternal: deriveFromExternalKey, copyExternal: createLocalCopyOfExternal } = commands;
  return (
    <aside
      className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-[#050b12]"
      style={{ width }}
    >
      <div className="shrink-0 border-b border-[var(--line)] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold text-slate-100">
            {activeQuery?.name ?? "Select a query"}
          </h2>
          {activeQuery && activeQuery.id !== focusQueryId && (
            <button
              type="button"
              onClick={() => commands.focus(activeQuery.id)}
              className="shrink-0 text-[10px] uppercase tracking-wide text-teal-400"
            >
              Set focus
            </button>
          )}
        </div>
        {activeQuery && (
          <label
            className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300"
            title="Export as mart_* and materialize to destination (Postgres when duckdb→postgres)"
          >
            <input
              type="checkbox"
              className="rounded border-slate-600"
              checked={isPublishedOutput(project, activeQuery.id)}
              onChange={() =>
                commands.togglePublished(activeQuery.id)
              }
            />
            Publish to destination
          </label>
        )}
        {activeQuery && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Preview
            </span>
            {(["local", "target"] as QueryExecution[]).map((ex) => {
              const on = queryExecution(activeQuery) === ex;
              return (
                <button
                  key={ex}
                  type="button"
                  title={
                    ex === "local"
                      ? "All steps in DuckDB (default; ≈ dbt-on-duckdb when export→duckdb)"
                      : `All steps on project warehouse (${projectDialect(project)}); does not spread to other queries`
                  }
                  onClick={() =>
                    commands.execution(activeQuery.id, ex)
                  }
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] ${on
                    ? "border-teal-600/60 bg-teal-950/40 text-teal-200"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"
                    }`}
                >
                  {ex}
                </button>
              );
            })}
            <span className="font-mono text-[10px] text-slate-600">
              export → {projectDialect(project)}
            </span>
          </div>
        )}
      </div>
      {selectedSource?.kind === "postgres" && (
        <div className="max-h-28 shrink-0 overflow-auto border-b border-[var(--line)] px-4 py-2">
          <SourceSchemaPanel
            source={selectedSource}
            columns={sourceColumns}
            loading={sourceSchemaLoading}
            error={sourceSchemaError}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedExternalKey ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2">
            <h3 className="mb-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-500">
              External · read-only
            </h3>
            {(() => {
              const b = externalBoundaries.find(
                (x) => x.key === selectedExternalKey,
              );
              const target = parseTargetKey(selectedExternalKey);
              if (!b || !target || !isExternalTarget(target)) {
                return (
                  <p className="text-sm text-slate-600">
                    External object unavailable.
                  </p>
                );
              }
              return (
                <div className="space-y-3 text-sm text-slate-300">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">
                      Reference
                    </div>
                    <div className="font-semibold text-sky-200">
                      {b.alias}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">
                      Object
                    </div>
                    <div className="font-mono text-xs">
                      {b.kind} · {b.objectId}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Definition is owned by the referenced project. Edit it
                    there, then Update the reference.
                  </p>
                  <button
                    type="button"
                    className="w-full rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25"
                    onClick={() => deriveFromExternalKey(selectedExternalKey)}
                  >
                    Use in new query
                  </button>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-sky-700 hover:text-sky-200"
                    onClick={() =>
                      void createLocalCopyOfExternal(selectedExternalKey)
                    }
                  >
                    Create local copy
                  </button>
                </div>
              );
            })()}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-[1_1_50%] flex-col border-b border-[var(--line)] px-3 py-2">
              <History
                stepAccessory={historyAccessory}
                steps={activeQuery?.steps ?? []}
                queryNames={{
                  ...Object.fromEntries(
                    queries.map((q) => [q.id, q.name]),
                  ),
                  ...Object.fromEntries(
                    externalBoundaries.map((b) => [b.key, b.label]),
                  ),
                }}
                selectedIndex={selectedStepIndex}
                onSelect={selectStepAt}
                onRemoveAt={removeStepAt}
                onMove={moveStepAt}
              />
            </div>
            <div className="flex min-h-0 flex-[1_1_50%] flex-col overflow-auto px-3 py-2">
              <h3 className="mb-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {selectedStep
                  ? `Edit · s${selectedStepIndex} ${stepEditorTitle(selectedStep)}`
                  : "Step editor"}
              </h3>
              {!activeQuery ? (
                <p className="text-sm text-slate-600">Select a query.</p>
              ) : selectedStepIndex === null || !selectedStep ? (
                <p className="mb-3 text-[11px] text-slate-500">
                  Select a step above, or add one below.
                </p>
              ) : (
                <div className="mb-3 space-y-2" data-testid="query-step-editor"><QueryStepEditor key={JSON.stringify([session, activeQueryId, selectedStepIndex, selectedStep.type])}
                  {...editor} queryId={activeQuery!.id} index={selectedStepIndex} step={selectedStep} /></div>
              )}
              <datalist id="inspector-cols">
                {columnChoices.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <div className="mt-auto shrink-0 border-t border-slate-800 pt-2">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Add step
                </p>
                <div className="flex flex-wrap gap-1">
                  {availableSteps.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={!activeQuery}
                      title={`Add ${s.label}`}
                      className="rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-teal-600/60 hover:bg-teal-500/10 hover:text-teal-200 disabled:opacity-40"
                      onClick={() => addAvailableStep(s.id)}
                    >
                      + {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

      </div>
    </aside>
  );
}
