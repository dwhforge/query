import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { EmptyHero } from "./components/EmptyHero";
import { GraphCanvas } from "./components/GraphCanvas";
import { History } from "./components/History";
import { PreviewTable } from "./components/PreviewTable";
import { debounce } from "./lib/debounce";
import {
  exportDbt,
  loadSampleWorkspace,
  previewWorkspace,
} from "./lib/tauri";
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
  const [pgConn, setPgConn] = useState(
    "postgresql://user:pass@localhost:5432/db",
  );
  const [pgTable, setPgTable] = useState("");

  const activeQuery = queries.find((q) => q.id === activeQueryId) ?? null;

  const workspace: Workspace | null = useMemo(() => {
    if (queries.length === 0 || !focusQueryId) return null;
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

  const selectQuery = useCallback(
    (id: string) => {
      setActiveQueryId(id);
      const q = queries.find((x) => x.id === id);
      const f = q?.steps.find((s) => s.type === "Filter");
      setFilterCondition(f && f.type === "Filter" ? f.payload.condition : "");
      const j = q?.steps.find((s) => s.type === "Join");
      if (j && j.type === "Join") {
        setJoinRightId(j.payload.right_query_id);
        setJoinKey(j.payload.left_on[0] ?? "region");
        setJoinType(j.payload.join_type);
      }
    },
    [queries],
  );

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
      setError("Postgres requires connection string and table name");
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

  async function handleLoadSample() {
    try {
      const ws = await loadSampleWorkspace();
      setQueries(ws.queries);
      setFocusQueryId(ws.focus_query_id);
      setActiveQueryId(ws.focus_query_id);
      setFilterCondition("amount > 1000");
      setJoinRightId("dim_region");
      setJoinKey("region");
      setJoinType("inner");
      setError(null);
      setExportMsg(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  function updateActiveSteps(
    mutator: (steps: TransformationStep[]) => TransformationStep[],
  ) {
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
      setError("Cannot join a query to itself");
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
    setError(null);
  }

  function removeStepAt(index: number) {
    updateActiveSteps((steps) => steps.filter((_, i) => i !== index));
  }

  async function handleExportDbt() {
    if (!workspace) return;
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      const path = await exportDbt("dwh_rs_query", workspace, dir, "v1");
      setExportMsg(`dbt v1 project → ${path}`);
      setError(null);
    } catch (e) {
      setExportMsg(null);
      setError(typeof e === "string" ? e : String(e));
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        void addCsvQuery();
      } else if (k === "s") {
        e.preventDefault();
        void handleLoadSample();
      } else if (k === "e") {
        e.preventDefault();
        void handleExportDbt();
      } else if (k === "/" || k === "?") {
        e.preventDefault();
        setShowSql((v) => !v);
      } else if (k === "p") {
        e.preventDefault();
        setShowPgForm((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Intentionally stable listeners; handlers use latest state via closures on remount of empty deps is avoided by re-binding when workspace presence changes.
  }, [workspace, showPgForm]);

  const otherQueries = queries.filter((q) => q.id !== activeQueryId);
  const empty = queries.length === 0;

  return (
    <div className="flex h-screen flex-col text-slate-100">
      <header className="relative z-10 flex items-center justify-between border-b border-[var(--line)] px-6 py-3 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-teal-300">
            DWH-RS-QUERY
          </h1>
          <p className="truncate text-xs text-slate-500">
            Visual multi-source pipelines · DuckDB preview · dbt v1 export
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={!preview}
            title="/"
          >
            {showSql ? "Hide SQL" : "SQL"}
          </button>
          <button
            type="button"
            onClick={() => void handleExportDbt()}
            className="rounded-lg border border-teal-800/80 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-950/40"
            disabled={!workspace}
            title="E"
          >
            Export dbt
          </button>
          <button
            type="button"
            onClick={() => setShowPgForm((v) => !v)}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-teal-700"
            title="P"
          >
            + Postgres
          </button>
          <button
            type="button"
            onClick={() => void addCsvQuery()}
            className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400"
            title="O"
          >
            + CSV
          </button>
        </div>
      </header>

      {showPgForm && (
        <div className="flex flex-wrap items-end gap-2 border-b border-[var(--line)] bg-slate-950/90 px-6 py-3">
          <div className="min-w-[280px] flex-1">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Connection string
            </label>
            <input
              value={pgConn}
              onChange={(e) => setPgConn(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-700"
            />
          </div>
          <div className="w-48">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              Table
            </label>
            <input
              value={pgTable}
              onChange={(e) => setPgTable(e.target.value)}
              placeholder="orders"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-700"
            />
          </div>
          <button
            type="button"
            onClick={addPostgresQuery}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
          >
            Add query
          </button>
        </div>
      )}

      {empty ? (
        <EmptyHero
          onLoadSample={() => void handleLoadSample()}
          onAddCsv={() => void addCsvQuery()}
          onAddPostgres={() => setShowPgForm(true)}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(240px,32%)_1fr] lg:grid-cols-[1fr_320px] lg:grid-rows-1">
          <section className="flex min-h-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between px-4 py-2">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Pipeline canvas
              </h2>
              <button
                type="button"
                onClick={() => void handleLoadSample()}
                className="text-[11px] text-teal-500/90 hover:text-teal-300"
              >
                Reload sample
              </button>
            </div>
            <div className="min-h-0 flex-1 px-3 pb-3">
              <GraphCanvas
                queries={queries}
                activeQueryId={activeQueryId}
                focusQueryId={focusQueryId}
                onSelect={selectQuery}
                onSetFocus={setFocusQueryId}
              />
            </div>
            <p className="px-4 pb-2 text-[10px] text-slate-600">
              Click node to edit · double-click to set focus · join edges pulse when
              linked
            </p>
          </section>

          <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:border-b-0">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-semibold text-slate-100">
                  {activeQuery?.name ?? "Select a node"}
                </h2>
                {activeQuery && activeQuery.id !== focusQueryId && (
                  <button
                    type="button"
                    onClick={() => setFocusQueryId(activeQuery.id)}
                    className="shrink-0 text-[10px] uppercase tracking-wide text-teal-400"
                  >
                    Set focus
                  </button>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <History
                steps={activeQuery?.steps ?? []}
                onRemoveAt={removeStepAt}
              />
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Filter
                  </label>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={filterCondition}
                      onChange={(e) => setFilterCondition(e.target.value)}
                      onBlur={applyFilter}
                      onKeyDown={(e) => e.key === "Enter" && applyFilter()}
                      disabled={!activeQuery}
                      placeholder="amount > 1000"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Join
                  </label>
                  <select
                    value={joinRightId}
                    onChange={(e) => setJoinRightId(e.target.value)}
                    disabled={!activeQuery || otherQueries.length === 0}
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm disabled:opacity-40"
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
                      className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs"
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
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={applyJoin}
                    disabled={!activeQuery || !joinRightId}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    Apply Join
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      {!empty && (
        <section className="flex min-h-[36vh] flex-col border-t border-[var(--line)] bg-[#060d14]">
          <div className="flex items-center justify-between px-4 py-2">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Preview
              {focusQueryId
                ? ` · ${queries.find((q) => q.id === focusQueryId)?.name ?? focusQueryId}`
                : ""}
            </h2>
            <span className="text-xs text-slate-500">
              {loading
                ? "running…"
                : preview
                  ? `${preview.rows.length} rows · ${preview.columns.length} cols`
                  : "—"}
            </span>
          </div>
          {(error || exportMsg) && (
            <div className="space-y-1 px-4 pb-2">
              {error && (
                <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
                  {error}
                </div>
              )}
              {exportMsg && (
                <div className="rounded-lg border border-teal-900/50 bg-teal-950/30 px-3 py-2 text-sm text-teal-200">
                  {exportMsg}
                </div>
              )}
            </div>
          )}
          {showSql && preview?.sql && (
            <pre className="mx-4 mb-2 max-h-28 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-[11px] leading-relaxed text-slate-400">
              {preview.sql}
            </pre>
          )}
          <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
            <div className="h-full overflow-hidden rounded-xl border border-[var(--line)] bg-slate-950/40">
              {preview ? (
                <PreviewTable columns={preview.columns} rows={preview.rows} />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-600">
                  Waiting for preview…
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
