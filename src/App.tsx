import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function clampPanelWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}
import {
  openDialog as open,
  revealItemInDir,
  saveDialog as save,
} from "./lib/bridge";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { AppMenu } from "./components/AppMenu";
import { EmptyHero, type DemoId } from "./components/EmptyHero";
import { HelpDialog } from "./components/HelpDialog";
import { ExplorerTree } from "./components/ExplorerTree";
import {
  JoinDiagnosticsPanel,
  type JoinDiagKind,
} from "./components/JoinDiagnosticsPanel";
import { JoinLens } from "./components/JoinLens";
import { JoinKeyEditor } from "./components/JoinKeyEditor";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import {
  emptyJoinKeyPair,
  joinPairsComplete,
  pairsFromOn,
  pairsToOn,
  suggestJoinPairs,
  type JoinKeyPair,
} from "./lib/joinKeys";
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
import { debounce } from "./lib/debounce";
import {
  describePostgresObject,
  exportDbt,
  joinDiagnostics,
  listExportTree,
  getAppSettings,
  getLastProjectPath,
  loadProject,
  loadDemoWorkspace,
  previewDbtModel,
  previewWorkspace,
  saveProject,
  setAppSettings,
  type AppSettings,
  type JoinDiagSample,
  type JoinDiagnostics,
  type PreviewDbtModel,
  type PostgresColumn,
} from "./lib/bridge";
import {
  connectionById,
  emptyProject,
  newQueryId,
  newSourceId,
  projectDialect,
  queryExecution,
  syncSourcesFromQueries,
  type ConnectionDef,
  type ConnectionKind,
  type JoinType,
  type ColumnMetadata,
  type PreviewResult,
  type Project,
  type QueryDef,
  type QueryExecution,
  type SourceDef,
  type TransformationStep,
  type WarehouseDialect,
  type Workspace,
} from "./types/pipeline";

