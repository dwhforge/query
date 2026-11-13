import type { ReactNode } from "react";
import type { QueryPreviewState } from "../../app/queryPreview/controller";
import type { JoinState } from "../../app/joinDiagnostics/controller";
import type { HeavyPreviewMode } from "../../lib/previewTransport";
import { PREVIEW_SAMPLE_LIMIT } from "../../lib/previewTransport";
import { previewStateMessage } from "../../help/previewState";
import type { PreviewDbtModel } from "../../lib/bridge";
import { PreviewTable } from "../PreviewTable";

export interface QueryResultDockProps {
  tab: "data" | "model";
  selectTab(tab: "data" | "model"): void;
  contextLabel: string;
  modelContextLabel: string;
  preview: Pick<QueryPreviewState, "result" | "phase" | "mode" | "loading"> & {
    available: boolean;
    heavy: boolean;
    refresh(): void;
    run(mode: HeavyPreviewMode): void;
  };
  join: Pick<JoinState, "sample" | "prepareLoading" | "diagnosticsLoading" | "lensBusy"> & {
    available: boolean;
    lensOn: boolean;
    toggleLens(): void;
    clearSample(): void;
    openNoMatch(): void;
  };
  model: { result: PreviewDbtModel | null; error: string | null; copied: boolean; copy(): void };
  cancel(): void;
  lens: ReactNode;
  lensHint?: ReactNode;
}

