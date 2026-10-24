import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { History } from "./components/History";
import { PreviewTable } from "./components/PreviewTable";
import { debounce } from "./lib/debounce";
import { previewPipeline } from "./lib/tauri";
import type { PreviewResult, TransformationStep } from "./types/pipeline";

function App() {
  const [csvPath, setCsvPath] = useState<string | null>(null);
  const [filterCondition, setFilterCondition] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);

  const steps: TransformationStep[] = useMemo(() => {
    if (!csvPath) return [];
    const next: TransformationStep[] = [
      { type: "LoadCsv", payload: { path: csvPath } },
    ];
    if (filterCondition.trim()) {
      next.push({
        type: "Filter",
        payload: { condition: filterCondition.trim() },
      });
    }
    return next;
  }, [csvPath, filterCondition]);

  const runPreview = useCallback(async (pipelineSteps: TransformationStep[]) => {
    if (pipelineSteps.length === 0) {
      setPreview(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const result = await previewPipeline(pipelineSteps);
      setPreview(result);
      setError(null);
    } catch (e) {
      setPreview(null);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const debouncedPreview = useMemo(
    () => debounce((pipelineSteps: TransformationStep[]) => {
      void runPreview(pipelineSteps);
    }, 150),
    [runPreview],
  );

  useEffect(() => {
    debouncedPreview(steps);
  }, [steps, debouncedPreview]);

  async function handleOpenCsv() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected === "string") {
      setCsvPath(selected);
      setFilterCondition("");
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(ellipse_at_top,_#0f766e22,_#0b1220_55%)] text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800/80 px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-teal-300">
            DWH-RS-QUERY
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Локальный пайплайн · DuckDB preview ≤50 строк
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={!preview}
          >
            {showSql ? "Скрыть SQL" : "Показать SQL"}
          </button>
          <button
            type="button"
            onClick={() => void handleOpenCsv()}
            className="rounded-md bg-teal-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
          >
            Открыть CSV
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
        <aside className="border-r border-slate-800/80 p-4">
          <History
            steps={steps}
            onRemoveFilter={() => setFilterCondition("")}
          />
          <div className="mt-6">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Filter (SQL WHERE)
            </label>
            <input
              type="text"
              value={filterCondition}
              onChange={(e) => setFilterCondition(e.target.value)}
              disabled={!csvPath}
              placeholder='region = &#39;EU&#39;'
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-teal-600/40 placeholder:text-slate-600 focus:ring-2 disabled:opacity-40"
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              Debounce 150ms · превью обновляется автоматически
            </p>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Preview
            </h2>
            <span className="text-xs text-slate-500">
              {loading
                ? "загрузка…"
                : preview
                  ? `${preview.rows.length} строк · ${preview.columns.length} кол.`
                  : "—"}
            </span>
          </div>

          {error && (
            <div className="mb-3 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
              {error}
            </div>
          )}

          {showSql && preview?.sql && (
            <pre className="mb-3 max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950/80 p-3 text-[11px] leading-relaxed text-slate-400">
              {preview.sql}
            </pre>
          )}

          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-800 bg-slate-950/50">
            {preview ? (
              <PreviewTable columns={preview.columns} rows={preview.rows} />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-500">
                {csvPath
                  ? "Ожидание превью…"
                  : "Выберите CSV, чтобы увидеть превью"}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
