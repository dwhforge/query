import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { History } from "./components/History";
import { PreviewTable } from "./components/PreviewTable";
import { debounce } from "./lib/debounce";
import { exportDbt, previewWorkspace } from "./lib/tauri";
import {
  newQueryId,
  type JoinType,
  type PreviewResult,
  type QueryDef,
  type TransformationStep,
  type Workspace,
} from "./types/pipeline";

function App() {
  const [queries, setQueries] = useState<QueryDef[]>([]);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [focusQueryId, setFocusQueryId] = useState<string | null>(null);
  const [filterCondition, setFilterCondition] = useState("");
  const [joinRightId, setJoinRightId] = useState("");
  const [joinKey, setJoinKey] = useState("region");
  const [joinType, setJoinType] = useState<JoinType>("inner");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [showPgForm, setShowPgForm] = useState(false);
  const [pgConn, setPgConn] = useState("postgresql://user:pass@localhost:5432/db");
  const [pgTable, setPgTable] = useState("");

  const activeQuery = queries.find((q) => q.id === activeQueryId) ?? null;

  const workspace: Workspace | null = useMemo(() => {
    if (queries.length === 0 || !focusQueryId) return null;
    // Rebuild steps for active query from controls that live outside steps list
    // (filter/join are applied into steps via explicit actions; workspace is queries as-is)
    return { queries, focus_query_id: focusQueryId };
  }, [queries, focusQueryId]);

  const runPreview = useCallback(async (ws: Workspace) => {
    setLoading(true);
    try {
      const result = await previewWorkspace(ws);
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
    () =>
      debounce((ws: Workspace) => {
        void runPreview(ws);
      }, 150),
    [runPreview],
  );

  useEffect(() => {
    if (workspace) debouncedPreview(workspace);
  }, [workspace, debouncedPreview]);

  async function addCsvQuery() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected !== "string") return;
    const id = newQueryId();
    const name =
      selected.split(/[/\\]/).pop()?.replace(/\.csv$/i, "") ?? id;
    const q: QueryDef = {
      id,
      name,
      steps: [{ type: "LoadCsv", payload: { path: selected } }],
    };
    setQueries((prev) => [...prev, q]);
    setActiveQueryId(id);
    setFocusQueryId((prev) => prev ?? id);
    setFilterCondition("");
  }

  function addPostgresQuery() {
    const table = pgTable.trim();
    const conn = pgConn.trim();
    if (!table || !conn) {
      setError("Postgres: connection string and table name are required");
      return;
    }
    const id = newQueryId();
    const q: QueryDef = {
      id,
      name: table,
      steps: [
        {
          type: "LoadPostgres",
          payload: { connection_string: conn, table_name: table },
        },
      ],
    };
    setQueries((prev) => [...prev, q]);
    setActiveQueryId(id);
    setFocusQueryId((prev) => prev ?? id);
    setShowPgForm(false);
    setFilterCondition("");
    setError(null);
  }

  function updateActiveSteps(mutator: (steps: TransformationStep[]) => TransformationStep[]) {
    if (!activeQueryId) return;
    setQueries((prev) =>
      prev.map((q) =>
        q.id === activeQueryId ? { ...q, steps: mutator(q.steps) } : q,
      ),
    );
  }

  function applyFilter() {
    const cond = filterCondition.trim();
    updateActiveSteps((steps) => {
      const without = steps.filter((s) => s.type !== "Filter");
      if (!cond) return without;
      return [...without, { type: "Filter", payload: { condition: cond } }];
    });
  }

  function applyJoin() {
    if (!joinRightId || !joinKey.trim()) return;
    if (joinRightId === activeQueryId) {
      setError("Join: нельзя джойнить query саму на себя");
      return;
    }
    const key = joinKey.trim();
    updateActiveSteps((steps) => {
      const without = steps.filter((s) => s.type !== "Join");
      return [
        ...without,
        {
          type: "Join",
          payload: {
            right_query_id: joinRightId,
            join_type: joinType,
            left_on: [key],
            right_on: [key],
          },
        },
      ];
    });
  }

  function removeStepAt(index: number) {
    updateActiveSteps((steps) => steps.filter((_, i) => i !== index));
  }

  async function handleExportDbt() {
    if (!workspace) return;
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      const path = await exportDbt("dwh_rs_query", workspace, dir);
      setExportMsg(`dbt project: ${path}`);
      setError(null);
    } catch (e) {
      setExportMsg(null);
      setError(typeof e === "string" ? e : String(e));
    }
  }

  const otherQueries = queries.filter((q) => q.id !== activeQueryId);

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(ellipse_at_top,_#0f766e22,_#0b1220_55%)] text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800/80 px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-teal-300">
            DWH-RS-QUERY
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Multi-source workspace · DuckDB preview · dbt export
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={!preview}
          >
            {showSql ? "Скрыть SQL" : "SQL (read-only)"}
          </button>
          <button
            type="button"
            onClick={() => void handleExportDbt()}
            className="rounded-md border border-teal-800 px-3 py-1.5 text-xs text-teal-300 hover:bg-teal-950/50"
            disabled={!workspace}
          >
            Export dbt
          </button>
          <button
            type="button"
            onClick={() => setShowPgForm((v) => !v)}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:border-teal-600"
          >
            + Postgres
          </button>
          <button
            type="button"
            onClick={() => void addCsvQuery()}
            className="rounded-md bg-teal-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
          >
            + CSV query
          </button>
        </div>
      </header>

      {showPgForm && (
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-800 bg-slate-950/80 px-6 py-3">
          <div className="min-w-[280px] flex-1">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Connection string
            </label>
            <input
              value={pgConn}
              onChange={(e) => setPgConn(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-48">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Table
            </label>
            <input
              value={pgTable}
              onChange={(e) => setPgTable(e.target.value)}
              placeholder="public.orders"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={addPostgresQuery}
            className="rounded-md bg-teal-700 px-3 py-1.5 text-sm text-white hover:bg-teal-600"
          >
            Add query
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_300px_1fr]">
        <aside className="border-r border-slate-800/80 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Queries
          </h2>
          <ul className="flex flex-col gap-1">
            {queries.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveQueryId(q.id);
                    const f = q.steps.find((s) => s.type === "Filter");
                    setFilterCondition(
                      f && f.type === "Filter" ? f.payload.condition : "",
                    );
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                    q.id === activeQueryId
                      ? "bg-slate-800 text-teal-200"
                      : "text-slate-300 hover:bg-slate-900"
                  }`}
                >
                  <span className="truncate">{q.name}</span>
                  {q.id === focusQueryId && (
                    <span className="ml-1 text-[10px] text-teal-500">focus</span>
                  )}
                </button>
                {q.id !== focusQueryId && (
                  <button
                    type="button"
                    className="ml-2 text-[10px] text-slate-600 hover:text-teal-400"
                    onClick={() => setFocusQueryId(q.id)}
                  >
                    set focus
                  </button>
                )}
              </li>
            ))}
          </ul>
          {queries.length === 0 && (
            <p className="mt-2 text-xs text-slate-600">
              Добавьте CSV как отдельную query (источник).
            </p>
          )}
        </aside>

        <aside className="border-r border-slate-800/80 p-4">
          <History
            steps={activeQuery?.steps ?? []}
            onRemoveAt={removeStepAt}
          />
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Filter
              </label>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={filterCondition}
                  onChange={(e) => setFilterCondition(e.target.value)}
                  disabled={!activeQuery}
                  placeholder="amount > 1000"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                />
                <button
                  type="button"
                  onClick={applyFilter}
                  disabled={!activeQuery}
                  className="rounded-md border border-slate-700 px-2 text-xs text-slate-300"
                >
                  OK
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Join
              </label>
              <select
                value={joinRightId}
                onChange={(e) => setJoinRightId(e.target.value)}
                disabled={!activeQuery || otherQueries.length === 0}
                className="mb-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm disabled:opacity-40"
              >
                <option value="">right query…</option>
                {otherQueries.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
              <div className="mb-1 flex gap-1">
                <select
                  value={joinType}
                  onChange={(e) => setJoinType(e.target.value as JoinType)}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs"
                >
                  <option value="inner">inner</option>
                  <option value="left">left</option>
                  <option value="right">right</option>
                  <option value="full">full</option>
                </select>
                <input
                  value={joinKey}
                  onChange={(e) => setJoinKey(e.target.value)}
                  placeholder="key"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                />
              </div>
              <button
                type="button"
                onClick={applyJoin}
                disabled={!activeQuery || !joinRightId}
                className="rounded-md bg-slate-800 px-3 py-1 text-xs text-teal-200 hover:bg-slate-700 disabled:opacity-40"
              >
                Apply Join
              </button>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Preview {focusQueryId ? `· ${focusQueryId}` : ""}
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
          {exportMsg && (
            <div className="mb-3 rounded-md border border-teal-900/60 bg-teal-950/40 px-3 py-2 text-sm text-teal-200">
              {exportMsg}
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
                Добавьте queries и выставьте focus для preview
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
