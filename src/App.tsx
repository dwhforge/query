import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function clampPanelWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

const BOTTOM_DOCK_HEIGHT_KEY = "dwh.bottomDockHeightPx";

function loadBottomDockHeight(): number {
  try {
    const raw = localStorage.getItem(BOTTOM_DOCK_HEIGHT_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampPanelWidth(n, 180, 720);
    }
  } catch {
    /* ignore */
  }
  return 280;
}
import {
  openDialog as open,
  revealItemInDir,
  windowAction,
  saveDialog as save,
} from "./lib/bridge";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { AppMenu } from "./components/AppMenu";
import { EmptyHero, type DemoId } from "./components/EmptyHero";
import { HelpDialog } from "./components/HelpDialog";
import { ExplorerTree } from "./components/ExplorerTree";
import {
  OpProgress,
  type OpProgressState,
} from "./components/OpProgress";
import { ErrorBanner } from "./components/ErrorBanner";
import {
  JoinDiagnosticsPanel,
  type JoinDiagKind,
} from "./components/JoinDiagnosticsPanel";
import { JoinLens } from "./components/JoinLens";
import { JoinKeyEditor } from "./components/JoinKeyEditor";
import { KeyMapEditor } from "./components/KeyMapEditor";
import {
  applyKeyMapToWorkspace,
  applyNormalizeToWorkspace,
  deleteKeyMapFromWorkspace,
  emptyKeyMap,
  findApplyKeyMapIdForJoin,
  resolveKeyMapConnection,
  syncApplyKeyMapEntries,
  upsertKeyMapList,
  type ApplySide,
} from "./lib/keyMap";
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
import { SelectColumnsEditor } from "./components/SelectColumnsEditor";
import { SourceSchemaPanel } from "./components/SourceSchemaPanel";
import { debounce } from "./lib/debounce";
import {
  describePostgresObject,
  exportDbt,
  joinDiagnostics,
  listExportTree,
  getAppSettings,
  getGlobalConnections,
  getLastProjectPath,
  loadProject,
  loadDemoWorkspace,
  previewDbtModel,
  previewWorkspace,
  pushKeyMapToExport,
  readKeyMap,
  saveProject,
  setAppSettings,
  setGlobalConnections,
  syncKeyMapsFromExport,
  writeKeyMap,
  parseExport,
  buildExport,
  type AppSettings,
  type JoinDiagSample,
  type JoinDiagnostics,
  type KeyMapSaveResult,
  type NearMissHypothesis,
  type PreviewDbtModel,
  type PostgresColumn,
} from "./lib/bridge";
import {
  connectionById,
  emptyProject,
  migrateProject,
  newQueryId,
  newSourceId,
  isPublishedOutput,
  projectDestination,
  projectDialect,
  projectEngine,
  queryExecution,
  routeLabel,
  togglePublishedOutput,
  syncSourcesFromQueries,
  type ConnectionDef,
  type ConnectionKind,
  type DestinationKind,
  type DeriveMode,
  type DeriveOp,
  type DeriveOpId,
  type ExecutionEngine,
  type JoinType,
  type ColumnMetadata,
  type PreviewResult,
  type Project,
  type QueryDef,
  type QueryExecution,
  type SourceDef,
  type KeyMapDef,
  type NormalizeOp,
  type TransformationStep,
  type WarehouseDialect,
  type Workspace,
} from "./types/pipeline";

type KeyMapTabSession = {
  map: KeyMapDef;
  /** Optimistic concurrency token from last warehouse read (source storage). */
  contentHash?: string;
  pickTo?: string[];
  suggestedFrom?: string[];
  joinCtx?: {
    hostQueryId: string;
    joinStepIndex: number;
    rightQueryId: string;
    leftOn: string[];
    rightOn: string[];
    /** Side whose unmatched key opened Add to map… */
    probeSide?: "left" | "right";
  };
};

