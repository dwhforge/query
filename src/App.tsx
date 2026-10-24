import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { EmptyHero } from "./components/EmptyHero";
import { ExplorerTree } from "./components/ExplorerTree";
import { GraphCanvas } from "./components/GraphCanvas";
import { History } from "./components/History";
import {
  PostgresPicker,
  type PostgresSelection,
} from "./components/PostgresPicker";
import { PreviewTable } from "./components/PreviewTable";
import { debounce } from "./lib/debounce";
import {
  exportDbt,
  loadSampleWorkspace,
  previewWorkspace,
} from "./lib/tauri";
import {
  emptyProject,
  newQueryId,
  syncSourcesFromQueries,
  type JoinType,
  type PreviewResult,
  type Project,
  type QueryDef,
  type SourceDef,
  type TransformationStep,
  type Workspace,
} from "./types/pipeline";

function App() {
  const [project, setProject] = useState<Project>(() => emptyProject("Untitled"));
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [filterCondition, setFilterCondition] = useState("");
  const [joinRightId, setJoinRightId] = useState("");
  const [joinKey, setJoinKey] = useState("region");
  const [joinType, setJoinType] = useState<JoinType>("inner");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [showPgPicker, setShowPgPicker] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({
    sources: true,
    queries: true,
    export: true,
  });

  const queries = project.workspace.queries;
  const focusQueryId = project.workspace.focus_query_id || null;
  const activeQuery = queries.find((q) => q.id === activeQueryId) ?? null;

  const workspace: Workspace | null = useMemo(() => {
    if (queries.length === 0 || !focusQueryId) return null;
    return project.workspace;
  }, [project.workspace, queries.length, focusQueryId]);

  const setQueries = useCallback(
    (updater: (prev: QueryDef[]) => QueryDef[]) => {
      setProject((p) => {
        const nextQueries = updater(p.workspace.queries);
        const focus =
          p.workspace.focus_query_id &&
          nextQueries.some((q) => q.id === p.workspace.focus_query_id)
            ? p.workspace.focus_query_id
            : (nextQueries[0]?.id ?? "");
        return {
          ...p,
          sources: syncSourcesFromQueries(p.sources, nextQueries),
          workspace: { queries: nextQueries, focus_query_id: focus },
        };
      });
    },
    [],
  );

  const setFocusQueryId = useCallback((id: string) => {
    setProject((p) => ({
      ...p,
      workspace: { ...p.workspace, focus_query_id: id },
    }));
  }, []);

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

  function onSelectSource(source: SourceDef) {
    const bound = queries.find((q) => {
      const s = q.steps[0];
      if (!s) return false;
      if (source.kind === "csv" && s.type === "LoadCsv")
        return s.payload.path === source.path;
      if (source.kind === "parquet" && s.type === "LoadParquet")
        return s.payload.path === source.path;
      if (source.kind === "postgres" && s.type === "LoadPostgres")
        return (
          s.payload.table_name === source.table_name &&
          (s.payload.schema || "public") === (source.schema || "public")
        );
      return false;
    });
    if (bound) selectQuery(bound.id);
  }

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
    setProject((p) => {
      const nextQueries = [...p.workspace.queries, q];
      return {
        ...p,
        sources: syncSourcesFromQueries(p.sources, nextQueries),
        workspace: {
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
    setFilterCondition("");
  }

  function addPostgresFromPicker(sel: PostgresSelection) {
    const id = newQueryId();
    const q: QueryDef = {
      id,
      name: `${sel.schema}.${sel.table_name}`,
      steps: [
        {
          type: "LoadPostgres",
          payload: {
            connection_string: sel.connection_string,
            schema: sel.schema,
            table_name: sel.table_name,
          },
        },
      ],
    };
    setProject((p) => {
      const nextQueries = [...p.workspace.queries, q];
      return {
        ...p,
        sources: syncSourcesFromQueries(p.sources, nextQueries),
        workspace: {
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
    setShowPgPicker(false);
    setFilterCondition("");
    setError(null);
  }

  async function handleLoadSample() {
    try {
      const ws = await loadSampleWorkspace();
      setProject((p) => ({
        ...p,
        name: p.name === "Untitled" ? "sample_join" : p.name,
        sources: syncSourcesFromQueries([], ws.queries),
        workspace: ws,
      }));
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
      const path = await exportDbt(
        project.name.replace(/\s+/g, "_").toLowerCase() || "dwh_rs_query",
        workspace,
        dir,
        project.dbt_target,
      );
      setProject((p) => ({ ...p, last_dbt_export_path: path }));
      setExportMsg(`dbt ${project.dbt_target} → ${path}`);
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
        setShowPgPicker((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace, showPgPicker, project.name, project.dbt_target]);

  // Fix addCsvQuery focus race: simplify by combining into one setProject
  // (handlers above already mostly OK)

  const otherQueries = queries.filter((q) => q.id !== activeQueryId);
  const empty = queries.length === 0;

  return (
    <div className="flex h-screen flex-col text-slate-100">
      <header className="relative z-10 flex items-center justify-between border-b border-[var(--line)] px-5 py-3 backdrop-blur">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-teal-300">
            DWH-RS-QUERY
          </h1>
          <p className="truncate text-xs text-slate-500">
            Project · Sources · Queries · visual canvas · dbt export
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowSql((v) => !v)}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={!preview}
          >
            {showSql ? "Hide SQL" : "SQL"}
          </button>
          <button
            type="button"
            onClick={() => void handleExportDbt()}
            className="rounded-lg border border-teal-800/80 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-950/40"
            disabled={!workspace}
          >
            Export dbt
          </button>
          <button
            type="button"
            onClick={() => setShowPgPicker(true)}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-teal-700"
          >
            + Postgres
          </button>
          <button
            type="button"
            onClick={() => void addCsvQuery()}
            className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400"
          >
            + CSV
          </button>
        </div>
      </header>

      <PostgresPicker
        open={showPgPicker}
        onClose={() => setShowPgPicker(false)}
        onSelect={addPostgresFromPicker}
      />

      {empty ? (
        <EmptyHero
          onLoadSample={() => void handleLoadSample()}
          onAddCsv={() => void addCsvQuery()}
          onAddPostgres={() => setShowPgPicker(true)}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] lg:grid-cols-[240px_1fr_300px]">
          {/* Explorer */}
          <aside className="min-h-0 border-r border-[var(--line)] bg-[#050b12]">
            <ExplorerTree
              project={project}
              activeQueryId={activeQueryId}
              expanded={treeExpanded}
              onToggle={(key) =>
                setTreeExpanded((e) => ({ ...e, [key]: e[key] === false }))
              }
              onSelectQuery={selectQuery}
              onSelectSource={onSelectSource}
              onExport={() => void handleExportDbt()}
              onAddSourceCsv={() => void addCsvQuery()}
              onAddSourcePostgres={() => setShowPgPicker(true)}
            />
          </aside>

          {/* Canvas */}
          <section className="flex min-h-0 flex-col border-r border-[var(--line)]">
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
            <div className="min-h-0 flex-1 px-3 pb-2">
              <GraphCanvas
                queries={queries}
                activeQueryId={activeQueryId}
                focusQueryId={focusQueryId}
                onSelect={selectQuery}
                onSetFocus={setFocusQueryId}
              />
            </div>
            <div className="min-h-[28vh] border-t border-[var(--line)] bg-[#060d14]">
              <div className="flex items-center justify-between px-4 py-2">
                <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Preview
                  {focusQueryId
                    ? ` · ${queries.find((q) => q.id === focusQueryId)?.name ?? ""}`
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
                <pre className="mx-4 mb-2 max-h-24 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-[11px] text-slate-400">
                  {preview.sql}
                </pre>
              )}
              <div className="h-[22vh] px-3 pb-3">
                <div className="h-full overflow-hidden rounded-xl border border-[var(--line)] bg-slate-950/40">
                  {preview ? (
                    <PreviewTable
                      columns={preview.columns}
                      rows={preview.rows}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-600">
                      Waiting for preview…
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Inspector */}
          <aside className="hidden min-h-0 flex-col lg:flex">
            <div className="border-b border-[var(--line)] px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-semibold text-slate-100">
                  {activeQuery?.name ?? "Select a query"}
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
    </div>
  );
}

export default App;