function App() {
  const [project, setProject] = useState<Project>(() => emptyProject("Untitled"));
  const [appSettings, setAppSettingsState] = useState<AppSettings>({
    default_target_dialect: "duckdb",
    default_dbt_target: "v1",
    explorer_width_px: 240,
    inspector_width_px: 300,
  });
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [inspectorWidth, setInspectorWidth] = useState(300);
  const explorerWidthRef = useRef(explorerWidth);
  const inspectorWidthRef = useRef(inspectorWidth);
  explorerWidthRef.current = explorerWidth;
  inspectorWidthRef.current = inspectorWidth;
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(
    null,
  );
  const [filterCondition, setFilterCondition] = useState("");
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [groupDims, setGroupDims] = useState("");
  const [groupAggs, setGroupAggs] = useState("count(*) as n");
  const [joinRightId, setJoinRightId] = useState("");
  /** Join key pairs (IR `left_on` / `right_on`). */
  const [joinKeyPairs, setJoinKeyPairs] = useState<JoinKeyPair[]>([
    emptyJoinKeyPair(),
  ]);
  const [joinType, setJoinType] = useState<JoinType>("inner");
  const [joinLeftColumns, setJoinLeftColumns] = useState<ColumnMetadata[]>([]);
  const [joinRightColumns, setJoinRightColumns] = useState<ColumnMetadata[]>(
    [],
  );
  const [joinColsLoading, setJoinColsLoading] = useState(false);
  const [joinDiag, setJoinDiag] = useState<JoinDiagnostics | null>(null);
  const [joinDiagLoading, setJoinDiagLoading] = useState(false);
  const [joinDiagError, setJoinDiagError] = useState<string | null>(null);
  /** Overrides Data tab when user opens a Join diagnostic sample. */
  const [diagView, setDiagView] = useState<{
    label: string;
    columns: ColumnMetadata[];
    rows: unknown[][];
    totalCount: number;
    sampleLimit: number;
    highlightKeys: string[];
  } | null>(null);
  /** Join Lens mode on Data (where-provenance docks). Default on when Join selected. */
  const [joinLensOn, setJoinLensOn] = useState(true);
  /** FromQuery parent id (child / derived query root). */
  const [fromQueryId, setFromQueryId] = useState("");
  const [appendOtherId, setAppendOtherId] = useState("");
  const [sortCol, setSortCol] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [limitN, setLimitN] = useState("10");
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [deriveName, setDeriveName] = useState("");
  const [deriveExpr, setDeriveExpr] = useState("");
  const [customSql, setCustomSql] = useState("select * from {{prev_step}}");
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
  /** Dialog outcome: catalog-only source vs source+query. */
  const [pickerIntent, setPickerIntent] = useState<"source" | "query">("query");
  const [connEditorOpen, setConnEditorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
      // v1: always structural DuckDB preview (ADR-0014). Native "Run on warehouse" = later.
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

  // Schema-aware Join: column lists from truncated preview (left before Join, full right).
  useEffect(() => {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (step?.type !== "Join") {
      return;
    }
    const hostId = activeQueryId;
    const rightId = joinRightId || step.payload.right_query_id;
    if (!hostId || !rightId) {
      setJoinLeftColumns([]);
      setJoinRightColumns([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setJoinColsLoading(true);
      void fetchJoinSideColumns(hostId, rightId, selectedStepIndex)
        .then((cols) => {
          if (cancelled) return;
          setJoinLeftColumns(cols.left);
          setJoinRightColumns(cols.right);
        })
        .finally(() => {
          if (!cancelled) setJoinColsLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchJoinSideColumns closes over workspace
  }, [
    activeQueryId,
    selectedStepIndex,
    joinRightId,
    activeQuery,
    project.workspace,
    connections,
  ]);

  // Join diagnostics (DESIGN §9) — async, never blocks Apply / canvas.
  useEffect(() => {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (!activeQueryId || selectedStepIndex === null || step?.type !== "Join") {
      setJoinDiag(null);
      setJoinDiagError(null);
      setJoinDiagLoading(false);
      setDiagView(null);
      return;
    }
    let cancelled = false;
    setJoinDiagLoading(true);
    setJoinDiagError(null);
    void joinDiagnostics(
      project.workspace,
      activeQueryId,
      selectedStepIndex,
      connections,
    )
      .then((d) => {
        if (!cancelled) {
          setJoinDiag(d);
          setJoinDiagLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setJoinDiag(null);
          setJoinDiagLoading(false);
          setJoinDiagError(typeof e === "string" ? e : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeQueryId,
    selectedStepIndex,
    activeQuery,
    project.workspace,
    connections,
  ]);

  // Model tab: dbt SQL for the selected query (instant, no DuckDB).
  useEffect(() => {
    const id = activeQueryId || focusQueryId;
    if (!id || queries.length === 0) {
      setModelPreview(null);
      setModelError(null);
      return;
    }
    let cancelled = false;
    void previewDbtModel(
      project.workspace,
      id,
      projectDialect(project),
      connections,
    )
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
  }, [
    project.workspace,
    project.target_dialect,
    activeQueryId,
    focusQueryId,
    queries.length,
    connections,
  ]);

  const syncInspectorFromQuery = useCallback(
    (q: QueryDef | undefined) => {
      if (!q) {
        setFilterCondition("");
        setSelectedColumns([]);
        setGroupDims("");
        setGroupAggs("count(*) as n");
        setJoinRightId("");
        setJoinKeyPairs([emptyJoinKeyPair()]);
        setJoinType("inner");
        setFromQueryId("");
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
        setJoinKeyPairs(
          pairsFromOn(j.payload.left_on, j.payload.right_on),
        );
        setJoinType(j.payload.join_type);
      } else {
        setJoinRightId("");
        setJoinKeyPairs([emptyJoinKeyPair()]);
        setJoinType("inner");
      }
      const fq = q.steps.find((s) => s.type === "FromQuery");
      setFromQueryId(
        fq && fq.type === "FromQuery" ? fq.payload.query_id : "",
      );
      const a = q.steps.find((s) => s.type === "Append");
      if (a && a.type === "Append") {
        setAppendOtherId(a.payload.other_query_ids[0] ?? "");
      } else {
        setAppendOtherId("");
      }
    },
    [],
  );

  const loadStepIntoEditor = useCallback((step: TransformationStep | undefined) => {
    if (!step) return;
    switch (step.type) {
      case "Filter":
        setFilterCondition(step.payload.condition);
        break;
      case "SelectColumns":
        setSelectedColumns([...step.payload.columns]);
        break;
      case "GroupBy":
        setGroupDims(step.payload.dimensions.join(", "));
        setGroupAggs(step.payload.aggregates.join(", "));
        break;
      case "Join":
        setJoinRightId(step.payload.right_query_id);
        setJoinKeyPairs(
          pairsFromOn(step.payload.left_on, step.payload.right_on),
        );
        setJoinType(step.payload.join_type);
        break;
      case "FromQuery":
        setFromQueryId(step.payload.query_id);
        break;
      case "Append":
        setAppendOtherId(step.payload.other_query_ids[0] ?? "");
        break;
      case "SortBy":
        setSortCol(step.payload.column);
        setSortDesc(step.payload.descending);
        break;
      case "Limit":
        setLimitN(String(step.payload.n));
        break;
      case "RenameColumn":
        setRenameFrom(step.payload.from);
        setRenameTo(step.payload.to);
        break;
      case "DeriveColumn":
        setDeriveName(step.payload.name);
        setDeriveExpr(step.payload.expression);
        break;
      case "SqlModel":
      case "CustomSql":
        setCustomSql(step.payload.raw_sql);
        break;
      default:
        break;
    }
  }, []);

  const selectQuery = useCallback(
    (id: string) => {
      setActiveQueryId(id);
      const q = queries.find((x) => x.id === id);
      syncInspectorFromQuery(q);
      const last = q && q.steps.length > 0 ? q.steps.length - 1 : null;
      setSelectedStepIndex(last);
      if (last !== null && q) loadStepIntoEditor(q.steps[last]);
    },
    [queries, syncInspectorFromQuery, loadStepIntoEditor],
  );

  // Keep forms in sync when steps change; clamp selected step index.
  useEffect(() => {
    if (!activeQueryId) {
      setSelectedStepIndex(null);
      return;
    }
    const q = queries.find((x) => x.id === activeQueryId);
    syncInspectorFromQuery(q);
    if (!q || q.steps.length === 0) {
      setSelectedStepIndex(null);
      return;
    }
    setSelectedStepIndex((prev) => {
      const next =
        prev === null || prev >= q.steps.length ? q.steps.length - 1 : prev;
      loadStepIntoEditor(q.steps[next]);
      return next;
    });
  }, [activeQueryId, queries, syncInspectorFromQuery, loadStepIntoEditor]);

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
    const base = path.split(/[/\\]/).pop() ?? "file";
    const name =
      kind === "csv"
        ? base.replace(/\.csv$/i, "")
        : base.replace(/\.parquet$/i, "");
    const id = newQueryId(name, queries.map((q) => q.id));
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
    const id = newQueryId(finalName, queries.map((q) => q.id));
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

  /** New query whose root is hand-written SQL (ready-made model). */
  function addSqlModelQuery() {
    const used = new Set(queries.map((q) => q.name));
    let name = "sql_model";
    if (used.has(name)) {
      let i = 2;
      while (used.has(`sql_model_${i}`)) i += 1;
      name = `sql_model_${i}`;
    }
    const id = newQueryId(name, queries.map((q) => q.id));
    const q: QueryDef = {
      id,
      name,
      steps: [
        {
          type: "SqlModel",
          payload: {
            raw_sql: "select 1 as n",
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
    setSelectedStepIndex(0);
    setCustomSql("select 1 as n");
    setFilterCondition("");
    setError(null);
  }

  async function addParquetQuery() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });
    if (typeof selected !== "string") return;
    addFileQuery(selected, "parquet");
  }

  /** Sources catalog only — no query until user asks. */
  async function addSourceOnlyCsv() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected !== "string") return;
    const name = selected.split(/[/\\]/).pop() ?? "csv";
    const id = newSourceId(
      name,
      project.sources.map((s) => s.id),
    );
    setProject((p) => ({
      ...p,
      sources: [
        ...p.sources,
        { id, name, kind: "csv", path: selected },
      ],
    }));
    setSelectedSourceId(id);
    setError(null);
  }

  async function addSourceOnlyParquet() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });
    if (typeof selected !== "string") return;
    const name = selected.split(/[/\\]/).pop() ?? "parquet";
    const id = newSourceId(
      name,
      project.sources.map((s) => s.id),
    );
    setProject((p) => ({
      ...p,
      sources: [
        ...p.sources,
        { id, name, kind: "parquet", path: selected },
      ],
    }));
    setSelectedSourceId(id);
    setError(null);
  }

  function addSourceOnlyPostgres(sel: PostgresSelection) {
    const name = `${sel.schema}.${sel.table_name}`;
    const id = newSourceId(
      name,
      project.sources.map((s) => s.id),
    );
    setProject((p) => ({
      ...p,
      sources: [
        ...p.sources,
        {
          id,
          name,
          kind: "postgres",
          connection_id: sel.connection_id,
          schema: sel.schema,
          table_name: sel.table_name,
        },
      ],
    }));
    setSelectedSourceId(id);
    setShowPgPicker(false);
    setError(null);
  }

  function addSourceOnlyS3(sel: { path: string; connection_id?: string }) {
    const name = sel.path.split(/[/\\]/).pop() ?? "parquet";
    const id = newSourceId(
      name,
      project.sources.map((s) => s.id),
    );
    setProject((p) => ({
      ...p,
      sources: [
        ...p.sources,
        {
          id,
          name,
          kind: "parquet",
          path: sel.path,
          connection_id: sel.connection_id,
        },
      ],
    }));
    setSelectedSourceId(id);
    setShowS3Dialog(false);
    setError(null);
  }

  function renameQuery(queryId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProject((p) => ({
      ...p,
      workspace: {
        ...p.workspace,
        queries: p.workspace.queries.map((q) =>
          q.id === queryId ? { ...q, name: trimmed } : q,
        ),
      },
    }));
  }

  function renameSource(sourceId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProject((p) => ({
      ...p,
      sources: p.sources.map((s) =>
        s.id === sourceId ? { ...s, name: trimmed } : s,
      ),
    }));
  }

  function openPgPicker(intent: "source" | "query") {
    setPickerIntent(intent);
    setShowPgPicker(true);
  }

  function openS3Dialog(intent: "source" | "query") {
    setPickerIntent(intent);
    setShowS3Dialog(true);
  }

  function addPostgresFromPicker(sel: PostgresSelection) {
    const name = `${sel.schema}.${sel.table_name}`;
    const id = newQueryId(name, queries.map((q) => q.id));
    const q: QueryDef = {
      id,
      name,
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

  async function persistAppSettings(next: AppSettings) {
    setAppSettingsState(next);
    try {
      await setAppSettings(next);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  function persistPanelWidths(nextExplorer: number, nextInspector: number) {
    void persistAppSettings({
      ...appSettings,
      explorer_width_px: Math.round(nextExplorer),
      inspector_width_px: Math.round(nextInspector),
    });
  }

  async function handleSetTargetDialect(d: WarehouseDialect) {
    setProject((p) => ({ ...p, target_dialect: d }));
    await persistAppSettings({
      ...appSettings,
      default_target_dialect: d,
    });
  }

  async function handleLoadDemo(id: DemoId) {
    try {
      const ws = await loadDemoWorkspace(id);
      const projectName =
        id === "sales"
          ? "demo_sales"
          : id === "union"
            ? "demo_union"
            : "demo_sql";
      setProject((p) => ({
        ...p,
        name: projectName,
        sources: syncSourcesFromQueries([], ws.queries),
        workspace: ws,
        canvas: { positions: {} },
        dbt_target: appSettings.default_dbt_target,
        target_dialect: appSettings.default_target_dialect,
      }));
      setActiveQueryId(ws.focus_query_id);
      setSelectedStepIndex(
        ws.queries.find((q) => q.id === ws.focus_query_id)?.steps.length
          ? (ws.queries.find((q) => q.id === ws.focus_query_id)!.steps.length -
              1)
          : null,
      );
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

  function toggleColumn(name: string) {
    setSelectedColumns((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name],
    );
  }

  function applyJoinTo(
    hostQueryId: string,
    rightQueryId: string,
    pairs: JoinKeyPair[],
    type: JoinType = joinType,
  ) {
    const { left_on, right_on } = pairsToOn(pairs);
    // Allow empty keys so canvas can open the Join for picking (never invent "id").
    if (!rightQueryId) return;
    if (rightQueryId === hostQueryId) {
      setError("Cannot join a query to itself");
      return;
    }
    let joinIndex = -1;
    let joinStep: TransformationStep | null = null;
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== hostQueryId) return q;
        const without = q.steps.filter((s) => s.type !== "Join");
        const step: TransformationStep = {
          type: "Join",
          payload: {
            right_query_id: rightQueryId,
            join_type: type,
            left_on,
            right_on,
          },
        };
        const steps = [...without, step];
        joinIndex = steps.length - 1;
        joinStep = step;
        return { ...q, steps };
      }),
    );
    setJoinRightId(rightQueryId);
    setJoinKeyPairs(
      left_on.length > 0
        ? pairsFromOn(left_on, right_on)
        : [emptyJoinKeyPair()],
    );
    setJoinType(type);
    setActiveQueryId(hostQueryId);
    const idx = joinIndex;
    const step = joinStep;
    queueMicrotask(() => {
      if (idx >= 0 && step) {
        setSelectedStepIndex(idx);
        loadStepIntoEditor(step);
      }
    });
    setError(null);
  }

  async function openJoinDiagnostic(
    kind: JoinDiagKind,
    sample: JoinDiagSample | null,
    label: string,
  ) {
    if (!joinDiag || !activeQueryId) return;
    const keys = [...joinDiag.left_on, ...joinDiag.right_on];
    const sampleLimit = joinDiag.sample_limit;

    if (sample) {
      setDiagView({
        label,
        columns: sample.columns,
        rows: sample.rows,
        totalCount: sample.total_count,
        sampleLimit,
        highlightKeys: keys,
      });
      setBottomTab("data");
      return;
    }

    // left / right / output — preview truncated workspace (LIMIT 50 via preview).
    try {
      let ws: Workspace;
      if (kind === "left") {
        ws = {
          ...project.workspace,
          focus_query_id: activeQueryId,
          queries: project.workspace.queries.map((q) =>
            q.id === activeQueryId
              ? {
                  ...q,
                  steps: q.steps.slice(0, joinDiag.join_step_index),
                }
              : q,
          ),
        };
      } else if (kind === "right") {
        ws = {
          ...project.workspace,
          focus_query_id: joinDiag.right_query_id,
        };
      } else {
        // output = host through Join inclusive
        ws = {
          ...project.workspace,
          focus_query_id: activeQueryId,
          queries: project.workspace.queries.map((q) =>
            q.id === activeQueryId
              ? {
                  ...q,
                  steps: q.steps.slice(0, joinDiag.join_step_index + 1),
                }
              : q,
          ),
        };
      }
      const result = await previewWorkspace(ws, connections);
      const total =
        kind === "left"
          ? joinDiag.left_count
          : kind === "right"
            ? joinDiag.right_count
            : joinDiag.output_count;
      setDiagView({
        label,
        columns: result.columns,
        rows: result.rows,
        totalCount: total,
        sampleLimit,
        highlightKeys: keys,
      });
      setBottomTab("data");
    } catch (e) {
      setJoinDiagError(typeof e === "string" ? e : String(e));
    }
  }

  async function fetchJoinSideColumns(
    hostQueryId: string,
    rightQueryId: string,
    joinStepIndex: number | null,
  ): Promise<{ left: ColumnMetadata[]; right: ColumnMetadata[] }> {
    const host = queries.find((q) => q.id === hostQueryId);
    const upto =
      joinStepIndex != null && joinStepIndex >= 0
        ? joinStepIndex
        : (host?.steps.findIndex((s) => s.type === "Join") ??
          host?.steps.length ??
          0);
    const leftUpto = Math.max(0, upto);

    const leftWs: Workspace = {
      ...project.workspace,
      focus_query_id: hostQueryId,
      queries: project.workspace.queries.map((q) =>
        q.id === hostQueryId
          ? { ...q, steps: q.steps.slice(0, leftUpto) }
          : q,
      ),
    };
    const rightWs: Workspace = {
      ...project.workspace,
      focus_query_id: rightQueryId,
    };

    const [leftRes, rightRes] = await Promise.all([
      hostQueryId
        ? previewWorkspace(leftWs, connections).catch(() => null)
        : Promise.resolve(null),
      rightQueryId
        ? previewWorkspace(rightWs, connections).catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      left: leftRes?.columns ?? [],
      right: rightRes?.columns ?? [],
    };
  }

  async function connectJoinOnCanvas(
    rightQueryId: string,
    hostQueryId: string,
  ) {
    // Prefer complete pairs already in the inspector; else schema-suggest; never fake "id".
    let pairs = joinKeyPairs;
    if (!joinPairsComplete(pairs)) {
      try {
        const host = queries.find((q) => q.id === hostQueryId);
        const upto = host?.steps.length ?? 0;
        const cols = await fetchJoinSideColumns(
          hostQueryId,
          rightQueryId,
          upto,
        );
        setJoinLeftColumns(cols.left);
        setJoinRightColumns(cols.right);
        pairs = suggestJoinPairs(cols.left, cols.right);
      } catch {
        pairs = [emptyJoinKeyPair()];
      }
    }
    applyJoinTo(hostQueryId, rightQueryId, pairs, joinType);
  }

  function selectEdgeOnCanvas(edge: GraphEdgeInfo) {
    const host = queries.find((q) => q.id === edge.hostQueryId);
    setActiveQueryId(edge.hostQueryId);
    if (edge.kind === "join") {
      setJoinRightId(edge.otherQueryId);
      const idx = host?.steps.findIndex((s) => s.type === "Join") ?? -1;
      const j = idx >= 0 ? host?.steps[idx] : undefined;
      if (j && j.type === "Join") {
        setJoinKeyPairs(
          pairsFromOn(j.payload.left_on, j.payload.right_on),
        );
        setJoinType(j.payload.join_type);
        setSelectedStepIndex(idx);
        loadStepIntoEditor(j);
      }
    } else if (edge.kind === "append") {
      setAppendOtherId(edge.otherQueryId);
      const idx = host?.steps.findIndex((s) => s.type === "Append") ?? -1;
      if (idx >= 0 && host) {
        setSelectedStepIndex(idx);
        loadStepIntoEditor(host.steps[idx]);
      }
    } else if (edge.kind === "from") {
      const idx =
        host?.steps.findIndex(
          (s) =>
            s.type === "FromQuery" && s.payload.query_id === edge.otherQueryId,
        ) ?? -1;
      if (idx >= 0 && host) {
        setSelectedStepIndex(idx);
        loadStepIntoEditor(host.steps[idx]);
      }
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
    const used = new Set(queries.map((q) => q.name));
    let name = `${src.name}_derived`;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${src.name}_${i}`)) i += 1;
      name = `${src.name}_${i}`;
    }
    const id = newQueryId(name, queries.map((q) => q.id));
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
    setSelectedStepIndex(0);
    loadStepIntoEditor({
      type: "FromQuery",
      payload: { query_id: fromQueryId },
    });
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

  function removeStepAt(index: number) {
    updateActiveSteps((steps) => steps.filter((_, i) => i !== index));
    setSelectedStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === index) return Math.max(0, index - 1);
      if (prev > index) return prev - 1;
      return prev;
    });
  }

  function moveStepAt(index: number, dir: -1 | 1) {
    const j = index + dir;
    updateActiveSteps((steps) => {
      if (j < 0 || j >= steps.length) return steps;
      const root = (s: TransformationStep) =>
        s.type === "LoadCsv" ||
        s.type === "LoadParquet" ||
        s.type === "LoadPostgres" ||
        s.type === "FromQuery" ||
        s.type === "SqlModel";
      if (index === 0 && root(steps[0]!)) return steps;
      if (j === 0 && root(steps[0]!) && index === 1) return steps;
      const next = [...steps];
      const a = next[index]!;
      const b = next[j]!;
      next[index] = b;
      next[j] = a;
      return next;
    });
    setSelectedStepIndex(j);
  }

  function replaceStepAt(index: number, step: TransformationStep) {
    updateActiveSteps((steps) =>
      steps.map((s, i) => (i === index ? step : s)),
    );
  }

  function appendStep(step: TransformationStep) {
    updateActiveSteps((steps) => {
      const next = [...steps, step];
      setSelectedStepIndex(next.length - 1);
      loadStepIntoEditor(step);
      return next;
    });
  }

  function selectStepAt(index: number) {
    setSelectedStepIndex(index);
    const step = activeQuery?.steps[index];
    loadStepIntoEditor(step);
  }

  async function writeProjectTo(path: string) {
    try {
      const base =
        path
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.dwhproj\.json$/i, "")
          .replace(/\.json$/i, "") ?? project.name;
      await saveProject(path, { ...project, root_path: path, name: base });
      setProject((p) => ({ ...p, root_path: path, name: base }));
      setExportMsg(`Project saved → ${path}`);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
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
    await writeProjectTo(path);
  }

  async function handleSaveProjectAs() {
    const picked =
      (await save({
        defaultPath:
          project.root_path?.split(/[/\\]/).pop() ??
          `${project.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`,
        filters: [{ name: "DWH Project", extensions: ["json"] }],
      })) ?? null;
    if (typeof picked !== "string") return;
    await writeProjectTo(picked);
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

  // Load app settings, then restore last project (or seed Untitled from settings).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let settings: AppSettings = {
        default_target_dialect: "duckdb",
        default_dbt_target: "v1",
        explorer_width_px: 240,
        inspector_width_px: 300,
      };
      try {
        settings = await getAppSettings();
        if (!cancelled) {
          setAppSettingsState(settings);
          setExplorerWidth(
            clampPanelWidth(settings.explorer_width_px ?? 240, 160, 480),
          );
          setInspectorWidth(
            clampPanelWidth(settings.inspector_width_px ?? 300, 220, 560),
          );
        }
      } catch {
        // Missing settings — keep in-memory defaults.
      }
      try {
        const path = await getLastProjectPath();
        if (cancelled) return;
        if (path) {
          const loaded = await loadProject(path);
          if (cancelled) return;
          applyLoadedProject(loaded, path);
          setExportMsg(`Restored ${path}`);
          return;
        }
      } catch {
        // Missing/corrupt session — fall through to Untitled.
      }
      if (!cancelled) {
        setProject(emptyProject("Untitled", settings));
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
      const dialect = projectDialect(project);
      const result = await exportDbt(
        project.name.replace(/\s+/g, "_").toLowerCase() || "dwh_rs_query",
        workspace,
        dir,
        project.dbt_target,
        dialect,
        connections,
      );
      setProject((p) => ({ ...p, last_dbt_export_path: result.path }));
      setExportFiles(result.files);
      setTreeExpanded((e) => ({ ...e, export: true }));
      const nFiles = result.files.filter((f) => !f.endsWith("/")).length;
      const base = `dbt ${project.dbt_target} · ${dialect} → ${result.path} (${nFiles} files)`;
      if (result.dbt_parse_ok) {
        setExportMsg(`${base} · dbt parse OK`);
        setError(null);
      } else {
        setExportMsg(`${base} · dbt parse failed (files written)`);
        setError(
          result.dbt_parse_log?.trim()
            ? result.dbt_parse_log
            : "dbt parse failed (install ./scripts/fetch-dbt-venv.sh or put dbt on PATH)",
        );
      }
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
      if (k === "o" && !(e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void addCsvQuery();
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
  const selectedStep =
    activeQuery &&
    selectedStepIndex !== null &&
    activeQuery.steps[selectedStepIndex]
      ? activeQuery.steps[selectedStepIndex]
      : null;

  const joinLensTarget =
    activeQueryId &&
    selectedStepIndex !== null &&
    selectedStep?.type === "Join" &&
    selectedStep.payload.left_on.length > 0
      ? {
          hostQueryId: activeQueryId,
          joinStepIndex: selectedStepIndex,
          leftOn: selectedStep.payload.left_on,
          rightOn: selectedStep.payload.right_on,
        }
      : null;

  /** Columns to pick from — prefer live preview of the active/focus query. */
  const columnChoices = useMemo(() => {
    const fromPreview =
      preview && preview.columns.length > 0
        ? preview.columns.map((c) => c.name)
        : [];
    const fromStep =
      selectedStep?.type === "SelectColumns"
        ? selectedStep.payload.columns
        : [];
    return [...new Set([...fromPreview, ...fromStep, ...selectedColumns])];
  }, [preview, selectedStep, selectedColumns]);

  function addAvailableStep(kind: string) {
    if (!activeQuery) return;
    const peer = otherQueries[0]?.id ?? "";
    switch (kind) {
      case "Filter":
        appendStep({ type: "Filter", payload: { condition: "" } });
        break;
      case "SelectColumns":
        appendStep({
          type: "SelectColumns",
          payload: { columns: columnChoices.slice(0, 5) },
        });
        break;
      case "GroupBy":
        appendStep({
          type: "GroupBy",
          payload: {
            dimensions: columnChoices[0] ? [columnChoices[0]] : ["region"],
            aggregates: ["count(*) as n"],
          },
        });
        break;
      case "Join":
        if (!peer) {
          setError("Need another query to Join");
          return;
        }
        {
          const { left_on, right_on } = joinPairsComplete(joinKeyPairs)
            ? pairsToOn(joinKeyPairs)
            : { left_on: [] as string[], right_on: [] as string[] };
          appendStep({
            type: "Join",
            payload: {
              right_query_id: peer,
              join_type: "inner",
              left_on,
              right_on,
            },
          });
          setJoinRightId(peer);
          if (left_on.length === 0) {
            setJoinKeyPairs([emptyJoinKeyPair()]);
          }
        }
        break;
      case "Append":
        if (!peer) {
          setError("Need another query to Append");
          return;
        }
        appendStep({
          type: "Append",
          payload: { other_query_ids: [peer] },
        });
        break;
      case "SortBy":
        appendStep({
          type: "SortBy",
          payload: {
            column: columnChoices[0] ?? "qty",
            descending: true,
          },
        });
        break;
      case "Limit":
        appendStep({ type: "Limit", payload: { n: 10 } });
        break;
      case "RenameColumn":
        appendStep({
          type: "RenameColumn",
          payload: {
            from: columnChoices[0] ?? "col",
            to: "renamed",
          },
        });
        break;
      case "DeriveColumn":
        appendStep({
          type: "DeriveColumn",
          payload: { name: "derived", expression: "1" },
        });
        break;
      case "FromQuery":
        if (!peer) {
          setError("Need another query for FromQuery");
          return;
        }
        // FromQuery must be first — only if query empty or replace? append only if empty root
        if (activeQuery.steps.length > 0) {
          setError("FromQuery only as first step — use ↳ on a canvas node");
          return;
        }
        appendStep({
          type: "FromQuery",
          payload: { query_id: peer },
        });
        break;
      case "SqlModel":
        if (activeQuery.steps.length > 0) {
          setError("SQL model only as first step — use + SQL model for a new query");
          return;
        }
        appendStep({
          type: "SqlModel",
          payload: { raw_sql: "select 1 as n" },
        });
        break;
      case "CustomSql":
        if (activeQuery.steps.length === 0) {
          setError("Custom SQL needs a prior step — or use + SQL model as root");
          return;
        }
        appendStep({
          type: "CustomSql",
          payload: { raw_sql: "select * from {{prev_step}}" },
        });
        break;
      default:
        break;
    }
  }

  const availableSteps: { id: string; label: string }[] = [
    { id: "Filter", label: "Filter" },
    { id: "SelectColumns", label: "Columns" },
    { id: "GroupBy", label: "GroupBy" },
    { id: "Join", label: "Join" },
    { id: "Append", label: "Append" },
    { id: "SortBy", label: "Sort" },
    { id: "Limit", label: "Limit" },
    { id: "RenameColumn", label: "Rename" },
    { id: "DeriveColumn", label: "Derived/Calculated" },
    { id: "CustomSql", label: "Custom SQL" },
  ];

  function stepEditorTitle(step: TransformationStep): string {
    switch (step.type) {
      case "SqlModel":
        return "SQL model";
      case "CustomSql":
        return "Custom SQL";
      case "DeriveColumn":
        return "Derived/Calculated";
      default:
        return step.type;
    }
  }

  const canCopySql =
    bottomTab === "model" ? Boolean(modelPreview?.sql) : Boolean(preview?.sql);

  return (
    <div className="flex h-screen flex-col text-slate-100">
      <AppMenu
        projectName={project.name}
        projectPath={project.root_path}
        targetDialect={projectDialect(project)}
        canExport={Boolean(workspace)}
        canCopySql={canCopySql}
        sqlCopied={sqlCopied}
        onOpen={() => void handleOpenProject()}
        onSave={() => void handleSaveProject()}
        onSaveAs={() => void handleSaveProjectAs()}
        onExport={() => void handleExportDbt()}
        onViewData={() => setBottomTab("data")}
        onViewModel={() => setBottomTab("model")}
        onCopySql={() => void copySql()}
        onNewConnection={() => openNewConnection("postgres")}
        onSetTargetDialect={(d: WarehouseDialect) =>
          void handleSetTargetDialect(d)
        }
        onLoadDemo={(id) => void handleLoadDemo(id)}
        onOpenHelp={() => setHelpOpen(true)}
      />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <ConnectionEditor
        open={connEditorOpen}
        initial={editingConnection}
        defaultKind={connEditorKind}
        existingIds={project.connections.map((c) => c.id)}
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
        onSelect={(sel) => {
          if (pickerIntent === "source") addSourceOnlyPostgres(sel);
          else addPostgresFromPicker(sel);
        }}
      />
      <S3SourceDialog
        open={showS3Dialog}
        connections={project.connections}
        onClose={() => setShowS3Dialog(false)}
        onRequestNewConnection={() => openNewConnection("s3")}
        onSelect={(sel) => {
          if (pickerIntent === "source") {
            addSourceOnlyS3(sel);
          } else {
            addFileQuery(sel.path, "parquet", sel.connection_id);
            setShowS3Dialog(false);
          }
        }}
      />

      {empty ? (
        <EmptyHero
          onLoadDemo={(id) => void handleLoadDemo(id)}
          onAddCsv={() => void addCsvQuery()}
          onAddParquet={() => void addParquetQuery()}
          onAddPostgres={() => openPgPicker("query")}
          onAddSqlModel={() => addSqlModelQuery()}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Explorer */}
          <aside
            className="min-h-0 shrink-0 overflow-hidden bg-[#050b12]"
            style={{ width: explorerWidth }}
          >
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
              onAddSourceCsv={() => void addSourceOnlyCsv()}
              onAddSourceParquet={() => void addSourceOnlyParquet()}
              onAddSourceS3={() => openS3Dialog("source")}
              onAddSourcePostgres={() => openPgPicker("source")}
              onNewQueryCsv={() => void addCsvQuery()}
              onNewQueryParquet={() => void addParquetQuery()}
              onNewQueryS3={() => openS3Dialog("query")}
              onNewQueryPostgres={() => openPgPicker("query")}
              onNewQueryFromSource={addQueryFromSource}
              onNewSqlModel={addSqlModelQuery}
              onRenameQuery={renameQuery}
              onRenameSource={renameSource}
            />
          </aside>
          <PanelResizeHandle
            aria-label="Resize explorer"
            onDelta={(dx) =>
              setExplorerWidth((w) => {
                const next = clampPanelWidth(w + dx, 160, 480);
                explorerWidthRef.current = next;
                return next;
              })
            }
            onDragEnd={() =>
              persistPanelWidths(
                explorerWidthRef.current,
                inspectorWidthRef.current,
              )
            }
          />

          {/* Canvas */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 px-4 py-2">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Pipeline canvas
              </h2>
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
            <div
              className={`flex flex-col border-t border-[var(--line)] bg-[#060d14] ${
                joinLensOn && joinLensTarget && !diagView
                  ? "min-h-[34vh]"
                  : "min-h-[28vh]"
              }`}
            >
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
                <div className="flex items-center gap-2 pb-1.5">
                  {joinLensTarget && bottomTab === "data" && !diagView && (
                    <button
                      type="button"
                      onClick={() => setJoinLensOn((v) => !v)}
                      className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        joinLensOn
                          ? "border-teal-500/50 bg-teal-500/15 text-teal-200"
                          : "border-slate-700 text-slate-500 hover:text-slate-300"
                      }`}
                      title="Show left/right source rows linked to the focused result row"
                    >
                      Join Lens
                    </button>
                  )}
                  <span className="text-xs text-slate-500">
                    {bottomTab === "data"
                      ? diagView
                        ? `diag · ${diagView.rows.length}/${diagView.totalCount} · ${diagView.columns.length} cols`
                        : loading
                          ? "running…"
                          : preview
                            ? `${preview.rows.length} rows · ${preview.columns.length} cols`
                            : "—"
                      : modelPreview
                        ? `${modelPreview.model_name}.sql · dbt`
                        : "—"}
                  </span>
                </div>
              </div>
              {(error || exportMsg || diagView) && (
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
                  {diagView && bottomTab === "data" && (
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
                      <button
                        type="button"
                        className="shrink-0 text-teal-300/80 hover:text-teal-100"
                        onClick={() => setDiagView(null)}
                      >
                        Back to preview
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="min-h-0 flex-1 px-3 pb-3 pt-1">
                <div
                  className={`overflow-hidden rounded-xl border border-[var(--line)] bg-slate-950/40 ${
                    joinLensOn && joinLensTarget && !diagView
                      ? "h-[28vh]"
                      : "h-[22vh]"
                  }`}
                >
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
                      <JoinLens
                        enabled
                        workspace={project.workspace}
                        hostQueryId={joinLensTarget.hostQueryId}
                        joinStepIndex={joinLensTarget.joinStepIndex}
                        leftOn={joinLensTarget.leftOn}
                        rightOn={joinLensTarget.rightOn}
                        connections={connections}
                        columns={preview.columns}
                        rows={preview.rows}
                      />
                    ) : preview ? (
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

          <PanelResizeHandle
            aria-label="Resize inspector"
            onDelta={(dx) =>
              setInspectorWidth((w) => {
                const next = clampPanelWidth(w - dx, 220, 560);
                inspectorWidthRef.current = next;
                return next;
              })
            }
            onDragEnd={() =>
              persistPanelWidths(
                explorerWidthRef.current,
                inspectorWidthRef.current,
              )
            }
          />

          {/* Inspector: top = step order, bottom = edit selected step */}
          <aside
            className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-[#050b12]"
            style={{ width: inspectorWidth }}
          >
            <div className="shrink-0 border-b border-[var(--line)] px-4 py-3">
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
                          setQueries((prev) =>
                            prev.map((q) =>
                              q.id === activeQuery.id
                                ? { ...q, execution: ex }
                                : q,
                            ),
                          )
                        }
                        className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                          on
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
              <div className="flex min-h-0 flex-[1_1_50%] flex-col border-b border-[var(--line)] px-3 py-2">
                <History
                  steps={activeQuery?.steps ?? []}
                  queryNames={Object.fromEntries(
                    queries.map((q) => [q.id, q.name]),
                  )}
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
                  <div className="mb-3 space-y-2">
                    {(selectedStep.type === "LoadCsv" ||
                      selectedStep.type === "LoadParquet" ||
                      selectedStep.type === "LoadPostgres") && (
                      <p className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2 font-mono text-[11px] text-slate-400">
                        Source step (pinned at s0). Change via Sources catalog.
                      </p>
                    )}
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
                          {otherQueries.map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.name}
                            </option>
                          ))}
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
                              payload: { query_id: fromQueryId },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
                    {selectedStep.type === "SqlModel" && (
                      <>
                        <p className="text-[10px] text-slate-500">
                          Root model SQL (prod dialect). Preview runs in-app;
                          export is this body.
                        </p>
                        <textarea
                          value={customSql}
                          onChange={(e) => setCustomSql(e.target.value)}
                          rows={8}
                          spellCheck={false}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "SqlModel",
                              payload: { raw_sql: customSql.trim() },
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
                          type="text"
                          value={filterCondition}
                          onChange={(e) => setFilterCondition(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && selectedStepIndex !== null) {
                              replaceStepAt(selectedStepIndex, {
                                type: "Filter",
                                payload: {
                                  condition: filterCondition.trim(),
                                },
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
                            replaceStepAt(selectedStepIndex, {
                              type: "Filter",
                              payload: { condition: filterCondition.trim() },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
                    {selectedStep.type === "SelectColumns" && (
                      <>
                        {columnChoices.length > 0 && (
                          <ul className="max-h-28 space-y-0.5 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1.5">
                            {columnChoices.map((name) => {
                              const checked = selectedColumns.includes(name);
                              return (
                                <li key={name}>
                                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-200 hover:bg-slate-900">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleColumn(name)}
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
                          placeholder="date, region, amount"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "SelectColumns",
                              payload: { columns: [...selectedColumns] },
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
                          type="text"
                          value={groupDims}
                          onChange={(e) => setGroupDims(e.target.value)}
                          placeholder="dimensions: region"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        />
                        <input
                          type="text"
                          value={groupAggs}
                          onChange={(e) => setGroupAggs(e.target.value)}
                          placeholder="sum(qty) as qty"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const dimensions = groupDims
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            const aggregates = groupAggs
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            if (!dimensions.length || !aggregates.length) return;
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
                    {selectedStep.type === "Join" && (
                      <>
                        <p className="text-[10px] text-slate-500">
                          Join another query into this one (canvas drag or
                          edit here).
                        </p>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
                          Right query
                        </label>
                        <select
                          value={joinRightId}
                          onChange={(e) => setJoinRightId(e.target.value)}
                          disabled={otherQueries.length === 0}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        >
                          <option value="">right query…</option>
                          {otherQueries.map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.name}
                            </option>
                          ))}
                        </select>
                        {otherQueries.length === 0 && (
                          <p className="text-[11px] text-amber-500/90">
                            Need another query in the project to join.
                          </p>
                        )}
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
                          Type
                        </label>
                        <select
                          value={joinType}
                          onChange={(e) =>
                            setJoinType(e.target.value as JoinType)
                          }
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                        >
                          <option value="inner">inner</option>
                          <option value="left">left</option>
                          <option value="right">right</option>
                          <option value="full">full</option>
                        </select>
                        <JoinKeyEditor
                          pairs={joinKeyPairs}
                          onChange={setJoinKeyPairs}
                          leftColumns={joinLeftColumns}
                          rightColumns={joinRightColumns}
                          leftLoading={joinColsLoading}
                          rightLoading={joinColsLoading}
                        />
                        <button
                          type="button"
                          disabled={
                            !joinRightId || !joinPairsComplete(joinKeyPairs)
                          }
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const { left_on, right_on } =
                              pairsToOn(joinKeyPairs);
                            replaceStepAt(selectedStepIndex, {
                              type: "Join",
                              payload: {
                                right_query_id: joinRightId,
                                join_type: joinType,
                                left_on,
                                right_on,
                              },
                            });
                          }}
                        >
                          Apply
                        </button>
                        <JoinDiagnosticsPanel
                          loading={joinDiagLoading}
                          error={joinDiagError}
                          diag={joinDiag}
                          onOpen={(kind, sample, label) =>
                            void openJoinDiagnostic(kind, sample, label)
                          }
                        />
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
                          {otherQueries.map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.name}
                            </option>
                          ))}
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
                              payload: { other_query_ids: [appendOtherId] },
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
                            list="inspector-cols"
                            value={sortCol}
                            onChange={(e) => setSortCol(e.target.value)}
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
                          disabled={!sortCol.trim()}
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "SortBy",
                              payload: {
                                column: sortCol.trim(),
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
                          type="number"
                          min={1}
                          value={limitN}
                          onChange={(e) => setLimitN(e.target.value)}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const n = Number.parseInt(limitN, 10);
                            if (!Number.isFinite(n) || n < 1) return;
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
                          value={renameFrom}
                          onChange={(e) => setRenameFrom(e.target.value)}
                          placeholder="from"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <input
                          value={renameTo}
                          onChange={(e) => setRenameTo(e.target.value)}
                          placeholder="to"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <button
                          type="button"
                          disabled={!renameFrom.trim() || !renameTo.trim()}
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "RenameColumn",
                              payload: {
                                from: renameFrom.trim(),
                                to: renameTo.trim(),
                              },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
                    {selectedStep.type === "DeriveColumn" && (
                      <>
                        <input
                          value={deriveName}
                          onChange={(e) => setDeriveName(e.target.value)}
                          placeholder="name"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <input
                          value={deriveExpr}
                          onChange={(e) => setDeriveExpr(e.target.value)}
                          placeholder="expression"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <button
                          type="button"
                          disabled={!deriveName.trim() || !deriveExpr.trim()}
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "DeriveColumn",
                              payload: {
                                name: deriveName.trim(),
                                expression: deriveExpr.trim(),
                              },
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
                          value={customSql}
                          onChange={(e) => setCustomSql(e.target.value)}
                          rows={5}
                          spellCheck={false}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            replaceStepAt(selectedStepIndex, {
                              type: "CustomSql",
                              payload: { raw_sql: customSql.trim() },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
                  </div>
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
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
