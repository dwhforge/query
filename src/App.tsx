import { useCallback, useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { EmptyHero } from "./components/EmptyHero";
import { ExplorerTree } from "./components/ExplorerTree";
import {
  GraphCanvas,
  type CanvasPositions,
  type GraphEdgeInfo,
} from "./components/GraphCanvas";
import { History } from "./components/History";
import {
  PostgresPicker,
  type PostgresSelection,
} from "./components/PostgresPicker";
import { PreviewTable } from "./components/PreviewTable";
import { S3SourceDialog } from "./components/S3SourceDialog";
import { SourceSchemaPanel } from "./components/SourceSchemaPanel";
import { StepPalette } from "./components/StepPalette";
import { debounce } from "./lib/debounce";
import {
  describePostgresObject,
  exportDbt,
  listExportTree,
  getLastProjectPath,
  loadProject,
  loadSampleWorkspace,
  previewDbtModel,
  previewWorkspace,
  saveProject,
  type PreviewDbtModel,
  type PostgresColumn,
} from "./lib/tauri";
import {
  connectionById,
  emptyProject,
  newQueryId,
  syncSourcesFromQueries,
  type ConnectionDef,
  type ConnectionKind,
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
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [groupDims, setGroupDims] = useState("");
  const [groupAggs, setGroupAggs] = useState("count(*) as n");
  const [joinRightId, setJoinRightId] = useState("");
  const [joinKey, setJoinKey] = useState("region");
  const [joinType, setJoinType] = useState<JoinType>("inner");
  const [appendOtherId, setAppendOtherId] = useState("");
  const [sqlCopied, setSqlCopied] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [modelPreview, setModelPreview] = useState<PreviewDbtModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bottom dock: sample rows vs generated model SQL (H0 projection; H1 editable later). */
  const [bottomTab, setBottomTab] = useState<"data" | "model">("data");
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportFiles, setExportFiles] = useState<string[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceColumns, setSourceColumns] = useState<PostgresColumn[] | null>(
    null,
  );
  const [sourceSchemaLoading, setSourceSchemaLoading] = useState(false);
  const [sourceSchemaError, setSourceSchemaError] = useState<string | null>(
    null,
  );
  const [showPgPicker, setShowPgPicker] = useState(false);
  const [showS3Dialog, setShowS3Dialog] = useState(false);
  const [connEditorOpen, setConnEditorOpen] = useState(false);
  const [connEditorKind, setConnEditorKind] =
    useState<ConnectionKind>("postgres");
  const [editingConnection, setEditingConnection] =
    useState<ConnectionDef | null>(null);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({
    connections: true,
    sources: true,
    queries: true,
    export: true,
  });

  const queries = project.workspace.queries;
  const focusQueryId = project.workspace.focus_query_id || null;
  const activeQuery = queries.find((q) => q.id === activeQueryId) ?? null;

  /** ★ export mart — independent of canvas selection. */
  const workspace: Workspace | null = useMemo(() => {
    if (queries.length === 0 || !focusQueryId) return null;
    return project.workspace;
  }, [project.workspace, queries.length, focusQueryId]);

  /** Data tab: preview the selected query (fallback to focus). */
  const dataWorkspace: Workspace | null = useMemo(() => {
    if (queries.length === 0) return null;
    const id = activeQueryId || focusQueryId;
    if (!id || !queries.some((q) => q.id === id)) return null;
    return { ...project.workspace, focus_query_id: id };
  }, [project.workspace, queries, activeQueryId, focusQueryId]);

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

  const connections = project.connections;

  const runPreview = useCallback(
    async (ws: Workspace, conns: ConnectionDef[]) => {
      setLoading(true);
      try {
        const result = await previewWorkspace(ws, conns);
        setPreview(result);
        setError(null);
      } catch (e) {
        setPreview(null);
        setError(typeof e === "string" ? e : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const debouncedPreview = useMemo(
    () =>
      debounce((ws: Workspace, conns: ConnectionDef[]) => {
        void runPreview(ws, conns);
      }, 150),
    [runPreview],
  );

  useEffect(() => {
    if (dataWorkspace) debouncedPreview(dataWorkspace, connections);
  }, [dataWorkspace, connections, debouncedPreview]);

  // Model tab: dbt SQL for the selected query (instant, no DuckDB).
  useEffect(() => {
    const id = activeQueryId || focusQueryId;
    if (!id || queries.length === 0) {
      setModelPreview(null);
      setModelError(null);
      return;
    }
    let cancelled = false;
    void previewDbtModel(project.workspace, id)
      .then((m) => {
        if (!cancelled) {
          setModelPreview(m);
          setModelError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setModelPreview(null);
          const msg = typeof e === "string" ? e : String(e);
          // Old Tauri binary without the new command — needs full restart, not HMR.
          setModelError(
            /not found/i.test(msg)
              ? "Backend outdated: stop & restart Tauri Dev (HMR won’t load preview_dbt_model)."
              : msg,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.workspace, activeQueryId, focusQueryId, queries.length]);

  const syncInspectorFromQuery = useCallback(
    (q: QueryDef | undefined) => {
      if (!q) {
        setFilterCondition("");
        setSelectedColumns([]);
        setGroupDims("");
        setGroupAggs("count(*) as n");
        setJoinRightId("");
        setJoinKey("");
        setJoinType("inner");
        return;
      }
      const f = q.steps.find((s) => s.type === "Filter");
      setFilterCondition(f && f.type === "Filter" ? f.payload.condition : "");
      const sc = q.steps.find((s) => s.type === "SelectColumns");
      setSelectedColumns(
        sc && sc.type === "SelectColumns" ? [...sc.payload.columns] : [],
      );
      const g = q.steps.find((s) => s.type === "GroupBy");
      if (g && g.type === "GroupBy") {
        setGroupDims(g.payload.dimensions.join(", "));
        setGroupAggs(g.payload.aggregates.join(", "));
      } else {
        setGroupDims("");
        setGroupAggs("count(*) as n");
      }
      const j = q.steps.find((s) => s.type === "Join");
      if (j && j.type === "Join") {
        setJoinRightId(j.payload.right_query_id);
        setJoinKey(j.payload.left_on[0] ?? "");
        setJoinType(j.payload.join_type);
      } else {
        setJoinRightId("");
        setJoinKey("");
        setJoinType("inner");
      }
      const a = q.steps.find((s) => s.type === "Append");
      if (a && a.type === "Append") {
        setAppendOtherId(a.payload.other_query_ids[0] ?? "");
      } else {
        setAppendOtherId("");
      }
    },
    [],
  );

  const selectQuery = useCallback(
    (id: string) => {
      setActiveQueryId(id);
      syncInspectorFromQuery(queries.find((x) => x.id === id));
    },
    [queries, syncInspectorFromQuery],
  );

  // Keep Join/Filter form in sync when steps change (sample load, remove, etc.)
  useEffect(() => {
    if (!activeQueryId) return;
    syncInspectorFromQuery(queries.find((q) => q.id === activeQueryId));
  }, [activeQueryId, queries, syncInspectorFromQuery]);

  async function loadPostgresSchema(source: SourceDef) {
    if (source.kind !== "postgres") {
      setSourceColumns(null);
      setSourceSchemaError(null);
      return;
    }
    const conn = connectionById(project, source.connection_id);
    const dsn =
      conn?.postgres?.connection_string ?? source.connection_string ?? "";
    if (!dsn.trim()) {
      setSourceColumns(null);
      setSourceSchemaError("No connection string for this Postgres source");
      return;
    }
    setSourceSchemaLoading(true);
    setSourceSchemaError(null);
    try {
      const cols = await describePostgresObject(
        dsn,
        source.schema || "public",
        source.table_name || "",
      );
      setSourceColumns(cols);
    } catch (e) {
      setSourceColumns(null);
      setSourceSchemaError(typeof e === "string" ? e : String(e));
    } finally {
      setSourceSchemaLoading(false);
    }
  }

  function onSelectSource(source: SourceDef) {
    setSelectedSourceId(source.id);
    void loadPostgresSchema(source);
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
          (s.payload.schema || "public") === (source.schema || "public") &&
          (s.payload.connection_id ?? "") === (source.connection_id ?? "")
        );
      return false;
    });
    if (bound) selectQuery(bound.id);
  }

  const selectedSource =
    project.sources.find((s) => s.id === selectedSourceId) ?? null;

  function upsertConnection(conn: ConnectionDef) {
    setProject((p) => {
      const idx = p.connections.findIndex((c) => c.id === conn.id);
      const connections =
        idx >= 0
          ? p.connections.map((c) => (c.id === conn.id ? conn : c))
          : [...p.connections, conn];
      return { ...p, connections };
    });
    setConnEditorOpen(false);
    setEditingConnection(null);
  }

  function openNewConnection(kind: ConnectionKind) {
    setEditingConnection(null);
    setConnEditorKind(kind);
    setConnEditorOpen(true);
  }

  function addFileQuery(
    path: string,
    kind: "csv" | "parquet",
    connectionId?: string,
  ) {
    const id = newQueryId();
    const base = path.split(/[/\\]/).pop() ?? id;
    const name =
      kind === "csv"
        ? base.replace(/\.csv$/i, "")
        : base.replace(/\.parquet$/i, "");
    const step: TransformationStep =
      kind === "csv"
        ? { type: "LoadCsv", payload: { path } }
        : {
            type: "LoadParquet",
            payload: { path, connection_id: connectionId },
          };
    const q: QueryDef = { id, name, steps: [step] };
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

  async function addCsvQuery() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected !== "string") return;
    addFileQuery(selected, "csv");
  }

  /** New query whose first step Loads an existing Source (same object, new model). */
  function addQueryFromSource(source: SourceDef) {
    const id = newQueryId();
    let step: TransformationStep;
    let name = source.name;
    if (source.kind === "csv" && source.path) {
      step = { type: "LoadCsv", payload: { path: source.path } };
      name = source.name.replace(/\.csv$/i, "") || name;
    } else if (source.kind === "parquet" && source.path) {
      step = {
        type: "LoadParquet",
        payload: {
          path: source.path,
          connection_id: source.connection_id,
        },
      };
      name = source.name.replace(/\.parquet$/i, "") || name;
    } else if (source.kind === "postgres" && source.table_name) {
      step = {
        type: "LoadPostgres",
        payload: {
          connection_id: source.connection_id,
          connection_string: source.connection_string,
          schema: source.schema || "public",
          table_name: source.table_name,
        },
      };
      name = `${source.schema || "public"}.${source.table_name}`;
    } else {
      setError("Source is incomplete — cannot create query");
      return;
    }
    // Disambiguate if name already used (e.g. second query on sample.csv).
    const used = new Set(queries.map((q) => q.name));
    let finalName = name;
    if (used.has(finalName)) {
      let i = 2;
      while (used.has(`${name}_${i}`)) i += 1;
      finalName = `${name}_${i}`;
    }
    const q: QueryDef = { id, name: finalName, steps: [step], source_id: source.id };
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
    setSelectedSourceId(source.id);
    setFilterCondition("");
    setError(null);
  }

  function addQueryFromSelectedSourceOrCsv() {
    const src =
      selectedSourceId &&
      project.sources.find((s) => s.id === selectedSourceId);
    if (src) {
      addQueryFromSource(src);
      return;
    }
    void addCsvQuery();
  }

  async function addParquetQuery() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });
    if (typeof selected !== "string") return;
    addFileQuery(selected, "parquet");
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
            connection_id: sel.connection_id,
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

  function applyGroupBy(
    dimsCsv: string = groupDims,
    aggsCsv: string = groupAggs,
  ) {
    const dimensions = dimsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const aggregates = aggsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setGroupDims(dimensions.join(", "));
    setGroupAggs(
      aggregates.length > 0 ? aggregates.join(", ") : "count(*) as n",
    );
    updateActiveSteps((steps) => {
      const without = steps.filter((s) => s.type !== "GroupBy");
      if (dimensions.length === 0 || aggregates.length === 0) return without;
      return [
        ...without,
        { type: "GroupBy", payload: { dimensions, aggregates } },
      ];
    });
  }

  function applySelectColumns() {
    const cols = selectedColumns.map((c) => c.trim()).filter(Boolean);
    updateActiveSteps((steps) => {
      const without = steps.filter((s) => s.type !== "SelectColumns");
      if (cols.length === 0) return without;
      return [
        ...without,
        { type: "SelectColumns", payload: { columns: cols } },
      ];
    });
  }

  function toggleColumn(name: string) {
    setSelectedColumns((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name],
    );
  }

  function applyJoinTo(
    hostQueryId: string,
    rightQueryId: string,
    key: string,
    type: JoinType = joinType,
  ) {
    if (!rightQueryId || !key.trim()) return;
    if (rightQueryId === hostQueryId) {
      setError("Cannot join a query to itself");
      return;
    }
    const k = key.trim();
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== hostQueryId) return q;
        const without = q.steps.filter((s) => s.type !== "Join");
        return {
          ...q,
          steps: [
            ...without,
            {
              type: "Join",
              payload: {
                right_query_id: rightQueryId,
                join_type: type,
                left_on: [k],
                right_on: [k],
              },
            },
          ],
        };
      }),
    );
    setJoinRightId(rightQueryId);
    setJoinKey(k);
    setJoinType(type);
    setActiveQueryId(hostQueryId);
    setError(null);
  }

  function applyJoin() {
    if (!activeQueryId) return;
    applyJoinTo(activeQueryId, joinRightId, joinKey, joinType);
  }

  function connectJoinOnCanvas(rightQueryId: string, hostQueryId: string) {
    applyJoinTo(hostQueryId, rightQueryId, joinKey || "id", joinType);
  }

  function selectEdgeOnCanvas(edge: GraphEdgeInfo) {
    selectQuery(edge.hostQueryId);
    if (edge.kind === "join") {
      setJoinRightId(edge.otherQueryId);
      const host = queries.find((q) => q.id === edge.hostQueryId);
      const j = host?.steps.find((s) => s.type === "Join");
      if (j && j.type === "Join") {
        setJoinKey(j.payload.left_on[0] ?? joinKey);
        setJoinType(j.payload.join_type);
      }
    } else {
      setAppendOtherId(edge.otherQueryId);
    }
  }

  function removeEdgeOnCanvas(edge: GraphEdgeInfo) {
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== edge.hostQueryId) return q;
        if (edge.kind === "join") {
          return {
            ...q,
            steps: q.steps.filter((s) => s.type !== "Join"),
          };
        }
        if (edge.kind === "from") {
          return {
            ...q,
            steps: q.steps.filter(
              (s) =>
                !(
                  s.type === "FromQuery" &&
                  s.payload.query_id === edge.otherQueryId
                ),
            ),
          };
        }
        return {
          ...q,
          steps: q.steps
            .map((s) => {
              if (s.type !== "Append") return s;
              const others = s.payload.other_query_ids.filter(
                (id) => id !== edge.otherQueryId,
              );
              if (others.length === 0) return null;
              return {
                type: "Append" as const,
                payload: { other_query_ids: others },
              };
            })
            .filter((s): s is TransformationStep => s !== null),
        };
      }),
    );
    if (edge.kind === "join") {
      setJoinRightId("");
    } else if (appendOtherId === edge.otherQueryId) {
      setAppendOtherId("");
    }
    setError(null);
  }

  /** Branch: new query = FromQuery(selected) — dbt `ref`, no duplicate Load. */
  function deriveQueryFrom(fromQueryId: string) {
    const src = queries.find((q) => q.id === fromQueryId);
    if (!src) return;
    const id = newQueryId();
    const used = new Set(queries.map((q) => q.name));
    let name = `${src.name}_derived`;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${src.name}_${i}`)) i += 1;
      name = `${src.name}_${i}`;
    }
    const q: QueryDef = {
      id,
      name,
      steps: [{ type: "FromQuery", payload: { query_id: fromQueryId } }],
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
    setError(null);
  }

  /** Drop a query node: remove from workspace, scrub Join/Append refs, fix focus. */
  function removeQueryOnCanvas(queryId: string) {
    const remaining = queries.filter((q) => q.id !== queryId);
    const scrubbed = remaining.map((q) => ({
      ...q,
        steps: q.steps
          .map((s) => {
            if (s.type === "Join" && s.payload.right_query_id === queryId) {
              return null;
            }
            if (s.type === "FromQuery" && s.payload.query_id === queryId) {
              return null;
            }
            if (s.type === "Append") {
              const others = s.payload.other_query_ids.filter(
                (id) => id !== queryId,
              );
              if (others.length === 0) return null;
              return {
                type: "Append" as const,
                payload: { other_query_ids: others },
              };
            }
            return s;
          })
          .filter((s): s is TransformationStep => s !== null),
      }));
    const focus =
      focusQueryId === queryId
        ? (scrubbed[0]?.id ?? "")
        : focusQueryId && scrubbed.some((q) => q.id === focusQueryId)
          ? focusQueryId
          : (scrubbed[0]?.id ?? "");
    setProject((p) => {
      const positions = { ...(p.canvas?.positions ?? {}) };
      delete positions[queryId];
      return {
        ...p,
        sources: syncSourcesFromQueries(p.sources, scrubbed),
        workspace: { queries: scrubbed, focus_query_id: focus },
        canvas: { positions },
      };
    });
    if (activeQueryId === queryId) {
      setActiveQueryId(scrubbed[0]?.id ?? null);
    }
    if (joinRightId === queryId) setJoinRightId("");
    if (appendOtherId === queryId) setAppendOtherId("");
    setError(null);
  }

  const persistCanvasPositions = useMemo(
    () =>
      debounce((positions: CanvasPositions) => {
        setProject((p) => ({
          ...p,
          canvas: { positions },
        }));
      }, 300),
    [],
  );

  function applyAppend() {
    if (!appendOtherId) return;
    if (appendOtherId === activeQueryId) {
      setError("Cannot append a query to itself");
      return;
    }
    updateActiveSteps((steps) => {
      const without = steps.filter((s) => s.type !== "Append");
      return [
        ...without,
        {
          type: "Append",
          payload: { other_query_ids: [appendOtherId] },
        },
      ];
    });
    setError(null);
  }

  function removeStepAt(index: number) {
    updateActiveSteps((steps) => steps.filter((_, i) => i !== index));
  }

  function appendStep(step: TransformationStep) {
    updateActiveSteps((steps) => [...steps, step]);
  }

  async function handleSaveProject() {
    let path = project.root_path;
    if (!path) {
      const picked =
        (await save({
          defaultPath: `${project.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`,
          filters: [{ name: "DWH Project", extensions: ["json"] }],
        })) ?? null;
      if (typeof picked !== "string") return;
      path = picked;
    }
    try {
      await saveProject(path, project);
      setProject((p) => ({ ...p, root_path: path }));
      setExportMsg(`Project saved → ${path}`);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  function applyLoadedProject(loaded: Project, pathHint?: string) {
    const withConnections: Project = {
      ...loaded,
      connections: loaded.connections ?? [],
      root_path: loaded.root_path ?? pathHint,
    };
    setProject(withConnections);
    setActiveQueryId(withConnections.workspace.focus_query_id || null);
    void refreshExportTree(withConnections.last_dbt_export_path);
    setError(null);
  }

  async function refreshExportTree(exportPath: string | undefined) {
    if (!exportPath) {
      setExportFiles([]);
      return;
    }
    try {
      setExportFiles(await listExportTree(exportPath));
    } catch {
      setExportFiles([]);
    }
  }

  async function handleOpenProject() {
    const path = await open({
      multiple: false,
      filters: [{ name: "DWH Project", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const loaded = await loadProject(path);
      applyLoadedProject(loaded, path);
      setExportMsg(`Opened ${path}`);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  // Restore last project (connections included) on app launch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const path = await getLastProjectPath();
        if (!path || cancelled) return;
        const loaded = await loadProject(path);
        if (cancelled) return;
        applyLoadedProject(loaded, path);
        setExportMsg(`Restored ${path}`);
      } catch {
        // Missing/corrupt session — stay on empty Untitled.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount
  }, []);

  async function copySql() {
    const text =
      bottomTab === "model" ? modelPreview?.sql : preview?.sql;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setSqlCopied(true);
      window.setTimeout(() => setSqlCopied(false), 1500);
    } catch {
      setError("Could not copy SQL to clipboard");
    }
  }

  async function handleExportDbt() {
    if (!workspace) return;
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      const result = await exportDbt(
        project.name.replace(/\s+/g, "_").toLowerCase() || "dwh_rs_query",
        workspace,
        dir,
        project.dbt_target,
      );
      setProject((p) => ({ ...p, last_dbt_export_path: result.path }));
      setExportFiles(result.files);
      setTreeExpanded((e) => ({ ...e, export: true }));
      setExportMsg(
        `dbt ${project.dbt_target} → ${result.path} (${result.files.filter((f) => !f.endsWith("/")).length} files)`,
      );
      setError(null);
    } catch (e) {
      setExportMsg(null);
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function handleRevealExport() {
    const path = project.last_dbt_export_path;
    if (!path) return;
    try {
      await revealItemInDir(path);
    } catch (e) {
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
        setBottomTab((t) => (t === "data" ? "model" : "data"));
      } else if (k === "p") {
        e.preventDefault();
        setShowPgPicker((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && k === "s") {
        e.preventDefault();
        void handleSaveProject();
      } else if ((e.ctrlKey || e.metaKey) && k === "o") {
        e.preventDefault();
        void handleOpenProject();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace, showPgPicker, project.name, project.dbt_target]);

  // Fix addCsvQuery focus race: simplify by combining into one setProject
  // (handlers above already mostly OK)

  const otherQueries = queries.filter((q) => q.id !== activeQueryId);
  const empty = queries.length === 0;
  const activeJoin = activeQuery?.steps.find((s) => s.type === "Join");
  const activeAppend = activeQuery?.steps.find((s) => s.type === "Append");
  const activeSelect = activeQuery?.steps.find((s) => s.type === "SelectColumns");
  const activeGroup = activeQuery?.steps.find((s) => s.type === "GroupBy");
  const joinRightName =
    otherQueries.find((q) => q.id === joinRightId)?.name ??
    queries.find((q) => q.id === joinRightId)?.name ??
    (joinRightId || null);
  /** Columns to pick from — prefer live preview of the active/focus query. */
  const columnChoices = useMemo(() => {
    const fromPreview =
      preview &&
      (activeQueryId === focusQueryId || !focusQueryId) &&
      preview.columns.length > 0
        ? preview.columns.map((c) => c.name)
        : [];
    const fromStep =
      activeSelect && activeSelect.type === "SelectColumns"
        ? activeSelect.payload.columns
        : [];
    return [...new Set([...fromPreview, ...fromStep, ...selectedColumns])];
  }, [
    preview,
    activeQueryId,
    focusQueryId,
    activeSelect,
    selectedColumns,
  ]);

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
            onClick={() => void handleOpenProject()}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => void handleSaveProject()}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setBottomTab("model")}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={!modelPreview?.sql}
          >
            Model
          </button>
          <button
            type="button"
            onClick={() => void copySql()}
            className="rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
            disabled={
              bottomTab === "model" ? !modelPreview?.sql : !preview?.sql
            }
          >
            {sqlCopied ? "Copied" : "Copy SQL"}
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
            onClick={() => openNewConnection("postgres")}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-teal-700"
          >
            + Connection
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
            onClick={() => setShowS3Dialog(true)}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-teal-700"
          >
            + S3
          </button>
          <button
            type="button"
            onClick={() => void addParquetQuery()}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-teal-700"
          >
            + Parquet
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

      <ConnectionEditor
        open={connEditorOpen}
        initial={editingConnection}
        defaultKind={connEditorKind}
        onClose={() => {
          setConnEditorOpen(false);
          setEditingConnection(null);
        }}
        onSave={upsertConnection}
      />
      <PostgresPicker
        open={showPgPicker}
        connections={project.connections}
        onClose={() => setShowPgPicker(false)}
        onRequestNewConnection={() => openNewConnection("postgres")}
        onSelect={addPostgresFromPicker}
      />
      <S3SourceDialog
        open={showS3Dialog}
        connections={project.connections}
        onClose={() => setShowS3Dialog(false)}
        onRequestNewConnection={() => openNewConnection("s3")}
        onSelect={(sel) => {
          addFileQuery(sel.path, "parquet", sel.connection_id);
          setShowS3Dialog(false);
        }}
      />

      {empty ? (
        <EmptyHero
          onLoadSample={() => void handleLoadSample()}
          onAddCsv={() => void addCsvQuery()}
          onAddParquet={() => void addParquetQuery()}
          onAddPostgres={() => setShowPgPicker(true)}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] lg:grid-cols-[240px_1fr_300px]">
          {/* Explorer */}
          <aside className="min-h-0 border-r border-[var(--line)] bg-[#050b12]">
            <ExplorerTree
              project={project}
              activeQueryId={activeQueryId}
              selectedSourceId={selectedSourceId}
              expanded={treeExpanded}
              onToggle={(key) =>
                setTreeExpanded((e) => ({ ...e, [key]: !e[key] }))
              }
              onSelectQuery={selectQuery}
              onSelectSource={onSelectSource}
              onSelectConnection={(c) => {
                setEditingConnection(c);
                setConnEditorKind(c.kind);
                setConnEditorOpen(true);
              }}
              onExport={() => void handleExportDbt()}
              onRevealExport={() => void handleRevealExport()}
              exportFiles={exportFiles}
              onAddConnection={() => openNewConnection("postgres")}
              onAddSourceCsv={() => void addCsvQuery()}
              onAddSourceParquet={() => void addParquetQuery()}
              onAddSourceS3={() => setShowS3Dialog(true)}
              onAddSourcePostgres={() => setShowPgPicker(true)}
              onNewQueryFromSource={addQueryFromSource}
              onNewQuery={addQueryFromSelectedSourceOrCsv}
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
                positions={project.canvas?.positions}
                onPositionsChange={persistCanvasPositions}
                onSelect={selectQuery}
                onSetFocus={setFocusQueryId}
                onConnectJoin={connectJoinOnCanvas}
                onSelectEdge={selectEdgeOnCanvas}
                onRemoveEdge={removeEdgeOnCanvas}
                onRemoveQuery={removeQueryOnCanvas}
                onDeriveQuery={deriveQueryFrom}
              />
            </div>
            <div className="flex min-h-[28vh] flex-col border-t border-[var(--line)] bg-[#060d14]">
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
                          className={`border-b-2 px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] transition ${
                            on
                              ? "border-teal-400 text-teal-200"
                              : "border-transparent text-slate-500 hover:text-slate-300"
                          }`}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                  <span className="hidden pb-1.5 text-[10px] text-slate-600 sm:inline">
                    {activeQuery?.name ??
                      (focusQueryId
                        ? queries.find((q) => q.id === focusQueryId)?.name
                        : null) ??
                      "select a query"}
                  </span>
                </div>
                <span className="pb-1.5 text-xs text-slate-500">
                  {bottomTab === "data"
                    ? loading
                      ? "running…"
                      : preview
                        ? `${preview.rows.length} rows · ${preview.columns.length} cols`
                        : "—"
                    : modelPreview
                      ? `${modelPreview.model_name}.sql · dbt`
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
              <div className="min-h-0 flex-1 px-3 pb-3 pt-1">
                <div className="h-[22vh] overflow-hidden rounded-xl border border-[var(--line)] bg-slate-950/40">
                  {bottomTab === "data" ? (
                    preview ? (
                      <PreviewTable
                        columns={preview.columns}
                        rows={preview.rows}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-slate-600">
                        Waiting for preview…
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
              {selectedSource?.kind === "postgres" && (
                <SourceSchemaPanel
                  source={selectedSource}
                  columns={sourceColumns}
                  loading={sourceSchemaLoading}
                  error={sourceSchemaError}
                />
              )}
              <History
                steps={activeQuery?.steps ?? []}
                queryNames={Object.fromEntries(queries.map((q) => [q.id, q.name]))}
                onRemoveAt={removeStepAt}
              />
              <div className="mt-4 space-y-4">
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Steps are edited here for the selected query (right panel).
                  Enter / Apply adds them to Applied steps above.
                </p>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Filter
                  </label>
                  <input
                    type="text"
                    value={filterCondition}
                    onChange={(e) => setFilterCondition(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && applyFilter()}
                    disabled={!activeQuery}
                    placeholder="amount > 1000"
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  />
                  <button
                    type="button"
                    onClick={applyFilter}
                    disabled={!activeQuery}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    {filterCondition.trim() ? "Apply Filter" : "Clear Filter"}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Columns
                  </label>
                  {columnChoices.length === 0 ? (
                    <p className="mb-1 text-[11px] text-slate-600">
                      Run preview (set focus) to list columns, or type names
                      below.
                    </p>
                  ) : (
                    <ul className="mb-1 max-h-36 space-y-0.5 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1.5">
                      {columnChoices.map((name) => {
                        const checked = selectedColumns.includes(name);
                        return (
                          <li key={name}>
                            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-200 hover:bg-slate-900">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleColumn(name)}
                                disabled={!activeQuery}
                                className="rounded border-slate-600"
                              />
                              <span className="font-mono">{name}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <input
                    type="text"
                    value={selectedColumns.join(", ")}
                    onChange={(e) =>
                      setSelectedColumns(
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                    disabled={!activeQuery}
                    placeholder="or type: date, region, amount"
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  />
                  <button
                    type="button"
                    onClick={applySelectColumns}
                    disabled={!activeQuery}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    {selectedColumns.length > 0
                      ? activeSelect
                        ? "Update Columns"
                        : "Apply Columns"
                      : "Clear Columns"}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    GroupBy
                  </label>
                  {activeGroup && activeGroup.type === "GroupBy" && (
                    <p className="mb-2 rounded-md border border-teal-900/40 bg-teal-950/30 px-2 py-1.5 font-mono text-[11px] text-teal-200/90">
                      Applied: {activeGroup.payload.dimensions.join(", ")} ·{" "}
                      {activeGroup.payload.aggregates.join(", ")}
                    </p>
                  )}
                  <input
                    type="text"
                    value={groupDims}
                    onChange={(e) => setGroupDims(e.target.value)}
                    disabled={!activeQuery}
                    placeholder="dimensions: region, date"
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  />
                  <input
                    type="text"
                    value={groupAggs}
                    onChange={(e) => setGroupAggs(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && applyGroupBy()}
                    disabled={!activeQuery}
                    placeholder="aggregates: sum(qty) as qty"
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  />
                  <button
                    type="button"
                    onClick={() => applyGroupBy()}
                    disabled={!activeQuery}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    {groupDims.trim() && groupAggs.trim()
                      ? activeGroup
                        ? "Update GroupBy"
                        : "Apply GroupBy"
                      : "Clear GroupBy"}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Join
                  </label>
                  {activeJoin && activeJoin.type === "Join" && (
                    <p className="mb-2 rounded-md border border-teal-900/40 bg-teal-950/30 px-2 py-1.5 font-mono text-[11px] text-teal-200/90">
                      Applied: {activeJoin.payload.join_type} ⋈{" "}
                      {queries.find(
                        (q) => q.id === activeJoin.payload.right_query_id,
                      )?.name ?? activeJoin.payload.right_query_id}{" "}
                      ON {activeJoin.payload.left_on.join(", ")}
                    </p>
                  )}
                  <select
                    value={joinRightId}
                    onChange={(e) => setJoinRightId(e.target.value)}
                    disabled={!activeQuery || otherQueries.length === 0}
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  >
                    <option value="">right query…</option>
                    {otherQueries.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name}
                      </option>
                    ))}
                  </select>
                  {joinRightId && !otherQueries.some((q) => q.id === joinRightId) && (
                    <p className="mb-1 text-[11px] text-amber-400/90">
                      Right query “{joinRightName}” missing from workspace
                    </p>
                  )}
                  <div className="mb-1 flex gap-1">
                    <select
                      value={joinType}
                      onChange={(e) => setJoinType(e.target.value as JoinType)}
                      disabled={!activeQuery}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                    >
                      <option value="inner">inner</option>
                      <option value="left">left</option>
                      <option value="right">right</option>
                      <option value="full">full</option>
                    </select>
                    <input
                      value={joinKey}
                      onChange={(e) => setJoinKey(e.target.value)}
                      disabled={!activeQuery}
                      placeholder="join key"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={applyJoin}
                    disabled={!activeQuery || !joinRightId || !joinKey.trim()}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    {activeJoin ? "Update Join" : "Apply Join"}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Append
                  </label>
                  {activeAppend && activeAppend.type === "Append" && (
                    <p className="mb-2 rounded-md border border-teal-900/40 bg-teal-950/30 px-2 py-1.5 font-mono text-[11px] text-teal-200/90">
                      Applied: ∪{" "}
                      {activeAppend.payload.other_query_ids
                        .map(
                          (id) =>
                            queries.find((q) => q.id === id)?.name ?? id,
                        )
                        .join(", ")}
                    </p>
                  )}
                  <select
                    value={appendOtherId}
                    onChange={(e) => setAppendOtherId(e.target.value)}
                    disabled={!activeQuery || otherQueries.length === 0}
                    className="mb-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700 disabled:opacity-40"
                  >
                    <option value="">other query…</option>
                    {otherQueries.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={applyAppend}
                    disabled={!activeQuery || !appendOtherId}
                    className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                  >
                    {activeAppend ? "Update Append" : "Apply Append"}
                  </button>
                </div>
                <StepPalette
                  disabled={!activeQuery}
                  columnChoices={columnChoices}
                  onAddRename={(from, to) =>
                    appendStep({
                      type: "RenameColumn",
                      payload: { from, to },
                    })
                  }
                  onAddDerive={(name, expression) =>
                    appendStep({
                      type: "DeriveColumn",
                      payload: { name, expression },
                    })
                  }
                  onAddGroupBy={(dimensions, aggregates) =>
                    applyGroupBy(dimensions.join(", "), aggregates.join(", "))
                  }
                  onAddSort={(column, descending) =>
                    appendStep({
                      type: "SortBy",
                      payload: { column, descending },
                    })
                  }
                  onAddLimit={(n) =>
                    appendStep({
                      type: "Limit",
                      payload: { n },
                    })
                  }
                  onAddCustomSql={(raw_sql) =>
                    appendStep({
                      type: "CustomSql",
                      payload: { raw_sql },
                    })
                  }
                />
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