function App() {
  const [project, setProject] = useState<Project>(() => emptyProject("Untitled"));
  const [appSettings, setAppSettingsState] = useState<AppSettings>({
    default_target_dialect: "duckdb",
    default_dbt_target: "v1",
    explorer_width_px: 240,
    inspector_width_px: 300,
  });
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [bottomDockHeight, setBottomDockHeight] = useState(loadBottomDockHeight);
  const bottomDockHeightRef = useRef(bottomDockHeight);
  bottomDockHeightRef.current = bottomDockHeight;
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
  /** Schema before the selected SelectColumns step (full upstream column list). */
  const [upstreamColumnNames, setUpstreamColumnNames] = useState<string[]>([]);
  const [groupDims, setGroupDims] = useState("");
  const [groupAggs, setGroupAggs] = useState("count(*) as n");
  const [joinRightId, setJoinRightId] = useState("");
  /** Join key pairs (IR `left_on` / `right_on`). */
  const [joinKeyPairs, setJoinKeyPairs] = useState<JoinKeyPair[]>([
    emptyJoinKeyPair(),
  ]);
  /** Live Join key draft (JoinKeyEditor) — avoids App setState on every keystroke. */
  const joinKeyDraftRef = useRef<JoinKeyPair[]>(joinKeyPairs);
  const [joinType, setJoinType] = useState<JoinType>("inner");
  /** Inspector text drafts — read on Apply; typing must not re-render App. */
  const filterInputRef = useRef<HTMLInputElement>(null);
  const customSqlRef = useRef<HTMLTextAreaElement>(null);
  const groupDimsRef = useRef<HTMLInputElement>(null);
  const groupAggsRef = useRef<HTMLInputElement>(null);
  const sortColRef = useRef<HTMLInputElement>(null);
  const limitNRef = useRef<HTMLInputElement>(null);
  const renameFromRef = useRef<HTMLInputElement>(null);
  const renameToRef = useRef<HTMLInputElement>(null);
  const deriveNameRef = useRef<HTMLInputElement>(null);
  const deriveExprRef = useRef<HTMLInputElement>(null);

  const setJoinKeyPairsBoth = useCallback((pairs: JoinKeyPair[]) => {
    joinKeyDraftRef.current = pairs;
    setJoinKeyPairs(pairs);
  }, []);
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
    /** When set, banner can open KeyMap with these unmatched key values. */
    mapSide?: "left" | "right";
  } | null>(null);
  /** Join Lens mode on Data (where-provenance docks). Default on when Join selected. */
  const [joinLensOn, setJoinLensOn] = useState(true);
  /** Bump to switch Join Lens into Probe (from Data diag banner). */
  const [forceProbeNonce, setForceProbeNonce] = useState(0);
  /** Open KeyMap editor tabs (VS Code–style, beside Pipeline canvas). */
  const [keyMapTabs, setKeyMapTabs] = useState<KeyMapTabSession[]>([]);
  /** Center workspace tab: canvas or open KeyMap id. */
  const [centerTab, setCenterTab] = useState<"canvas" | string>("canvas");
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
  const [deriveMode, setDeriveMode] = useState<DeriveMode>("sql");
  const [deriveOpId, setDeriveOpId] = useState<DeriveOpId>("month_start");
  const [deriveOpCol, setDeriveOpCol] = useState("");
  const [deriveOpColB, setDeriveOpColB] = useState("");
  const [deriveOpValue, setDeriveOpValue] = useState("");
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
  const [opProgress, setOpProgress] = useState<OpProgressState | null>(null);
  /** Add to map… — choose which KeyMap when several exist. */
  const [mapPickPending, setMapPickPending] = useState<{
    fromValues: string[];
    toValues?: string[];
    joinCtx: NonNullable<KeyMapTabSession["joinCtx"]>;
    /** Prefer this map (from existing ApplyKeyMap); still offer others. */
    preferredMapId?: string | null;
  } | null>(null);
  /** Selected target in the picker: map id, or `"__new__"`. */
  const [mapPickChoice, setMapPickChoice] = useState<string | null>(null);
  /** After auto-opening ApplyKeyMap target — allow switching map quietly. */
  const [mapSwitchOffer, setMapSwitchOffer] = useState<{
    fromValues: string[];
    toValues?: string[];
    joinCtx: NonNullable<KeyMapTabSession["joinCtx"]>;
    preferredMapId: string;
  } | null>(null);
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
    keyMaps: true,
    export: true,
  });
  const [selectedKeyMapId, setSelectedKeyMapId] = useState<string | null>(null);

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
    const q = queries.find((x) => x.id === id);
    // While a Join step is selected, preview *through that Join only* so Join Lens
    // row offsets match this join's output (chained Joins change grain/rows).
    if (
      q &&
      selectedStepIndex != null &&
      q.steps[selectedStepIndex]?.type === "Join"
    ) {
      const upto = selectedStepIndex + 1;
      return {
        ...project.workspace,
        focus_query_id: id,
        queries: project.workspace.queries.map((qq) =>
          qq.id === id ? { ...qq, steps: qq.steps.slice(0, upto) } : qq,
        ),
      };
    }
    return { ...project.workspace, focus_query_id: id };
  }, [
    project.workspace,
    queries,
    activeQueryId,
    focusQueryId,
    selectedStepIndex,
  ]);

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

  const overlayOpen =
    connEditorOpen ||
    helpOpen ||
    showPgPicker ||
    showS3Dialog ||
    Boolean(mapPickPending);

  useEffect(() => {
    // Don't fight the modal for main-thread / DuckDB while a dialog has focus.
    if (overlayOpen || !dataWorkspace) return;
    debouncedPreview(dataWorkspace, connections);
  }, [dataWorkspace, connections, debouncedPreview, overlayOpen]);

  // Schema-aware Join: column lists from truncated preview (left before Join, full right).
  useEffect(() => {
    if (overlayOpen) return;
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
    overlayOpen,
  ]);

  // Join diagnostics (DESIGN §9) — async, never blocks Apply / canvas.
  // Skip until ON keys exist: a new Join is often saved with left_on=[], and
  // the engine rejects that with "left_on/right_on must be non-empty…".
  useEffect(() => {
    if (overlayOpen) return;
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
    const { left_on, right_on } = step.payload;
    if (
      left_on.length === 0 ||
      left_on.length !== right_on.length
    ) {
      setJoinDiag(null);
      setJoinDiagError(null);
      setJoinDiagLoading(false);
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
    overlayOpen,
  ]);

  // Model tab: dbt SQL for the selected query (instant, no DuckDB).
  useEffect(() => {
    if (overlayOpen) return;
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
          // Stale dwh-host without the new command — full restart, not HMR.
          setModelError(
            /not found/i.test(msg)
              ? "Backend outdated: stop & restart electron:dev (HMR won’t reload dwh-host)."
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
    overlayOpen,
  ]);

  const syncInspectorFromQuery = useCallback(
    (q: QueryDef | undefined) => {
      if (!q) {
        setFilterCondition("");
        setSelectedColumns([]);
        setGroupDims("");
        setGroupAggs("count(*) as n");
        setJoinRightId("");
        setJoinKeyPairsBoth([emptyJoinKeyPair()]);
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
        setJoinKeyPairsBoth(
          pairsFromOn(j.payload.left_on, j.payload.right_on),
        );
        setJoinType(j.payload.join_type);
      } else {
        setJoinRightId("");
        setJoinKeyPairsBoth([emptyJoinKeyPair()]);
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
        setJoinKeyPairsBoth(
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
        setDeriveExpr(step.payload.expression ?? "");
        setDeriveMode(step.payload.mode ?? (step.payload.op ? "op" : "sql"));
        setDeriveOpId(step.payload.op?.id ?? "month_start");
        setDeriveOpCol(step.payload.op?.column ?? "");
        setDeriveOpColB(step.payload.op?.column_b ?? "");
        setDeriveOpValue(step.payload.op?.value ?? "");
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
      setCenterTab("canvas");
      setSelectedKeyMapId(null);
      setActiveQueryId(id);
      const q = queries.find((x) => x.id === id);
      syncInspectorFromQuery(q);
      const last = q && q.steps.length > 0 ? q.steps.length - 1 : null;
      setSelectedStepIndex(last);
      if (last !== null && q) loadStepIntoEditor(q.steps[last]);
    },
    [queries, syncInspectorFromQuery, loadStepIntoEditor],
  );

  function closeKeyMapTab(mapId: string) {
    setKeyMapTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.map.id === mapId);
      const next = tabs.filter((t) => t.map.id !== mapId);
      setCenterTab((cur) => {
        if (cur !== mapId) return cur;
        if (next.length === 0) return "canvas";
        const fallback = next[Math.min(Math.max(idx, 0), next.length - 1)];
        return fallback?.map.id ?? "canvas";
      });
      return next;
    });
    setSelectedKeyMapId((id) => (id === mapId ? null : id));
  }

  function patchKeyMapTab(mapId: string, patch: Partial<KeyMapTabSession> | ((t: KeyMapTabSession) => KeyMapTabSession)) {
    setKeyMapTabs((tabs) =>
      tabs.map((t) => {
        if (t.map.id !== mapId) return t;
        return typeof patch === "function" ? patch(t) : { ...t, ...patch };
      }),
    );
  }

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

  async function upsertConnection(conn: ConnectionDef) {
    const next = (() => {
      const idx = project.connections.findIndex((c) => c.id === conn.id);
      return idx >= 0
        ? project.connections.map((c) => (c.id === conn.id ? conn : c))
        : [...project.connections, conn];
    })();
    setProject((p) => ({ ...p, connections: next }));
    setConnEditorOpen(false);
    setEditingConnection(null);
    try {
      await setGlobalConnections(next);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
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
    // Legacy: set both engine and destination to the same kind.
    setProject((p) =>
      migrateProject({
        ...p,
        execution_engine: d,
        destination:
          d === "postgres"
            ? {
                kind: "postgres",
                connection_id:
                  p.destination?.connection_id ?? p.target_connection_id,
              }
            : { kind: "duckdb", duckdb_path: "local.duckdb" },
        target_dialect: d,
      }),
    );
    await persistAppSettings({
      ...appSettings,
      default_target_dialect: d,
    });
  }

  function handleSetExecutionEngine(e: ExecutionEngine) {
    setProject((p) =>
      migrateProject({
        ...p,
        execution_engine: e,
        target_dialect: e,
      }),
    );
  }

  function handleSetDestinationKind(d: DestinationKind) {
    setProject((p) => {
      const m = migrateProject(p);
      const pgConns = m.connections.filter((c) => c.kind === "postgres");
      return migrateProject({
        ...m,
        destination:
          d === "postgres"
            ? {
                kind: "postgres",
                connection_id:
                  m.destination?.connection_id ??
                  m.target_connection_id ??
                  pgConns[0]?.id,
                schema: m.destination?.schema ?? "public",
              }
            : {
                kind: "duckdb",
                duckdb_path: m.destination?.duckdb_path ?? "local.duckdb",
              },
        target_connection_id:
          d === "postgres"
            ? m.destination?.connection_id ??
              m.target_connection_id ??
              pgConns[0]?.id
            : undefined,
      });
    });
  }

  function handleSetDestinationConnection(id: string | undefined) {
    setProject((p) => {
      const m = migrateProject(p);
      return migrateProject({
        ...m,
        destination: {
          kind: "postgres",
          connection_id: id,
        },
        target_connection_id: id,
      });
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
            : id === "right"
              ? "demo_right_joins"
              : id === "keymap"
                ? "demo_keymap"
                : "demo_sql";
      setProject((p) =>
        migrateProject({
          ...p,
          name: projectName,
          // Keep global connections; demos only replace sources/workspace.
          sources: syncSourcesFromQueries([], ws.queries),
          workspace: ws,
          canvas: { positions: {} },
          dbt_target: appSettings.default_dbt_target,
          execution_engine: appSettings.default_target_dialect ?? "duckdb",
          target_dialect: appSettings.default_target_dialect,
        }),
      );
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
        const step: TransformationStep = {
          type: "Join",
          payload: {
            right_query_id: rightQueryId,
            join_type: type,
            left_on,
            right_on,
          },
        };
        // Update existing edge to the same right; otherwise append — keep other
        // Joins (e.g. two RIGHT OUTER to different dims).
        const existing = q.steps.findIndex(
          (s) =>
            s.type === "Join" && s.payload.right_query_id === rightQueryId,
        );
        let steps: TransformationStep[];
        if (existing >= 0) {
          steps = q.steps.map((s, i) => (i === existing ? step : s));
          joinIndex = existing;
        } else {
          steps = [...q.steps, step];
          joinIndex = steps.length - 1;
        }
        joinStep = step;
        return { ...q, steps };
      }),
    );
    setJoinRightId(rightQueryId);
    setJoinKeyPairsBoth(
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

  function highlightKeysForDiag(kind: JoinDiagKind): string[] {
    if (!joinDiag) return [];
    // Only highlight keys that exist on that side — mixing left_on+right_on
    // marks the wrong columns after the SideCard / sample format change.
    switch (kind) {
      case "left":
      case "unmatched_left":
        return joinDiag.left_on;
      case "right":
      case "unmatched_right":
      case "right_dups":
        return joinDiag.right_on;
      case "fanout":
        return [...joinDiag.left_on, ...joinDiag.right_on];
      case "output":
      default:
        return joinDiag.left_on;
    }
  }

  async function openJoinDiagnostic(
    kind: JoinDiagKind,
    sample: JoinDiagSample | null,
    label: string,
  ) {
    if (!joinDiag || !activeQueryId) return;
    const highlightKeys = highlightKeysForDiag(kind);
    const sampleLimit = joinDiag.sample_limit;

    if (sample) {
      setDiagView({
        label,
        columns: sample.columns,
        rows: sample.rows,
        totalCount: sample.total_count,
        sampleLimit,
        highlightKeys,
        mapSide:
          kind === "unmatched_left"
            ? "left"
            : kind === "unmatched_right"
              ? "right"
              : undefined,
      });
      setBottomTab("data");
      return;
    }

    // left / right / output — preview truncated workspace (LIMIT 50 via preview).
    try {
      let ws: Workspace;
      if (kind === "left") {
        const leftSteps = (
          project.workspace.queries.find((q) => q.id === activeQueryId)
            ?.steps ?? []
        ).slice(0, joinDiag.join_step_index);
        if (leftSteps.length === 0) {
          setJoinDiagError("Join has no left input (need a step before Join)");
          return;
        }
        ws = {
          ...project.workspace,
          focus_query_id: activeQueryId,
          queries: project.workspace.queries.map((q) =>
            q.id === activeQueryId ? { ...q, steps: leftSteps } : q,
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
        highlightKeys,
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
    // Steps *before* the Join. upto=0 ⇒ no left input (don't preview empty query).
    const leftUpto = Math.max(0, upto);
    const leftSteps = host?.steps.slice(0, leftUpto) ?? [];

    const leftWs: Workspace | null =
      leftSteps.length > 0
        ? {
            ...project.workspace,
            focus_query_id: hostQueryId,
            queries: project.workspace.queries.map((q) =>
              q.id === hostQueryId ? { ...q, steps: leftSteps } : q,
            ),
          }
        : null;
    const rightWs: Workspace = {
      ...project.workspace,
      focus_query_id: rightQueryId,
    };

    const [leftRes, rightRes] = await Promise.all([
      leftWs
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
    let pairs = joinKeyDraftRef.current;
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
      const idx =
        edge.stepIndex != null &&
        host?.steps[edge.stepIndex]?.type === "Join"
          ? edge.stepIndex
          : (host?.steps.findIndex(
              (s) =>
                s.type === "Join" &&
                s.payload.right_query_id === edge.otherQueryId,
            ) ?? -1);
      const j = idx >= 0 ? host?.steps[idx] : undefined;
      if (j && j.type === "Join") {
        setJoinKeyPairsBoth(
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
    if (edge.kind === "from") {
      const host = queries.find((q) => q.id === edge.hostQueryId);
      if (host) {
        const withoutFrom = host.steps.filter(
          (s) =>
            !(
              s.type === "FromQuery" &&
              s.payload.query_id === edge.otherQueryId
            ),
        );
        const stillHasRoot = withoutFrom.some(
          (s) =>
            s.type === "LoadCsv" ||
            s.type === "LoadParquet" ||
            s.type === "LoadPostgres" ||
            s.type === "FromQuery" ||
            s.type === "SqlModel",
        );
        if (!stillHasRoot && withoutFrom.length > 0) {
          setError(
            "Cannot remove FromQuery while later steps remain — delete those steps first.",
          );
          return;
        }
      }
    }
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== edge.hostQueryId) return q;
        if (edge.kind === "join") {
          return {
            ...q,
            steps: q.steps.filter((s, i) => {
              if (s.type !== "Join") return true;
              if (
                edge.stepIndex != null &&
                i === edge.stepIndex &&
                s.payload.right_query_id === edge.otherQueryId
              ) {
                return false;
              }
              if (
                edge.stepIndex == null &&
                s.payload.right_query_id === edge.otherQueryId
              ) {
                return false;
              }
              return true;
            }),
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
    updateActiveSteps((steps) => {
      const victim = steps[index];
      if (!victim) return steps;
      const isRoot =
        victim.type === "LoadCsv" ||
        victim.type === "LoadParquet" ||
        victim.type === "LoadPostgres" ||
        victim.type === "LoadDuckdb" ||
        victim.type === "FromQuery" ||
        victim.type === "SqlModel";
      // Deleting the root while later transforms remain → "требует предыдущий шаг".
      if (isRoot && steps.length > 1) {
        setError("Remove later steps first, or clear the query — root step is required.");
        return steps;
      }
      return steps.filter((_, i) => i !== index);
    });
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
        s.type === "LoadDuckdb" ||
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
    const withConnections: Project = migrateProject({
      ...loaded,
      connections: loaded.connections ?? [],
      root_path: loaded.root_path ?? pathHint,
    });
    setProject(withConnections);
    setActiveQueryId(withConnections.workspace.focus_query_id || null);
    void refreshExportTree(withConnections.last_dbt_export_path);
    setError(null);
    // After first export, seeds/map_*.csv is SoT (ADR-0020).
    const exportPath = withConnections.last_dbt_export_path;
    if (exportPath) {
      void syncKeyMapsFromExport(withConnections.workspace, exportPath)
        .then((synced) => {
          setProject((p) =>
            p.last_dbt_export_path === exportPath
              ? { ...p, workspace: synced.workspace }
              : p,
          );
        })
        .catch(() => {
          /* export tree missing — keep project maps */
        });
    }
  }

  function openKeyMapEditor(
    map: KeyMapDef,
    opts?: {
      pickTo?: string[];
      suggestedFrom?: string[];
      joinCtx?: {
        hostQueryId: string;
        joinStepIndex: number;
        rightQueryId: string;
        leftOn: string[];
        rightOn: string[];
        probeSide?: "left" | "right";
      };
    },
  ) {
    const normalized: KeyMapDef = {
      storage: { kind: "seed" },
      from_column: "from",
      to_column: "to",
      ...map,
    };
    setSelectedKeyMapId(normalized.id);
    setKeyMapTabs((tabs) => {
      const i = tabs.findIndex((t) => t.map.id === normalized.id);
      const session: KeyMapTabSession = {
        map: normalized,
        pickTo: opts?.pickTo,
        suggestedFrom: opts?.suggestedFrom,
        joinCtx: opts?.joinCtx,
      };
      if (i < 0) return [...tabs, session];
      // Refresh opts / map shell but keep in-tab edits if re-opening same id from explorer
      // with a newer project copy — prefer project map entries when opening from tree.
      const prev = tabs[i]!;
      const next = [...tabs];
      next[i] = {
        ...session,
        map: {
          ...normalized,
          // Keep unsaved tab entries if same revision id already open
          entries: prev.map.entries.length ? prev.map.entries : normalized.entries,
          storage: normalized.storage ?? prev.map.storage,
        },
      };
      return next;
    });
    setCenterTab(normalized.id);
    // Source-backed: load live rows from WH into the editor.
    const sourceStorage =
      normalized.storage?.kind === "source" ? normalized.storage : null;
    if (sourceStorage) {
      void (async () => {
        let conns = project.connections;
        try {
          const global = await getGlobalConnections();
          if (global.length) {
            conns = global;
            setProject((p) => ({ ...p, connections: global }));
          }
        } catch {
          /* keep project.connections */
        }
        // Read may resolve a DSN via Explorer source match, but never write that
        // into storage.connection_id — assignment must be an explicit user choice.
        const resolved = resolveKeyMapConnection(
          project,
          normalized,
          conns,
          false,
        );
        if (!resolved.ok) {
          setError(resolved.error);
          return;
        }
        try {
          const r = await readKeyMap(normalized, resolved.dsn);
          patchKeyMapTab(normalized.id, (s) => ({
            ...s,
            map: { ...s.map, entries: r.entries },
            contentHash: r.content_hash,
          }));
        } catch (e) {
          setError(
            typeof e === "string"
              ? e
              : `Could not load KeyMap from warehouse: ${String(e)}`,
          );
        }
      })();
    }
  }

  async function saveKeyMapToProject(map: KeyMapDef): Promise<KeyMapSaveResult> {
    // Persist to project AST first (local). External sync reports separately.
    setProject((p) => {
      const key_maps = upsertKeyMapList(p.workspace.key_maps ?? [], map);
      const queries = syncApplyKeyMapEntries(p.workspace.queries, map);
      return {
        ...p,
        workspace: { ...p.workspace, key_maps, queries },
      };
    });
    setSelectedKeyMapId(map.id);
    const kind = map.storage?.kind ?? "seed";
    if (kind === "seed") {
      const exportPath = project.last_dbt_export_path;
      if (!exportPath) {
        const result: KeyMapSaveResult = {
          local: "saved",
          external: "skipped",
          message: "KeyMap saved in project (not exported yet — no seed CSV)",
        };
        setExportMsg(result.message);
        return result;
      }
      try {
        await pushKeyMapToExport(exportPath, map);
        const result: KeyMapSaveResult = {
          local: "saved",
          external: "synced",
          message: "KeyMap saved in project · synced → seeds (export tree)",
        };
        setExportMsg(result.message);
        setError(null);
        return result;
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        const isConflict = /refused|hash mismatch|conflict/i.test(msg);
        const result: KeyMapSaveResult = {
          local: "saved",
          external: isConflict ? "conflict" : "error",
          message: msg,
        };
        setError(
          isConflict
            ? msg
            : `KeyMap saved in project, but seed sync failed: ${msg}`,
        );
        setExportMsg(
          isConflict
            ? "KeyMap saved in project · seed CONFLICT"
            : "KeyMap saved in project · seed sync FAILED",
        );
        return result;
      }
    }
    if (kind === "source") {
      let conns = project.connections;
      let resolved = resolveKeyMapConnection(project, map, conns, true);
      if (!resolved.ok) {
        try {
          conns = await getGlobalConnections();
          if (conns.length) {
            setProject((p) => ({ ...p, connections: conns }));
          }
          resolved = resolveKeyMapConnection(project, map, conns, true);
        } catch {
          /* ignore */
        }
      }
      if (!resolved.ok) {
        const result: KeyMapSaveResult = {
          local: "saved",
          external: "skipped",
          message: resolved.error,
        };
        setError(resolved.error);
        setExportMsg("KeyMap saved in project · warehouse write skipped");
        return result;
      }
      const expectedHash = keyMapTabs.find((t) => t.map.id === map.id)?.contentHash;
      try {
        const r = await writeKeyMap(map, resolved.dsn, expectedHash);
        patchKeyMapTab(map.id, (s) => ({
          ...s,
          contentHash: r.content_hash,
        }));
        const result: KeyMapSaveResult = {
          local: "saved",
          external: "synced",
          message: `KeyMap saved in project · write-back → ${r.schema}.${r.table} (${r.rows_written} rows)`,
          contentHash: r.content_hash,
        };
        setExportMsg(result.message);
        setError(null);
        return result;
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        const isConflict = /refused|concurrently|hash/i.test(msg);
        const result: KeyMapSaveResult = {
          local: "saved",
          external: isConflict ? "conflict" : "error",
          message: msg,
        };
        setError(
          isConflict
            ? msg
            : `KeyMap saved in project, but warehouse write-back failed: ${msg}`,
        );
        setExportMsg(
          isConflict
            ? "KeyMap saved in project · warehouse CONFLICT"
            : "KeyMap saved in project · warehouse write FAILED",
        );
        return result;
      }
    }
    // ref: project cache only
    const result: KeyMapSaveResult = {
      local: "saved",
      external: "none",
      message: "KeyMap saved in project (ref storage — no warehouse write-back)",
    };
    setExportMsg(result.message);
    return result;
  }

  function handleAddKeyMap() {
    const map = emptyKeyMap("Key map");
    void saveKeyMapToProject(map);
    openKeyMapEditor(map);
    setTreeExpanded((e) => ({ ...e, keyMaps: true }));
  }

  function handleRenameKeyMap(mapId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProject((p) => {
      const key_maps = (p.workspace.key_maps ?? []).map((m) =>
        m.id === mapId ? { ...m, name: trimmed } : m,
      );
      return { ...p, workspace: { ...p.workspace, key_maps } };
    });
    patchKeyMapTab(mapId, (t) => ({ ...t, map: { ...t.map, name: trimmed } }));
  }

  function handleDeleteKeyMap(mapId: string) {
    setProject((p) => {
      const { workspace } = deleteKeyMapFromWorkspace(p.workspace, mapId);
      return { ...p, workspace };
    });
    if (selectedKeyMapId === mapId) setSelectedKeyMapId(null);
    closeKeyMapTab(mapId);
  }

  function handleApplyNearMiss(hyp: NearMissHypothesis) {
    if (!joinLensTarget) return;
    const ops = hyp.ops as NormalizeOp[];
    const side = hyp.apply_on as ApplySide;
    setProject((p) => ({
      ...p,
      workspace: applyNormalizeToWorkspace(
        p.workspace,
        joinLensTarget.hostQueryId,
        joinLensTarget.joinStepIndex,
        joinLensTarget.rightQueryId,
        side,
        joinLensTarget.leftOn,
        joinLensTarget.rightOn,
        ops,
      ),
    }));
  }

  function openMapWithFromValues(
    map: KeyMapDef,
    fromValues: string[],
    joinCtx: NonNullable<KeyMapTabSession["joinCtx"]>,
    toValues?: string[],
  ) {
    const entries = [...map.entries];
    const indexByFrom = new Map(
      entries.map((e, i) => [e.from.trim(), i] as const),
    );
    fromValues.forEach((rawFrom, i) => {
      const from = rawFrom.trim();
      if (!from) return;
      const to = (toValues?.[i] ?? "").trim();
      const existing = indexByFrom.get(from);
      if (existing !== undefined) {
        if (to && !entries[existing]!.to.trim()) {
          entries[existing] = { ...entries[existing]!, to };
        }
        return;
      }
      indexByFrom.set(from, entries.length);
      entries.push({ from, to });
    });
    const merged = { ...map, entries };
    openKeyMapEditor(merged, {
      suggestedFrom: fromValues,
      joinCtx,
    });
  }

  function handleMapKeyFromLens(
    side: "left" | "right",
    fromValues: string[],
    opts?: { toValues?: string[] },
  ) {
    if (!joinLensTarget || fromValues.length === 0) return;
    const maps = project.workspace.key_maps ?? [];
    const toValues = opts?.toValues;
    const joinCtx = { ...joinLensTarget, probeSide: side };
    if (maps.length === 0) {
      openMapWithFromValues(
        {
          ...emptyKeyMap("join aliases"),
          entries: fromValues.map((from, i) => ({
            from,
            to: toValues?.[i] ?? "",
          })),
        },
        fromValues,
        joinCtx,
        toValues,
      );
      setMapSwitchOffer(null);
      return;
    }

    // Most common: Join already has ApplyKeyMap → open that map directly.
    const preferredId = findApplyKeyMapIdForJoin(
      project.workspace,
      joinCtx,
    );
    const preferred = preferredId
      ? maps.find((m) => m.id === preferredId)
      : undefined;
    if (preferred) {
      openMapWithFromValues(preferred, fromValues, joinCtx, toValues);
      setMapSwitchOffer({
        fromValues,
        toValues,
        joinCtx,
        preferredMapId: preferred.id,
      });
      return;
    }

    // No ApplyKeyMap yet — pick target (create new still available).
    const colHint = (joinCtx.leftOn[0] ?? joinCtx.rightOn[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const suggested =
      (colHint
        ? maps.find((m) => {
            const hay = `${m.id} ${m.name}`.toLowerCase();
            return colHint.length >= 3 && hay.includes(colHint);
          })
        : undefined) ?? maps[0]!;
    setMapPickChoice(suggested.id);
    setMapPickPending({ fromValues, toValues, joinCtx });
    setMapSwitchOffer(null);
  }

  function openMapPickerFromSwitchOffer() {
    if (!mapSwitchOffer) return;
    const { fromValues, toValues, joinCtx, preferredMapId } = mapSwitchOffer;
    setMapPickChoice(preferredMapId);
    setMapPickPending({
      fromValues,
      toValues,
      joinCtx,
      preferredMapId,
    });
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

  // Load app settings + global connections, then restore last project.
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
      let globalConns: ConnectionDef[] = [];
      try {
        globalConns = await getGlobalConnections();
      } catch {
        // First run / missing connections.json.
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
        setProject({
          ...emptyProject("Untitled", settings),
          connections: globalConns,
        });
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

  async function handleParseExport() {
    const path = project.last_dbt_export_path;
    if (!path) {
      setError("No export yet — File → Export dbt… first");
      return;
    }
    setOpProgress({
      kind: "parse",
      phase: "Validating project (dbt parse)…",
      percent: null,
    });
    try {
      const dest = projectDestination(project);
      const r = await parseExport(path, connections, dest.connection_id);
      if (r.ok) {
        setExportMsg(`dbt parse OK · ${path}`);
        setError(null);
      } else {
        setExportMsg(`dbt parse failed · ${path}`);
        setError(r.log || "dbt parse failed");
      }
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setOpProgress(null);
    }
  }

  async function handleBuildExport() {
    const path = project.last_dbt_export_path;
    if (!path) {
      setError("No export yet — File → Export dbt… first");
      return;
    }
    try {
      const dest = projectDestination(project);
      if (dest.kind === "postgres") {
        const dsn = connectionById(project, dest.connection_id)?.postgres
          ?.connection_string?.trim();
        if (!dsn) {
          setError(
            "Destination PostgreSQL connection has no DSN — set it in Connections, then Build again",
          );
          return;
        }
      }
      setOpProgress({
        kind: "build",
        phase:
          dest.kind === "postgres"
            ? "dbt build (seeds + models → destination)…"
            : "dbt build (seeds + models)…",
        percent: null,
      });
      const r = await buildExport(path, connections, dest.connection_id);
      if (r.ok) {
        setExportMsg(`dbt build OK · ${path}`);
        setError(null);
      } else {
        setExportMsg(`dbt build failed · ${path}`);
        setError(r.log || "dbt build failed");
      }
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setOpProgress(null);
    }
  }

  async function handleExportDbt() {
    if (!workspace) return;
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    const eng = projectEngine(project);
    const dest = projectDestination(project);
    const route =
      eng === dest.kind ? eng : `${eng}→${dest.kind}`;
    try {
      setOpProgress({
        kind: "export",
        phase: "Writing dbt project files…",
        percent: 15,
      });
      const result = await exportDbt(
        project.name.replace(/\s+/g, "_").toLowerCase() || "dwh_rs_query",
        workspace,
        dir,
        project.dbt_target,
        eng,
        connections,
        eng,
        dest.kind,
        dest.connection_id,
        dest.schema ?? "public",
        project.outputs ?? [],
        true,
      );
      setProject((p) => ({ ...p, last_dbt_export_path: result.path }));
      setExportFiles(result.files);
      setTreeExpanded((e) => ({ ...e, export: true }));
      const nFiles = result.files.filter((f) => !f.endsWith("/")).length;
      const base = `dbt ${project.dbt_target} · ${route} → ${result.path} (${nFiles} files)`;

      setOpProgress({
        kind: "export",
        phase: "dbt parse (author gate)…",
        percent: 55,
      });
      const parsed = await parseExport(
        result.path,
        connections,
        dest.connection_id,
      );
      setOpProgress({
        kind: "export",
        phase: parsed.ok ? "Done" : "Parse reported errors",
        percent: 100,
      });
      if (parsed.ok) {
        setExportMsg(`${base} · dbt parse OK`);
        setError(null);
      } else {
        setExportMsg(`${base} · dbt parse failed (files written)`);
        setError(
          parsed.log?.trim()
            ? parsed.log
            : "dbt parse failed (install ./scripts/fetch-dbt-venv.sh or put dbt on PATH)",
        );
      }
    } catch (e) {
      setExportMsg(null);
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setOpProgress(null);
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
      if (e.key === "Escape" && centerTab !== "canvas") {
        e.preventDefault();
        closeKeyMapTab(centerTab);
        return;
      }
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
        if (centerTab !== "canvas") {
          const tab = keyMapTabs.find((t) => t.map.id === centerTab);
          if (tab) {
            void saveKeyMapToProject(tab.map);
            return;
          }
        }
        void handleSaveProject();
      } else if ((e.ctrlKey || e.metaKey) && k === "o") {
        e.preventDefault();
        void handleOpenProject();
      } else if ((e.ctrlKey || e.metaKey) && (k === "=" || k === "+")) {
        e.preventDefault();
        void windowAction("zoom-in");
      } else if ((e.ctrlKey || e.metaKey) && k === "-") {
        e.preventDefault();
        void windowAction("zoom-out");
      } else if ((e.ctrlKey || e.metaKey) && k === "0") {
        e.preventDefault();
        void windowAction("zoom-reset");
      } else if (e.key === "F11") {
        e.preventDefault();
        void windowAction("toggle-fullscreen");
      } else if ((e.ctrlKey || e.metaKey) && k === "w") {
        e.preventDefault();
        void windowAction("close");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace, showPgPicker, project.name, project.dbt_target, centerTab, keyMapTabs]);

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
          rightQueryId: selectedStep.payload.right_query_id,
          leftOn: selectedStep.payload.left_on,
          rightOn: selectedStep.payload.right_on,
        }
      : null;

  /** Columns to pick from — prefer live preview of the active/focus query. */
  // When editing SelectColumns, load columns from the query truncated *before* that step
  // so the picker still lists fields that the step currently drops.
  useEffect(() => {
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      selectedStep?.type !== "SelectColumns"
    ) {
      setUpstreamColumnNames([]);
      return;
    }
    let cancelled = false;
    const hostId = activeQueryId;
    const upto = selectedStepIndex;
    const upstreamSteps =
      activeQuery?.steps.slice(0, upto) ?? [];
    if (upstreamSteps.length === 0) {
      setUpstreamColumnNames([]);
      return;
    }
    const leftWs: Workspace = {
      ...project.workspace,
      focus_query_id: hostId,
      queries: project.workspace.queries.map((q) =>
        q.id === hostId ? { ...q, steps: upstreamSteps } : q,
      ),
    };
    void previewWorkspace(leftWs, connections)
      .then((res) => {
        if (!cancelled) {
          setUpstreamColumnNames(res.columns.map((c) => c.name));
        }
      })
      .catch(() => {
        if (!cancelled) setUpstreamColumnNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeQueryId,
    activeQuery,
    selectedStepIndex,
    selectedStep?.type,
    project.workspace,
    connections,
  ]);

  const columnChoices = useMemo(() => {
    const fromUpstream =
      selectedStep?.type === "SelectColumns" && upstreamColumnNames.length > 0
        ? upstreamColumnNames
        : [];
    const fromPreview =
      preview && preview.columns.length > 0
        ? preview.columns.map((c) => c.name)
        : [];
    const fromStep =
      selectedStep?.type === "SelectColumns"
        ? selectedStep.payload.columns
        : [];
    // Prefer upstream-of-SelectColumns when editing that step; else live preview.
    const base =
      fromUpstream.length > 0 ? fromUpstream : fromPreview;
    return [...new Set([...base, ...fromStep, ...selectedColumns])];
  }, [
    preview,
    selectedStep,
    selectedColumns,
    upstreamColumnNames,
  ]);

  function addAvailableStep(kind: string) {
    if (!activeQuery) return;
    const peer = otherQueries[0]?.id ?? "";
    switch (kind) {
      case "Filter":
        appendStep({ type: "Filter", payload: { condition: "" } });
        break;
      case "SelectColumns": {
        // Keep all upstream columns by default (not a truncated subset).
        const cols =
          columnChoices.length > 0
            ? [...columnChoices]
            : (preview?.columns.map((c) => c.name) ?? []);
        if (cols.length === 0) {
          setError("Columns: wait for preview so the schema is known");
          return;
        }
        appendStep({
          type: "SelectColumns",
          payload: { columns: cols },
        });
        break;
      }
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
            setJoinKeyPairsBoth([emptyJoinKeyPair()]);
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
          payload: {
            name: "month",
            mode: "op",
            op: {
              id: "month_start",
              column: columnChoices.find((c) => /day|date|dt/i.test(c)) ??
                columnChoices[0] ??
                "day",
            },
            expression: "",
            sql_dialect: projectEngine(project),
          },
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
      case "NormalizeKey": {
        if (activeQuery.steps.length === 0) {
          setError("NormalizeKey needs a prior step");
          return;
        }
        const col = columnChoices[0] ?? "channel";
        appendStep({
          type: "NormalizeKey",
          payload: { columns: [col], ops: ["trim", "lower"] },
        });
        break;
      }
      case "ApplyKeyMap": {
        if (activeQuery.steps.length === 0) {
          setError("ApplyKeyMap needs a prior step");
          return;
        }
        const col = columnChoices[0] ?? "channel";
        const maps = project.workspace.key_maps ?? [];
        const map = maps[0] ?? emptyKeyMap("key map");
        if (!maps[0]) {
          saveKeyMapToProject(map);
        }
        appendStep({
          type: "ApplyKeyMap",
          payload: {
            column: col,
            map_id: map.id,
            entries: map.entries,
          },
        });
        openKeyMapEditor(map, { suggestedFrom: [] });
        break;
      }
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
    { id: "NormalizeKey", label: "NormalizeKey" },
    { id: "ApplyKeyMap", label: "ApplyKeyMap" },
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
      case "NormalizeKey":
        return "NormalizeKey";
      case "ApplyKeyMap":
        return "ApplyKeyMap";
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
        executionEngine={projectEngine(project)}
        destinationKind={projectDestination(project).kind}
        destinationConnectionId={projectDestination(project).connection_id}
        postgresConnections={project.connections.filter(
          (c) => c.kind === "postgres",
        )}
        routeBadge={`export · ${routeLabel(project)}`}
        canExport={Boolean(workspace) && !opProgress}
        canCopySql={canCopySql}
        sqlCopied={sqlCopied}
        onOpen={() => void handleOpenProject()}
        onSave={() => void handleSaveProject()}
        onSaveAs={() => void handleSaveProjectAs()}
        onExport={() => void handleExportDbt()}
        onParseExport={
          opProgress ? undefined : () => void handleParseExport()
        }
        onBuildExport={
          opProgress ? undefined : () => void handleBuildExport()
        }
        onViewData={() => setBottomTab("data")}
        onViewModel={() => setBottomTab("model")}
        onCopySql={() => void copySql()}
        onNewConnection={() => openNewConnection("postgres")}
        onSetExecutionEngine={handleSetExecutionEngine}
        onSetDestinationKind={handleSetDestinationKind}
        onSetDestinationConnection={handleSetDestinationConnection}
        onSetTargetDialect={(d: WarehouseDialect) =>
          void handleSetTargetDialect(d)
        }
        onLoadDemo={(id) => void handleLoadDemo(id)}
        onOpenHelp={() => setHelpOpen(true)}
        onZoomIn={() => void windowAction("zoom-in")}
        onZoomOut={() => void windowAction("zoom-out")}
        onZoomReset={() => void windowAction("zoom-reset")}
        onToggleFullscreen={() => void windowAction("toggle-fullscreen")}
        onCloseWindow={() => void windowAction("close")}
      />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {opProgress && <OpProgress state={opProgress} />}

      {mapPickPending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="map-pick-title"
          onClick={() => {
            setMapPickPending(null);
            setMapPickChoice(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0a1520] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="map-pick-title"
              className="text-base font-semibold text-slate-100"
            >
              Add unmatched key to a KeyMap
            </h2>
            <p className="mt-1.5 text-[13px] leading-snug text-slate-400">
              This value did not find a join partner. Pick a From→To table below,
              then <span className="text-slate-300">OK</span> opens a{" "}
              <span className="text-slate-300">KeyMap tab</span> (next to
              Pipeline canvas) — fill <span className="text-slate-300">To</span>{" "}
              there and press{" "}
              <span className="text-slate-300">Apply left</span> (inserts the
              map step before this Join).
            </p>
            <div className="mt-3 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-200/80">
                {mapPickPending.toValues?.some((t) => t.trim())
                  ? "Map pair"
                  : "Unmatched"}
                {mapPickPending.fromValues.length > 1
                  ? ` · ${mapPickPending.fromValues.length} keys`
                  : ""}
              </p>
              <p className="mt-0.5 font-mono text-[13px] text-amber-100">
                {mapPickPending.fromValues.slice(0, 8).map((from, i) => {
                  const to = mapPickPending.toValues?.[i]?.trim();
                  return to
                    ? `${JSON.stringify(from)} → ${JSON.stringify(to)}`
                    : JSON.stringify(from);
                }).join(", ")}
                {mapPickPending.fromValues.length > 8 ? "…" : ""}
              </p>
              {(mapPickPending.joinCtx.leftOn[0] ||
                mapPickPending.joinCtx.rightOn[0]) && (
                <p className="mt-1 font-mono text-[10px] text-slate-500">
                  join on{" "}
                  {mapPickPending.joinCtx.leftOn[0] ?? "?"}
                  {" = "}
                  {mapPickPending.joinCtx.rightOn[0] ?? "?"}
                </p>
              )}
            </div>
            <fieldset className="mt-3">
              <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Target KeyMap
              </legend>
              {mapPickPending.preferredMapId && (
                <p className="mt-1 text-[11px] text-teal-400/85">
                  Suggested: map already used by ApplyKeyMap on this Join.
                </p>
              )}
              <ul className="mt-1.5 max-h-52 space-y-1 overflow-auto">
                {(project.workspace.key_maps ?? []).map((m) => {
                  const selected = mapPickChoice === m.id;
                  const preferred =
                    mapPickPending.preferredMapId === m.id;
                  return (
                    <li key={m.id}>
                      <label
                        className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${
                          selected
                            ? "border-teal-600/70 bg-teal-500/10"
                            : preferred
                              ? "border-teal-900/50 bg-teal-950/20 hover:border-teal-800"
                              : "border-slate-800 bg-slate-950/60 hover:border-slate-600"
                        }`}
                      >
                        <input
                          type="radio"
                          name="map-pick-target"
                          className="mt-1 accent-teal-400"
                          checked={selected}
                          onChange={() => setMapPickChoice(m.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="block truncate text-sm font-medium text-slate-100">
                              {m.name}
                            </span>
                            {preferred && (
                              <span className="shrink-0 rounded border border-teal-800/60 px-1 py-0.5 text-[9px] uppercase tracking-wide text-teal-300/90">
                                ApplyKeyMap
                              </span>
                            )}
                          </span>
                          <span className="block font-mono text-[10px] text-slate-500">
                            {m.id} · {m.entries.length} row
                            {m.entries.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
                <li>
                  <label
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${
                      mapPickChoice === "__new__"
                        ? "border-teal-600/70 bg-teal-500/10"
                        : "border-slate-800 bg-slate-950/60 hover:border-slate-600"
                    }`}
                  >
                    <input
                      type="radio"
                      name="map-pick-target"
                      className="mt-1 accent-teal-400"
                      checked={mapPickChoice === "__new__"}
                      onChange={() => setMapPickChoice("__new__")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-100">
                        Create a new KeyMap
                      </span>
                      <span className="block text-[10px] text-slate-500">
                        Empty From→To table, then Apply on the join
                      </span>
                    </span>
                  </label>
                </li>
              </ul>
            </fieldset>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:text-slate-200"
                onClick={() => {
                  setMapPickPending(null);
                  setMapPickChoice(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!mapPickChoice}
                className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  const pending = mapPickPending;
                  const choice = mapPickChoice;
                  if (!choice) return;
                  setMapPickPending(null);
                  setMapPickChoice(null);
                  setMapSwitchOffer(null);
                  if (choice === "__new__") {
                    openMapWithFromValues(
                      {
                        ...emptyKeyMap("join aliases"),
                        entries: pending.fromValues.map((from, i) => ({
                          from,
                          to: pending.toValues?.[i] ?? "",
                        })),
                      },
                      pending.fromValues,
                      pending.joinCtx,
                      pending.toValues,
                    );
                    return;
                  }
                  const map = (project.workspace.key_maps ?? []).find(
                    (m) => m.id === choice,
                  );
                  if (!map) return;
                  openMapWithFromValues(
                    map,
                    pending.fromValues,
                    pending.joinCtx,
                    pending.toValues,
                  );
                }}
              >
                OK — open map
              </button>
            </div>
          </div>
        </div>
      )}

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
              selectedKeyMapId={selectedKeyMapId}
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
              onSelectKeyMap={(map) => {
                setSelectedKeyMapId(map.id);
                openKeyMapEditor(map);
              }}
              onAddKeyMap={handleAddKeyMap}
              onRenameKeyMap={handleRenameKeyMap}
              onDeleteKeyMap={handleDeleteKeyMap}
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

          {/* Canvas / KeyMap workspace tabs */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              role="tablist"
              aria-label="Workspace"
              className="flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-[var(--line)] bg-[#060d14]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={centerTab === "canvas"}
                onClick={() => {
                  setCenterTab("canvas");
                  setSelectedKeyMapId(null);
                }}
                className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  centerTab === "canvas"
                    ? "bg-[#0a1520] text-teal-200"
                    : "text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
                }`}
              >
                Pipeline canvas
              </button>
              {keyMapTabs.map((tab) => {
                const on = centerTab === tab.map.id;
                return (
                  <div
                    key={tab.map.id}
                    className={`group flex shrink-0 items-stretch border-r border-[var(--line)] ${
                      on ? "bg-[#0a1520]" : "hover:bg-slate-900/50"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => {
                        setCenterTab(tab.map.id);
                        setSelectedKeyMapId(tab.map.id);
                      }}
                      className={`max-w-[14rem] truncate px-3 py-2 text-left text-[12px] ${
                        on
                          ? "text-teal-100"
                          : "text-slate-500 group-hover:text-slate-300"
                      }`}
                      title={tab.map.name}
                    >
                      {tab.map.name || tab.map.id}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${tab.map.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeKeyMapTab(tab.map.id);
                      }}
                      className={`px-1.5 text-[14px] leading-none ${
                        on
                          ? "text-slate-500 hover:text-slate-200"
                          : "text-slate-700 opacity-0 group-hover:opacity-100 hover:text-slate-300"
                      }`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {keyMapTabs.map((keyMapEditor) => (
              <div
                key={keyMapEditor.map.id}
                className={
                  centerTab === keyMapEditor.map.id
                    ? "flex min-h-0 flex-1 flex-col p-3"
                    : "hidden"
                }
                aria-hidden={centerTab !== keyMapEditor.map.id}
              >
                <KeyMapEditor
                  map={keyMapEditor.map}
                  pickToOptions={keyMapEditor.pickTo}
                  suggestedFrom={keyMapEditor.suggestedFrom}
                  exportPath={project.last_dbt_export_path}
                  joinApplyHint={
                    keyMapEditor.joinCtx
                      ? `Fill To, then Apply left (typical) to remap ${
                          keyMapEditor.joinCtx.leftOn[0] ?? "key"
                        } before Join.`
                      : null
                  }
                  joinApplyContext={
                    keyMapEditor.joinCtx
                      ? {
                          hostQueryName:
                            project.workspace.queries.find(
                              (q) =>
                                q.id === keyMapEditor.joinCtx!.hostQueryId,
                            )?.name ?? keyMapEditor.joinCtx.hostQueryId,
                          rightQueryName:
                            project.workspace.queries.find(
                              (q) =>
                                q.id === keyMapEditor.joinCtx!.rightQueryId,
                            )?.name ?? keyMapEditor.joinCtx.rightQueryId,
                          leftOn:
                            keyMapEditor.joinCtx.leftOn[0] ?? "key",
                          rightOn:
                            keyMapEditor.joinCtx.rightOn[0] ?? "key",
                          probeSide: keyMapEditor.joinCtx.probeSide,
                        }
                      : null
                  }
                  onChooseOtherMap={
                    mapSwitchOffer &&
                    mapSwitchOffer.preferredMapId === keyMapEditor.map.id
                      ? () => openMapPickerFromSwitchOffer()
                      : undefined
                  }
                  postgresConnections={project.connections.filter(
                    (c) => c.kind === "postgres",
                  )}
                  sourceOptions={project.sources
                    .filter(
                      (s) =>
                        s.kind === "postgres" &&
                        Boolean(s.schema?.trim()) &&
                        Boolean(s.table_name?.trim()),
                    )
                    .map((s) => ({
                      source: s.schema!,
                      table: s.table_name!,
                      label: `${s.schema}.${s.table_name}${s.name ? ` · ${s.name}` : ""}`,
                    }))}
                  refOptions={project.workspace.queries.flatMap((q) => {
                    const stem = q.name
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_|_$/g, "");
                    return [stem, `stg_${stem}`, `int_${stem}`, `mart_${stem}`];
                  })}
                  onChange={(map) =>
                    patchKeyMapTab(keyMapEditor.map.id, (s) => ({
                      ...s,
                      map: { ...map, id: keyMapEditor.map.id },
                    }))
                  }
                  onWarehouseRead={(contentHash) =>
                    patchKeyMapTab(keyMapEditor.map.id, (s) => ({
                      ...s,
                      contentHash,
                    }))
                  }
                  onClose={() => closeKeyMapTab(keyMapEditor.map.id)}
                  onSave={
                    keyMapEditor.joinCtx
                      ? undefined
                      : () => {
                          void saveKeyMapToProject(keyMapEditor.map);
                        }
                  }
                  onDelete={
                    keyMapEditor.joinCtx
                      ? undefined
                      : () => {
                          if (
                            window.confirm(
                              `Delete KeyMap “${keyMapEditor.map.name}”? ApplyKeyMap steps that use it will be removed.`,
                            )
                          ) {
                            handleDeleteKeyMap(keyMapEditor.map.id);
                          }
                        }
                  }
                  saveLabel={
                    keyMapEditor.map.storage?.kind === "source"
                      ? "Save to warehouse"
                      : keyMapEditor.map.storage?.kind === "ref"
                        ? "Save to project"
                        : project.last_dbt_export_path
                          ? "Save → seed CSV"
                          : "Save map"
                  }
                  onApply={
                    keyMapEditor.joinCtx
                      ? (side) => {
                          const ctx = keyMapEditor.joinCtx!;
                          const map = keyMapEditor.map;
                          void saveKeyMapToProject(map).then(() => {
                            setProject((p) => ({
                              ...p,
                              workspace: applyKeyMapToWorkspace(
                                {
                                  ...p.workspace,
                                  key_maps: upsertKeyMapList(
                                    p.workspace.key_maps ?? [],
                                    map,
                                  ),
                                },
                                ctx.hostQueryId,
                                ctx.joinStepIndex,
                                ctx.rightQueryId,
                                side,
                                ctx.leftOn[0] ?? "key",
                                ctx.rightOn[0] ?? "key",
                                map,
                              ),
                            }));
                            closeKeyMapTab(map.id);
                            setCenterTab("canvas");
                          });
                        }
                      : undefined
                  }
                />
              </div>
            ))}

            {centerTab === "canvas" && (
              <>
            <div className="min-h-0 flex-1 px-3 pb-1 pt-2">
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
            <PanelResizeHandle
              orientation="horizontal"
              aria-label="Resize data panel"
              onDelta={(dy) =>
                setBottomDockHeight((h) => {
                  const next = clampPanelWidth(h - dy, 180, 720);
                  bottomDockHeightRef.current = next;
                  return next;
                })
              }
              onDragEnd={() => {
                try {
                  localStorage.setItem(
                    BOTTOM_DOCK_HEIGHT_KEY,
                    String(bottomDockHeightRef.current),
                  );
                } catch {
                  /* ignore */
                }
              }}
            />
            <div
              className="flex shrink-0 flex-col border-t border-[var(--line)] bg-[#060d14]"
              style={{ height: bottomDockHeight }}
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
                    <ErrorBanner
                      message={error}
                      onDismiss={() => setError(null)}
                    />
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
                      <div className="flex shrink-0 items-center gap-2">
                        {diagView.mapSide && joinLensTarget && (
                          <button
                            type="button"
                            className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-teal-800 hover:text-teal-200"
                            title="Map unmatched keys in Join Lens Probe (primary path)"
                            onClick={() => {
                              setDiagView(null);
                              setJoinLensOn(true);
                              setForceProbeNonce((n) => n + 1);
                            }}
                          >
                            Open in Probe
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-teal-300/80 hover:text-teal-100"
                          onClick={() => setDiagView(null)}
                        >
                          Back to preview
                        </button>
                      </div>
                    </div>
                  )}
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
                      <JoinLens
                        enabled={joinLensOn && !overlayOpen}
                        workspace={project.workspace}
                        hostQueryId={joinLensTarget.hostQueryId}
                        joinStepIndex={joinLensTarget.joinStepIndex}
                        rightQueryId={joinLensTarget.rightQueryId}
                        leftOn={joinLensTarget.leftOn}
                        rightOn={joinLensTarget.rightOn}
                        connections={connections}
                        columns={preview.columns}
                        rows={preview.rows}
                        joinDiag={joinDiag}
                        joinDiagLoading={joinDiagLoading}
                        forceProbeNonce={forceProbeNonce}
                        onApplyNearMiss={handleApplyNearMiss}
                        onMapKey={handleMapKeyFromLens}
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
              </>
            )}
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
                <label
                  className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300"
                  title="Export as mart_* and materialize to destination (Postgres when duckdb→postgres)"
                >
                  <input
                    type="checkbox"
                    className="rounded border-slate-600"
                    checked={isPublishedOutput(project, activeQuery.id)}
                    onChange={() =>
                      setProject((p) => togglePublishedOutput(p, activeQuery.id))
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
                          key={`sqlmodel-${selectedStepIndex}`}
                          ref={customSqlRef}
                          defaultValue={customSql}
                          rows={8}
                          spellCheck={false}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const raw =
                              customSqlRef.current?.value.trim() ??
                              customSql.trim();
                            setCustomSql(raw);
                            replaceStepAt(selectedStepIndex, {
                              type: "SqlModel",
                              payload: { raw_sql: raw },
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
                          key={`filter-${selectedStepIndex}-${filterCondition}`}
                          ref={filterInputRef}
                          type="text"
                          defaultValue={filterCondition}
                          onKeyDown={(e) => {
                            if (
                              e.key === "Enter" &&
                              selectedStepIndex !== null
                            ) {
                              const condition = e.currentTarget.value.trim();
                              setFilterCondition(condition);
                              replaceStepAt(selectedStepIndex, {
                                type: "Filter",
                                payload: { condition },
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
                            const condition =
                              filterInputRef.current?.value.trim() ??
                              filterCondition.trim();
                            setFilterCondition(condition);
                            replaceStepAt(selectedStepIndex, {
                              type: "Filter",
                              payload: { condition },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
                    {selectedStep.type === "SelectColumns" &&
                      selectedStepIndex !== null && (
                        <SelectColumnsEditor
                          key={`sc-${selectedStepIndex}-${selectedColumns.join(",")}`}
                          initialColumns={selectedColumns}
                          choices={columnChoices}
                          onApply={(columns) => {
                            setSelectedColumns(columns);
                            replaceStepAt(selectedStepIndex, {
                              type: "SelectColumns",
                              payload: { columns },
                            });
                          }}
                        />
                      )}
                    {selectedStep.type === "GroupBy" && (
                      <>
                        <input
                          key={`gdims-${selectedStepIndex}-${groupDims}`}
                          ref={groupDimsRef}
                          type="text"
                          defaultValue={groupDims}
                          placeholder="dimensions: region"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        />
                        <input
                          key={`gaggs-${selectedStepIndex}-${groupAggs}`}
                          ref={groupAggsRef}
                          type="text"
                          defaultValue={groupAggs}
                          placeholder="sum(qty) as qty"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const dimsRaw =
                              groupDimsRef.current?.value ?? groupDims;
                            const aggsRaw =
                              groupAggsRef.current?.value ?? groupAggs;
                            const dimensions = dimsRaw
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            const aggregates = aggsRaw
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean);
                            if (!dimensions.length || !aggregates.length) return;
                            setGroupDims(dimsRaw);
                            setGroupAggs(aggsRaw);
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
                          key={`jk-${selectedStepIndex}-${joinRightId}`}
                          initialPairs={joinKeyPairs}
                          onDraftChange={(p) => {
                            joinKeyDraftRef.current = p;
                          }}
                          leftColumns={joinLeftColumns}
                          rightColumns={joinRightColumns}
                          leftLoading={joinColsLoading}
                          rightLoading={joinColsLoading}
                        />
                        <button
                          type="button"
                          disabled={!joinRightId}
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25 disabled:opacity-40"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const draft = joinKeyDraftRef.current;
                            if (!joinPairsComplete(draft)) return;
                            const { left_on, right_on } = pairsToOn(draft);
                            setJoinKeyPairsBoth(draft);
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
                            key={`sort-${selectedStepIndex}-${sortCol}`}
                            ref={sortColRef}
                            list="inspector-cols"
                            defaultValue={sortCol}
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
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const column =
                              sortColRef.current?.value.trim() ??
                              sortCol.trim();
                            if (!column) return;
                            setSortCol(column);
                            replaceStepAt(selectedStepIndex, {
                              type: "SortBy",
                              payload: {
                                column,
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
                          key={`limit-${selectedStepIndex}-${limitN}`}
                          ref={limitNRef}
                          type="number"
                          min={1}
                          defaultValue={limitN}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const raw =
                              limitNRef.current?.value ?? limitN;
                            const n = Number.parseInt(raw, 10);
                            if (!Number.isFinite(n) || n < 1) return;
                            setLimitN(String(n));
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
                          key={`ren-from-${selectedStepIndex}-${renameFrom}`}
                          ref={renameFromRef}
                          defaultValue={renameFrom}
                          placeholder="from"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <input
                          key={`ren-to-${selectedStepIndex}-${renameTo}`}
                          ref={renameToRef}
                          defaultValue={renameTo}
                          placeholder="to"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const from =
                              renameFromRef.current?.value.trim() ??
                              renameFrom.trim();
                            const to =
                              renameToRef.current?.value.trim() ??
                              renameTo.trim();
                            if (!from || !to) return;
                            setRenameFrom(from);
                            setRenameTo(to);
                            replaceStepAt(selectedStepIndex, {
                              type: "RenameColumn",
                              payload: { from, to },
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
                          key={`der-name-${selectedStepIndex}-${deriveName}`}
                          ref={deriveNameRef}
                          defaultValue={deriveName}
                          placeholder="column name"
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <label className="block text-[10px] text-slate-500">
                          Mode
                          <select
                            value={deriveMode}
                            onChange={(e) =>
                              setDeriveMode(e.target.value as DeriveMode)
                            }
                            className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                          >
                            <option value="op">Ready-made operation</option>
                            <option value="sql">SQL expression</option>
                          </select>
                        </label>
                        {deriveMode === "op" ? (
                          <>
                            <select
                              value={deriveOpId}
                              onChange={(e) =>
                                setDeriveOpId(e.target.value as DeriveOpId)
                              }
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
                            >
                              <option value="month_start">
                                Month start (DATE)
                              </option>
                              <option value="year_month">
                                Year-month text (YYYY-MM)
                              </option>
                              <option value="coalesce_null">
                                Replace NULL
                              </option>
                              <option value="cast">Cast type</option>
                              <option value="col_diff">
                                Difference of two columns
                              </option>
                              <option value="trim_case">
                                Trim / lower / upper
                              </option>
                            </select>
                            <input
                              value={deriveOpCol}
                              onChange={(e) => setDeriveOpCol(e.target.value)}
                              placeholder="column"
                              list="derive-cols"
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                            />
                            <datalist id="derive-cols">
                              {columnChoices.map((c) => (
                                <option key={c} value={c} />
                              ))}
                            </datalist>
                            {deriveOpId === "col_diff" && (
                              <input
                                value={deriveOpColB}
                                onChange={(e) =>
                                  setDeriveOpColB(e.target.value)
                                }
                                placeholder="column_b"
                                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                              />
                            )}
                            {(deriveOpId === "coalesce_null" ||
                              deriveOpId === "cast") && (
                              <input
                                value={deriveOpValue}
                                onChange={(e) =>
                                  setDeriveOpValue(e.target.value)
                                }
                                placeholder={
                                  deriveOpId === "cast"
                                    ? "type (varchar, date…)"
                                    : "replacement"
                                }
                                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                              />
                            )}
                            <p className="text-[10px] text-slate-500">
                              Regenerates for {projectEngine(project)} on
                              export/preview. Edit as SQL to unlock free text.
                            </p>
                            <button
                              type="button"
                              className="w-full rounded-lg border border-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                              onClick={() => setDeriveMode("sql")}
                            >
                              Edit as SQL…
                            </button>
                          </>
                        ) : (
                          <>
                            <input
                              key={`der-expr-${selectedStepIndex}-${deriveExpr}`}
                              ref={deriveExprRef}
                              defaultValue={deriveExpr}
                              placeholder="SQL expression"
                              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                            />
                            <p className="text-[10px] text-amber-400/80">
                              Preview engine: {projectEngine(project)}.
                              Arbitrary SQL for another dialect is not
                              validated locally.
                            </p>
                          </>
                        )}
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const name =
                              deriveNameRef.current?.value.trim() ??
                              deriveName.trim();
                            if (!name) return;
                            if (deriveMode === "op") {
                              if (!deriveOpCol.trim()) return;
                              const op: DeriveOp = {
                                id: deriveOpId,
                                column: deriveOpCol.trim(),
                                column_b: deriveOpColB.trim() || undefined,
                                value: deriveOpValue.trim() || undefined,
                                case_mode:
                                  deriveOpId === "trim_case"
                                    ? "trim_lower"
                                    : undefined,
                              };
                              setDeriveName(name);
                              replaceStepAt(selectedStepIndex, {
                                type: "DeriveColumn",
                                payload: {
                                  name,
                                  mode: "op",
                                  op,
                                  expression: "",
                                  sql_dialect: projectEngine(project),
                                },
                              });
                            } else {
                              const expression =
                                deriveExprRef.current?.value.trim() ??
                                deriveExpr.trim();
                              if (!expression) return;
                              setDeriveName(name);
                              setDeriveExpr(expression);
                              replaceStepAt(selectedStepIndex, {
                                type: "DeriveColumn",
                                payload: {
                                  name,
                                  mode: "sql",
                                  expression,
                                  sql_dialect: projectEngine(project),
                                },
                              });
                            }
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
                          key={`customsql-${selectedStepIndex}`}
                          ref={customSqlRef}
                          defaultValue={customSql}
                          rows={5}
                          spellCheck={false}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100"
                        />
                        <button
                          type="button"
                          className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
                          onClick={() => {
                            if (selectedStepIndex === null) return;
                            const raw =
                              customSqlRef.current?.value.trim() ??
                              customSql.trim();
                            setCustomSql(raw);
                            replaceStepAt(selectedStepIndex, {
                              type: "CustomSql",
                              payload: { raw_sql: raw },
                            });
                          }}
                        >
                          Apply
                        </button>
                      </>
                    )}
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
                            key={`nk-cols-${selectedStepIndex}-${selectedStep.payload.columns.join(",")}`}
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
                            const el = document.getElementById(
                              "normalize-cols-input",
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
                            key={`akm-col-${selectedStepIndex}-${selectedStep.payload.column}`}
                            id="apply-keymap-col"
                            className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100"
                          />
                        </label>
                        <label className="block text-[10px] text-slate-500">
                          KeyMap
                          <select
                            value={selectedStep.payload.map_id}
                            onChange={(e) => {
                              const map_id = e.target.value;
                              const map = (
                                project.workspace.key_maps ?? []
                              ).find((m) => m.id === map_id);
                              replaceStepAt(selectedStepIndex, {
                                type: "ApplyKeyMap",
                                payload: {
                                  column: selectedStep.payload.column,
                                  map_id,
                                  entries: map?.entries ?? selectedStep.payload.entries ?? [],
                                },
                              });
                            }}
                            className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                          >
                            {(project.workspace.key_maps ?? []).length === 0 && (
                              <option value={selectedStep.payload.map_id}>
                                {selectedStep.payload.map_id}
                              </option>
                            )}
                            {(project.workspace.key_maps ?? []).map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({m.entries.length} rows)
                              </option>
                            ))}
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
                            const el = document.getElementById(
                              "apply-keymap-col",
                            ) as HTMLInputElement | null;
                            const column =
                              el?.value.trim() || selectedStep.payload.column;
                            replaceStepAt(selectedStepIndex, {
                              type: "ApplyKeyMap",
                              payload: {
                                ...selectedStep.payload,
                                column,
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
                            const map =
                              maps.find(
                                (m) => m.id === selectedStep.payload.map_id,
                              ) ?? {
                                id: selectedStep.payload.map_id,
                                name: selectedStep.payload.map_id,
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