/** Data/Model presentation. Execution state remains in the two independent owners. */
export function QueryResultDock(props: QueryResultDockProps) {
  const { tab: bottomTab, selectTab: setBottomTab, contextLabel, modelContextLabel, lens, lensHint,
    cancel: cancelHeavyQuery } = props;
  const { result: preview, phase: previewPhase, mode: previewMode, loading, available: dataWorkspace,
    heavy, refresh: recomputeCurrentPreview, run: runPreview } = props.preview;
  const { sample: diagView, prepareLoading: joinPrepareLoading, diagnosticsLoading: joinDiagLoading,
    lensBusy: lensPrepareBusy, available: joinLensTarget, lensOn: joinLensOn, toggleLens, clearSample, openNoMatch } = props.join;
  const { result: modelPreview, error: modelError, copied: sqlCopied, copy: copySql } = props.model;
  return <>
    <div className="flex items-center justify-between gap-3 px-4 pt-2">
      <div className="flex items-end gap-3">
        <div
          role="tablist"
          aria-label="Result dock"
          className="flex gap-1"
        >
          {(
            [
              { id: "data" as const, label: "Data" },
              { id: "model" as const, label: "Model" },
            ] as const
          ).map((tab) => {
            const on = bottomTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setBottomTab(tab.id)}
                className={`border-b-2 px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] transition ${on
                  ? "border-teal-400 text-teal-200"
                  : "border-transparent text-slate-500 hover:text-slate-300"
                  }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <span data-testid="preview-context" className="hidden pb-1.5 text-[10px] text-slate-500 sm:inline">
          {bottomTab === "data" ? contextLabel
            : modelContextLabel}
        </span>
      </div>
      <div className="flex items-center gap-2 pb-1.5">
        {bottomTab === "data" && !diagView && dataWorkspace && <>
          <span data-testid="preview-scope" className="text-[10px] text-slate-400" title="Sample rows are not full-input proof">
            {previewMode === "full" ? "Full preview" : `Sample · LIMIT ${PREVIEW_SAMPLE_LIMIT}`}
          </span>
          <button type="button" data-testid="preview-recompute" disabled={loading}
            onClick={recomputeCurrentPreview}
            className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-teal-700 disabled:opacity-40">Recompute</button>
        </>}
        {joinLensTarget && bottomTab === "data" && !diagView && (
          <div className="flex flex-wrap items-center gap-2"><button
            type="button"
            data-ui-anchor="join-lens-toggle"
            aria-pressed={joinLensOn}
            onClick={toggleLens}
            className={`${lensHint ? "recon-hint-target" : ""} rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${joinLensOn
              ? "border-teal-500/50 bg-teal-500/15 text-teal-200"
              : "border-slate-700 text-slate-500 hover:text-slate-300"
              }`}
            title="Show left/right source rows linked to the focused result row"
          >
            Join Lens
          </button>
            {lensHint}</div>
        )}
        {bottomTab === "data" &&
          !diagView &&
          !(joinLensOn && joinLensTarget) &&
          heavy && (
            <>
              {previewMode === "sample" ? (
                <button
                  type="button"
                  data-testid="preview-load-full"
                  disabled={loading || !dataWorkspace}
                  onClick={() => {
                    if (!dataWorkspace) return;
                    void runPreview("full");
                  }}
                  className="rounded border border-teal-800/60 px-2 py-0.5 text-[10px] text-teal-200/90 hover:bg-teal-500/10 disabled:opacity-40"
                  title="Run preview without an output row LIMIT"
                >
                  Load full
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="preview-load-sample"
                  disabled={loading || !dataWorkspace}
                  onClick={() => {
                    if (!dataWorkspace) return;
                    void runPreview("sample");
                  }}
                  className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                >
                  Sample
                </button>
              )}
            </>
          )}
        {(loading ||
          joinDiagLoading ||
          joinPrepareLoading ||
          lensPrepareBusy) && (
            <button
              type="button"
              onClick={cancelHeavyQuery}
              className="rounded border border-amber-800/70 px-2 py-0.5 text-[10px] text-amber-200/90 hover:bg-amber-500/10"
            >
              Cancel
            </button>
          )}
        <span className="text-xs text-slate-500">
          {bottomTab === "data"
            ? diagView
              ? `diag · ${diagView.rows.length}/${diagView.totalCount} · ${diagView.columns.length} cols`
              : joinPrepareLoading || lensPrepareBusy
                ? "loading join sides…"
                : joinDiagLoading
                  ? "finding gaps…"
                  : loading
                    ? previewMode === "full"
                      ? "computing full preview…"
                      : "computing… (LIMIT on output only)"
                    : preview
                      ? `${preview.rows.length} rows · ${preview.columns.length} cols`
                      : "—"
            : modelPreview
              ? `${modelPreview.model_name}.sql · dbt`
              : "—"}
        </span>
      </div>
    </div>
    {diagView && bottomTab === "data" && (
      <div className="space-y-1 px-4 pb-2">
        <div className="flex items-start justify-between gap-2 rounded-lg border border-teal-900/40 bg-teal-950/20 px-3 py-2 text-[11px] text-teal-100/90">
          <span>
            <span className="font-semibold">{diagView.label}</span>
            {" · "}
            sample {diagView.rows.length}
            {diagView.totalCount > diagView.rows.length
              ? ` of ${diagView.totalCount}`
              : ""}
            {` (limit ${diagView.sampleLimit})`}
            {" · "}
            clean sample ≠ full-input proof
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {diagView.mapSide && joinLensTarget && (
              <button
                type="button"
                className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-teal-800 hover:text-teal-200"
                title="Open Join Lens → No match to fix values without a partner"
                onClick={() => {
                  openNoMatch();
                }}
              >
                Open No match
              </button>
            )}
            <button
              type="button"
              className="text-teal-300/80 hover:text-teal-100"
              onClick={() => clearSample()}
            >
              Back to preview
            </button>
          </div>
        </div>
      </div>
    )}
    <div className="min-h-0 flex-1 px-3 pb-3 pt-1">
      <div className="h-full min-h-0 overflow-hidden rounded-xl border border-[var(--line)] bg-slate-950/40">
        {bottomTab === "data" ? (
          diagView ? (
            <PreviewTable
              columns={diagView.columns}
              rows={diagView.rows}
              highlightKeys={diagView.highlightKeys}
            />
          ) : preview &&
            joinLensOn &&
            joinLensTarget ? (
            lens
          ) : preview ? (
            <PreviewTable
              columns={preview.columns}
              rows={preview.rows}
            />
          ) : (
            <div role="status" data-testid="preview-state" className="flex h-full items-center justify-center p-4 text-center text-sm text-slate-400">
              {previewStateMessage(previewPhase)}
            </div>
          )
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
              <span className="truncate font-mono text-[11px] text-teal-300/90">
                {modelPreview
                  ? `models/…/${modelPreview.model_name}.sql`
                  : "Generated model"}
              </span>
              <button
                type="button"
                onClick={() => void copySql()}
                disabled={!modelPreview?.sql}
                className="text-[11px] text-teal-400 hover:text-teal-300 disabled:opacity-40"
              >
                {sqlCopied ? "Copied" : "Copy"}
              </button>
            </div>
            {modelPreview?.sql ? (
              <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {modelPreview.sql}
              </pre>
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-slate-500">
                {modelError ?? "Select a query to see its dbt model"}
              </div>
            )}
          </div>
        )}
      </div>
    </div>

  </>;
}
