import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { labProject, projectFingerprint, replaceProject, type SwitchDecision } from "./app/projectLifecycle";
import { ProjectSwitchDialog } from "./components/ProjectSwitchDialog";
import { LabTaskCard } from "./components/LabTaskCard";
import { ownsLabTask, reconJoinTarget, startLabTask, type LabTaskSession } from "./help/reconLab";

function clampPanelWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

const BOTTOM_DOCK_HEIGHT_KEY = "dwh.bottomDockHeightPx";
const EXPLORER_COLLAPSED_KEY = "dwh.explorerCollapsed";
const INSPECTOR_COLLAPSED_KEY = "dwh.inspectorCollapsed";
/**
 * Minimum canvas strip when Join Lens / Data is maximized.
 * Intentionally tiny — drag the splitter up to give almost all height to the dock.
 */
const MIN_CANVAS_ABOVE_DOCK = 28;
const BOTTOM_DOCK_MIN = 160;
const BOTTOM_DOCK_HANDLE = 8;
/** Drag side panel below this width → fully collapse (VS Code sash snap). */
const SIDE_PANEL_COLLAPSE_SNAP = 96;

function loadCollapsedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function persistCollapsedFlag(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function loadBottomDockHeight(): number {
  try {
    const raw = localStorage.getItem(BOTTOM_DOCK_HEIGHT_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= BOTTOM_DOCK_MIN) return Math.round(n);
    }
  } catch {
    /* ignore */
  }
  return 360;
}

function clampBottomDockHeight(px: number, stackHeight: number): number {
  if (stackHeight <= 0) {
    return Math.max(BOTTOM_DOCK_MIN, Math.round(px));
  }
  const maxForStack = Math.max(
    BOTTOM_DOCK_MIN,
    stackHeight - MIN_CANVAS_ABOVE_DOCK - BOTTOM_DOCK_HANDLE,
  );
  return clampPanelWidth(px, BOTTOM_DOCK_MIN, maxForStack);
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
import { HelpLab } from "./components/HelpLab";
import { HELP_LAB_TAB } from "./help/labCatalog";
import { OptionsDialog } from "./components/OptionsDialog";
import { DbtSetupDialog } from "./components/DbtSetupDialog";
import { ExplorerTree } from "./components/ExplorerTree";
import {
  collectExternalBoundaries,
  newQueryFromExternal,
  parseTargetKey,
  resolveOwnerPath,
  workspaceFocusingObject,
} from "./lib/projectRefs";
import { HiveParquetDialog } from "./components/HiveParquetDialog";
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
import { MatchingWorkspace } from "./components/MatchingWorkspace";
import { buildLensMatchingPlan } from "./app/matching/planDefaults";
import {
  emptyMatchingSession,
  newMatchingSessionId,
  type MatchingTabSession,
} from "./app/matching/types";
import { MappingQualityOverview } from "./components/mapping-quality/MappingQualityOverview";
import { MappingCheckSetupDialog } from "./components/MappingCheckSetupDialog";
import {
  QUALITY_INSPECTION,
  QUALITY_TAB,
  isFullQualityJoin,
  isMappingQualityLab,
  isQualityInspectionQuery,
  stripQualityInspectionQueries,
  upsertQualityInspection,
} from "./lib/mappingQuality";
import {
  ensureLabCheck,
  keyMapRevision,
  labMappingCheck,
  normalizeAttrsProjection,
  resolveInspectJoinLensTarget,
  type FrozenRemapPreview,
} from "./lib/mappingCheck";
import {
  HeavyPreviewCache,
  heavyPreviewCacheKey,
  isHeavyPreviewFocus,
  PREVIEW_SAMPLE_LIMIT,
  workspaceForPreviewTransport,
  type HeavyPreviewMode,
} from "./lib/previewTransport";
import type {
  MappingCheck,
  MappingCheckProjection,
} from "./types/mappingCheck";
import {
  allowCheckDifference,
  appendMappingCheck,
  applyConfirmRemapOntoProject,
  confirmContextStillValid,
  confirmFrozenCheckRemap as confirmFrozenCheckRemapSvc,
  createMappingCheck,
  findJoinHostsForMap,
  inferCheckAttrsFromJoin,
  planCheckInspect,
  recordCheckRun,
  resolveActiveMappingCheck,
  resolveAttrsJoinBinding,
  stageFrozenRemapChanges,
  updateMappingCheckProjection,
  type ConfirmRemapApplyIntent,
  type ConfirmRemapApplyResult,
  type InferredCheckAttrs,
} from "./app/mappingChecks";
import {
  applyMappingCreateOntoProject,
  type MappingCreateApplyIntent,
  type MappingCreateApplyResult,
  type MappingCreatePlan,
} from "./app/mappingCreate";
import { MappingCreateWizard } from "./components/MappingCreateWizard";
import { importWriteRefusal } from "./lib/pgImport";
import {
  applyKeyMapOntoProject,
  dirtyDeltaHasChanges,
  mergeFromValuesIntoMap,
  planMapFillFromLens,
  applyKeyMapTabMapChange,
  keyMapBindingFingerprint,
  keyMapEntriesFingerprint,
  mergeKeyMapTabSession,
  settleSeedDraftAfterSave,
  normalizeKeyMapForEditor,
  refSaveResult,
  resolveJoinStepFromCtx,
  seedSaveResult,
  sourceSaveFailed,
  sourceSaveSkipped,
  sourceSaveSynced,
  upsertKeyMapIntoProject,
  intentFromApplyPlan,
  resolveApplyPlan,
  type KeyMapApplyIntent,
  type KeyMapApplyResult,
  type KeyMapTabSession,
} from "./app/keyMap";
import { isHostCancelled } from "./lib/hostRpc";
import {
  createRequestGen,
  isCurrentRequest,
  nextRequestGen,
} from "./lib/requestGen";
import {
  applyNormalizeToWorkspace,
  deleteKeyMapFromWorkspace,
  emptyKeyMap,
  findApplyKeyMapIdForJoin,
  resolveKeyMapConnection,
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
import { PgImportWizard } from "./components/PgImportWizard";
import { PreviewTable } from "./components/PreviewTable";
import { S3SourceDialog } from "./components/S3SourceDialog";
import { SelectColumnsEditor } from "./components/SelectColumnsEditor";
import { SourceSchemaPanel } from "./components/SourceSchemaPanel";
import { debounce } from "./lib/debounce";
import { bindFilePath } from "./lib/filePath";
import {
  cancelRunningQuery,
  describePostgresObject,
  describeWorkspace,
  exportDbt,
  joinDiagnostics,
  formatJoinPrepareHint,
  formatJoinPrepareStatusHint,
  joinPrepareProgress,
  joinPrepareStatus,
  listExportTree,
  dbtSetupStatus,
  getAppSettings,
  type DbtSetupStatus,
  getGlobalConnections,
  getLastProjectPath,
  copyReferencedObject,
  loadProject,
  loadDemoWorkspace,
  prepareJoinInputs,
  previewDbtModel,
  previewWorkspace,
  projectRefContext,
  pushKeyMapToExport,
  pushRecentProject,
  makeProjectReference,
  referenceConsumers,
  referenceStatuses,
  refreshReference,
  relinkReference,
  removeKeyMapFromExport,
  saveProject,
  type ReferenceStatus,
  setAppSettings,
  setGlobalConnections,
  syncKeyMapsFromExport,
  readKeyMap,
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
  externalTarget,
  isExternalTarget,
  newId,
  targetKey,
  togglePublishedOutput,
  type ObjectTarget,
  type ProjectReference,
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
  parquetSourceName,
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

/** Stable default — inline `{ kind: "lab_v1" }` in JSX re-triggers overview effects. */
const LAB_V1_PROJECTION: MappingCheckProjection = { kind: "lab_v1" };

type ProjectBag = {
  project: Project;
  /** Set by apply_keymap; cleared after UI handles close/error. */
  keyMapApplyResult: KeyMapApplyResult | null;
  /** Set by confirm_remap; cleared after UI handles save/error. */
  confirmRemapResult: ConfirmRemapApplyResult | null;
  /** Set by create_mapping; cleared after editor handoff. */
  mappingCreateResult: MappingCreateApplyResult | null;
};

type ProjectBagAction =
  | { type: "set"; updater: (p: Project) => Project }
  | { type: "apply_keymap"; intent: KeyMapApplyIntent }
  | { type: "clear_keymap_apply_result" }
  | { type: "confirm_remap"; intent: ConfirmRemapApplyIntent }
  | { type: "clear_confirm_remap_result" }
  | { type: "create_mapping"; intent: MappingCreateApplyIntent }
  | { type: "clear_mapping_create_result" };

function projectBagReducer(
  state: ProjectBag,
  action: ProjectBagAction,
): ProjectBag {
  switch (action.type) {
    case "set":
      return { ...state, project: action.updater(state.project) };
    case "apply_keymap": {
      const { project, result } = applyKeyMapOntoProject(
        state.project,
        action.intent,
      );
      return { ...state, project, keyMapApplyResult: result };
    }
    case "clear_keymap_apply_result":
      return { ...state, keyMapApplyResult: null };
    case "confirm_remap": {
      const { project, result } = applyConfirmRemapOntoProject(
        state.project,
        action.intent,
      );
      return { ...state, project, confirmRemapResult: result };
    }
    case "clear_confirm_remap_result":
      return { ...state, confirmRemapResult: null };
    case "create_mapping": {
      const { project, result } = applyMappingCreateOntoProject(
        state.project,
        action.intent,
      );
      return { ...state, project, mappingCreateResult: result };
    }
    case "clear_mapping_create_result":
      return { ...state, mappingCreateResult: null };
    default:
      return state;
  }
}

function App() {
  const [projectBag, dispatchProject] = useReducer(projectBagReducer, {
    project: emptyProject("Untitled"),
    keyMapApplyResult: null,
    confirmRemapResult: null,
    mappingCreateResult: null,
  });
  const project = projectBag.project;
  const projectRef = useRef(project);
  projectRef.current = project;
  const savedProjectFingerprint = useRef<string | null | undefined>(undefined);
  if (savedProjectFingerprint.current === undefined) {
    savedProjectFingerprint.current = projectFingerprint(project);
  }
  const projectSaveInFlight = useRef(false);
  const mapWritesInFlight = useRef(0);
  const projectSwitchInFlight = useRef(false);
  const [switchChoice, setSwitchChoice] = useState<((decision: SwitchDecision) => void) | null>(null);
  const [labTask, setLabTask] = useState<LabTaskSession | null>(null);
  const activeLabTask = ownsLabTask(labTask, project.project_uid) ? labTask : null;
  const setProject = useCallback((update: SetStateAction<Project>) => {
    dispatchProject({
      type: "set",
      updater: typeof update === "function" ? update : () => update,
    });
  }, []);
  const [appSettings, setAppSettingsState] = useState<AppSettings>({
    default_target_dialect: "duckdb",
    default_dbt_target: "v1",
    default_execution_engine: "duckdb",
    default_destination_kind: "duckdb",
    dbt_venv_path: "",
    recent_projects: [],
    explorer_width_px: 240,
    inspector_width_px: 300,
    llm: {
      base_url: "",
      model: "",
      api_key: "",
    },
  });
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [bottomDockHeight, setBottomDockHeight] = useState(loadBottomDockHeight);
  const bottomDockHeightRef = useRef(bottomDockHeight);
  bottomDockHeightRef.current = bottomDockHeight;
  /** Canvas + dock stack (below workspace tabs) — used to keep the splitter on-screen. */
  const canvasDockStackRef = useRef<HTMLDivElement>(null);
  /** Height before last “maximize Join Lens / Data” double-click. */
  const bottomDockRestoreRef = useRef<number | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(300);
  const [explorerCollapsed, setExplorerCollapsed] = useState(() =>
    loadCollapsedFlag(EXPLORER_COLLAPSED_KEY),
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() =>
    loadCollapsedFlag(INSPECTOR_COLLAPSED_KEY),
  );
  const explorerWidthRef = useRef(explorerWidth);
  const inspectorWidthRef = useRef(inspectorWidth);
  explorerWidthRef.current = explorerWidth;
  inspectorWidthRef.current = inspectorWidth;

  function setExplorerCollapsedPersist(next: boolean) {
    setExplorerCollapsed(next);
    persistCollapsedFlag(EXPLORER_COLLAPSED_KEY, next);
  }
  function setInspectorCollapsedPersist(next: boolean) {
    setInspectorCollapsed(next);
    persistCollapsedFlag(INSPECTOR_COLLAPSED_KEY, next);
  }

  function maximizeBottomDock() {
    const stackH = canvasDockStackRef.current?.clientHeight ?? 0;
    if (stackH <= 0) return;
    const maxH = clampBottomDockHeight(stackH, stackH);
    setBottomDockHeight((h) => {
      if (h < maxH - 12) bottomDockRestoreRef.current = h;
      bottomDockHeightRef.current = maxH;
      try {
        localStorage.setItem(BOTTOM_DOCK_HEIGHT_KEY, String(maxH));
      } catch {
        /* ignore */
      }
      return maxH;
    });
  }

  function focusJoinLensLayout() {
    setExplorerCollapsedPersist(true);
    setInspectorCollapsedPersist(true);
    setJoinLensOn(true);
    setBottomTab("data");
    setCenterTab("canvas");
    maximizeBottomDock();
  }

  /** Canvas from the quality lab without scheduling the 100K join preview/IPC. */
  function openMappingQualityCanvas() {
    if (isFullQualityJoin(activeQueryId)) {
      setActiveQueryId("quality_catalog");
      setSelectedStepIndex(0);
      setJoinLensOn(false);
      setPreview(null);
    } else if (isQualityInspectionQuery(activeQueryId)) {
      // Re-entering canvas with an Inspect cohort: keep Join selected so DATA
      // mounts Join Lens instead of an empty post-Filter PreviewTable.
      const q = queries.find((x) => x.id === activeQueryId);
      const joinIdx = q?.steps.findIndex((s) => s.type === "Join") ?? -1;
      if (joinIdx >= 0) {
        setSelectedStepIndex(joinIdx);
        setJoinLensOn(true);
        setBottomTab("data");
      }
    }
    setCenterTab("canvas");
    setSelectedKeyMapId(null);
  }

  type CheckSetupState = {
    mode: "create" | "edit";
    mapId: string;
    mapName: string;
    hostQueryId: string;
    hostName: string;
    joinStepIndex: number;
    leftOn: string[];
    rightOn: string[];
    rightQueryId: string;
    leftColumns: string[];
    rightColumns: string[];
    inferred: InferredCheckAttrs;
    checkId?: string;
    initial?: {
      leftAttrs: string[];
      rightAttrs: string[];
      sampleColumns: string[];
    } | null;
  };
  const [checkSetup, setCheckSetup] = useState<CheckSetupState | null>(null);

  async function openMappingCheckSetup(opts?: {
    mapId?: string;
    hostQueryId?: string;
    joinStepIndex?: number;
    mode?: "create" | "edit";
    checkId?: string;
  }) {
    const keyMaps = project.workspace.key_maps ?? [];
    const map =
      (opts?.mapId
        ? keyMaps.find((m) => m.id === opts.mapId)
        : null) ??
      (selectedKeyMapId
        ? keyMaps.find((m) => m.id === selectedKeyMapId)
        : null) ??
      keyMaps[0];
    if (!map) {
      setError("Add a Mapping before creating a mapping check.");
      return;
    }
    const hosts = findJoinHostsForMap(queries, map.id);
    if (!hosts.length) {
      setError(
        `No Join query applies Mapping “${map.name}”. Apply the map on a Join host first, then create the check.`,
      );
      return;
    }
    let hostHit = hosts[0]!;
    if (opts?.hostQueryId != null && opts.joinStepIndex != null) {
      const exact = hosts.find(
        (h) =>
          h.host.id === opts.hostQueryId &&
          h.joinStepIndex === opts.joinStepIndex,
      );
      if (!exact) {
        setError(
          `Join on “${opts.hostQueryId}” is not wired to map “${map.name}”.`,
        );
        return;
      }
      hostHit = exact;
    } else if (hosts.length > 1) {
      const onActiveStep =
        activeQueryId && selectedStepIndex != null
          ? hosts.find(
              (h) =>
                h.host.id === activeQueryId &&
                h.joinStepIndex === selectedStepIndex,
            )
          : undefined;
      const onActiveQuery =
        !onActiveStep && activeQueryId
          ? hosts.filter((h) => h.host.id === activeQueryId)
          : [];
      const resolved =
        onActiveStep ??
        (onActiveQuery.length === 1 ? onActiveQuery[0] : undefined);
      if (!resolved) {
        setError(
          `“${map.name}” is wired to ${hosts.length} Joins — select the Join step on the canvas, then create the check again.`,
        );
        return;
      }
      hostHit = resolved;
    }
    const joinStep = hostHit.host.steps[hostHit.joinStepIndex];
    if (!joinStep || joinStep.type !== "Join") {
      setError("Selected host Join step is missing.");
      return;
    }
    const rightQueryId = targetKey(joinStep.payload.right_query_id);
    try {
      const cols = await fetchJoinSideColumns(
        hostHit.host.id,
        rightQueryId,
        hostHit.joinStepIndex,
      );
      const leftColumns = cols.left.map((c) => c.name);
      const rightColumns = cols.right.map((c) => c.name);
      const inferred = inferCheckAttrsFromJoin({
        map,
        leftOn: hostHit.leftOn,
        rightOn: hostHit.rightOn,
        leftColumns,
        rightColumns,
      });
      let initial: CheckSetupState["initial"] = null;
      if (opts?.mode === "edit" && opts.checkId) {
        const existing = (project.mapping_checks ?? []).find(
          (c) => c.id === opts.checkId,
        );
        if (existing?.projection.kind === "attrs") {
          const n = normalizeAttrsProjection(existing.projection);
          if (n.kind === "attrs") {
            initial = {
              leftAttrs: n.left_attrs,
              rightAttrs: n.right_attrs,
              sampleColumns: n.sample_columns,
            };
          }
        }
      }
      setCheckSetup({
        mode: opts?.mode ?? "create",
        mapId: map.id,
        mapName: map.name,
        hostQueryId: hostHit.host.id,
        hostName: hostHit.host.name,
        joinStepIndex: hostHit.joinStepIndex,
        leftOn: hostHit.leftOn,
        rightOn: hostHit.rightOn,
        rightQueryId,
        leftColumns,
        rightColumns,
        inferred,
        checkId: opts?.checkId,
        initial,
      });
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  function confirmMappingCheckSetup(result: {
    leftAttrs: string[];
    rightAttrs: string[];
    sampleColumns: string[];
  }) {
    if (!checkSetup) return;
    if (checkSetup.mode === "edit" && checkSetup.checkId) {
      const updated = updateMappingCheckProjection(
        project.mapping_checks ?? [],
        checkSetup.checkId,
        {
          kind: "attrs",
          host_query_id: checkSetup.hostQueryId,
          left_attr: result.leftAttrs[0] ?? "",
          right_attr: result.rightAttrs[0] ?? "",
          sample_column: result.sampleColumns[0] ?? result.leftAttrs[0] ?? "",
          left_attrs: result.leftAttrs,
          right_attrs: result.rightAttrs,
          sample_columns: result.sampleColumns,
        },
      );
      if (!updated.ok) {
        setError(updated.error);
        return;
      }
      setProject((p) => ({ ...p, mapping_checks: updated.mapping_checks }));
      setCheckDeltaNote(updated.note);
      setCheckSetup(null);
      setCenterTab(QUALITY_TAB);
      setError(null);
      return;
    }
    const created = createMappingCheck({
      checks: project.mapping_checks ?? [],
      keyMaps: project.workspace.key_maps ?? [],
      queries,
      mapId: checkSetup.mapId,
      hostQueryId: checkSetup.hostQueryId,
      joinStepIndex: checkSetup.joinStepIndex,
      leftAttrs: result.leftAttrs,
      rightAttrs: result.rightAttrs,
      sampleColumns: result.sampleColumns,
    });
    if (!created.ok) {
      setError(created.error);
      return;
    }
    setProject((p) => appendMappingCheck(p, created.check));
    setCheckSetup(null);
    setCenterTab(QUALITY_TAB);
    setCheckDeltaNote(created.note);
    setError(null);
  }

  const activeMappingCheck: MappingCheck | null = resolveActiveMappingCheck(
    project.mapping_checks,
  );

  const attrsJoinForActiveCheck = useMemo(() => {
    if (!activeMappingCheck) return null;
    const b = resolveAttrsJoinBinding(
      project.workspace.queries,
      activeMappingCheck,
    );
    if (!b) return null;
    return {
      joinStepIndex: b.joinStepIndex,
      rightQueryId: b.rightQueryId,
      leftOn: b.leftOn,
      rightOn: b.rightOn,
    };
  }, [activeMappingCheck, project.workspace.queries]);

  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [selectedExternalKey, setSelectedExternalKey] = useState<string | null>(
    null,
  );
  const [refStatuses, setRefStatuses] = useState<ReferenceStatus[]>([]);
  const [refCatalogs, setRefCatalogs] = useState<
    Record<
      string,
      {
        alias: string;
        queries: { id: string; name: string }[];
        maps: { id: string; name: string }[];
      }
    >
  >({});
  /** Electron has no `window.prompt` — alias is collected in-app. */
  const [addRefPending, setAddRefPending] = useState<{
    consumerPath: string;
    ownerPath: string;
    alias: string;
  } | null>(null);
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
  const [joinPrepareLoading, setJoinPrepareLoading] = useState(false);
  /** Prepare started from Join Lens (separate from panel Prepare). */
  const [lensPrepareBusy, setLensPrepareBusy] = useState(false);
  const [joinPrepareLabel, setJoinPrepareLabel] = useState<string | null>(
    null,
  );
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
  /** Bump after mapping-quality Inspect so Join Lens auto-runs Load sides. */
  const [autoPrepareNonce, setAutoPrepareNonce] = useState(0);
  /** Pin Join Lens This-row to overview sample (commercial_sku), not join ON. */
  const [lensFocusHint, setLensFocusHint] = useState<{
    column: string;
    value: string;
  } | null>(null);
  /** Inspect clicked — keep progress until Join Lens prepare takes over. */
  const qualityHandoffRef = useRef(false);
  /** ADR-0027 frozen batch remap (session). */
  const [frozenRemap, setFrozenRemap] = useState<FrozenRemapPreview | null>(
    null,
  );
  const [checkDeltaNote, setCheckDeltaNote] = useState<string | null>(null);
  const [checkAllowNote, setCheckAllowNote] = useState<string | null>(null);
  const lastCheckRunFingerprint = useRef<string | null>(null);
  /** Open KeyMap editor tabs (VS Code–style, beside Pipeline canvas). */
  const [keyMapTabs, setKeyMapTabs] = useState<KeyMapTabSession[]>([]);
  /** ADR-0044 Matching workspace tabs (in-process draft only). */
  const [matchingTabs, setMatchingTabs] = useState<MatchingTabSession[]>([]);
  const matchingTabKey = (id: string) => `matching:${id}`;
  const matchingDirty = matchingTabs.some((t) => t.hasUnsavedDecisions);
  const matchingTabsLiveRef = useRef(matchingTabs);
  matchingTabsLiveRef.current = matchingTabs;

  useEffect(() => {
    if (!matchingDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [matchingDirty]);
  /** Live snapshots for post-await Confirm revalidation. */
  const projectLiveRef = useRef(project);
  projectLiveRef.current = project;
  const frozenRemapLiveRef = useRef(frozenRemap);
  frozenRemapLiveRef.current = frozenRemap;
  const keyMapTabsLiveRef = useRef(keyMapTabs);
  keyMapTabsLiveRef.current = keyMapTabs;
  /** One Confirm at a time — no parallel WH reads / double publish. */
  const confirmRemapInFlightRef = useRef(false);
  const [confirmRemapBusy, setConfirmRemapBusy] = useState(false);
  /** Matches reducer result.opId so effects ignore superseded confirms. */
  const pendingConfirmOpIdRef = useRef<string | null>(null);
  const [mappingCreateOpen, setMappingCreateOpen] = useState(false);
  const pendingMappingCreateOpIdRef = useRef<string | null>(null);
  /** Center workspace tab: canvas or open KeyMap id. */
  const [centerTab, setCenterTab] = useState<"canvas" | string>("canvas");
  /** True while the graph↔dock splitter is dragged — skip RO clamp (avoids RO loop). */
  const dockDraggingRef = useRef(false);
  const dockHeightRafRef = useRef(0);
  const stackClampRafRef = useRef(0);

  useEffect(() => {
    if (centerTab !== "canvas") return;
    const el = canvasDockStackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const clampToStack = () => {
      if (dockDraggingRef.current) return;
      const stackH = el.clientHeight;
      if (stackH <= 0) return;
      setBottomDockHeight((h) => {
        const next = clampBottomDockHeight(h, stackH);
        if (next === h) return h;
        bottomDockHeightRef.current = next;
        return next;
      });
    };
    clampToStack();
    // Defer: sync setState inside RO → "ResizeObserver loop completed…".
    const ro = new ResizeObserver(() => {
      if (dockDraggingRef.current) return;
      if (stackClampRafRef.current) return;
      stackClampRafRef.current = requestAnimationFrame(() => {
        stackClampRafRef.current = 0;
        clampToStack();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (stackClampRafRef.current) {
        cancelAnimationFrame(stackClampRafRef.current);
        stackClampRafRef.current = 0;
      }
    };
  }, [centerTab]);
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
  /** Sample (LIMIT 50) vs explicit full preview for heavy focuses (ADR-0041). */
  const [previewMode, setPreviewMode] = useState<HeavyPreviewMode>("sample");
  const heavyPreviewCacheRef = useRef(new HeavyPreviewCache());
  const [modelPreview, setModelPreview] = useState<PreviewDbtModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Monotonic id so a slow preview for node A cannot overwrite node B (ADR-0031). */
  const previewReqGenRef = useRef(createRequestGen());
  /** Bottom dock: sample rows vs generated model SQL (H0 projection; H1 editable later). */
  const [bottomTab, setBottomTab] = useState<"data" | "model">("data");
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportFiles, setExportFiles] = useState<string[]>([]);
  const [opProgress, setOpProgress] = useState<OpProgressState | null>(null);
  /** Add to map… — choose which KeyMap when several exist. */
  const [mapPickPending, setMapPickPending] = useState<{
    fromValues: string[];
    toValues?: string[];
    fromParts?: string[][];
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
    fromParts?: string[][];
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
  const [showPgImport, setShowPgImport] = useState(false);
  const [pgImportConnectionId, setPgImportConnectionId] = useState<string | null>(
    null,
  );
  const [showS3Dialog, setShowS3Dialog] = useState(false);
  const [showHiveDialog, setShowHiveDialog] = useState(false);
  /** Dialog outcome: catalog-only source vs source+query. */
  const [pickerIntent, setPickerIntent] = useState<"source" | "query">("query");
  const [connEditorOpen, setConnEditorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [dbtSetupOpen, setDbtSetupOpen] = useState(false);
  const [dbtSetupStatusState, setDbtSetupStatusState] =
    useState<DbtSetupStatus | null>(null);
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
    // Exception: Mapping-quality Inspect — keep post-Join Filter/Sort so DATA is
    // the cohort (otherwise LIMIT 50 of the unfiltered Join lands on unrelated rows).
    if (
      q &&
      selectedStepIndex != null &&
      q.steps[selectedStepIndex]?.type === "Join" &&
      !isQualityInspectionQuery(id)
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
          // Preserve key_maps and other workspace fields (mapping-quality lab, etc.).
          workspace: { ...p.workspace, queries: nextQueries, focus_query_id: focus },
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

  const connections = project.connections ?? [];
  const sources = project.sources ?? [];

  const onQualityProgress = useCallback(
    (state: { phase: string; percent: number } | null) => {
      if (!state) {
        setOpProgress((cur) =>
          cur?.kind === "quality" ? null : cur,
        );
        return;
      }
      setOpProgress({
        kind: "quality",
        phase: state.phase,
        percent: state.percent,
      });
    },
    [],
  );

  const runPreview = useCallback(
    async (
      ws: Workspace,
      conns: ConnectionDef[],
      srcs: SourceDef[] = [],
      projectRef = projectRefContext(project),
      mode: HeavyPreviewMode = "sample",
    ) => {
      // v1: always structural DuckDB preview (ADR-0014). Native "Run on warehouse" = later.
      const focus = ws.focus_query_id;
      const heavy = Boolean(focus && isHeavyPreviewFocus(ws, focus));
      if (heavy && focus) {
        const cached = heavyPreviewCacheRef.current.get(
          heavyPreviewCacheKey(ws, focus, mode),
        );
        if (cached) {
          setPreview(cached);
          setPreviewMode(mode);
          setError(null);
          setLoading(false);
          return;
        }
      }
      const reqId = nextRequestGen(previewReqGenRef.current);
      setLoading(true);
      try {
        // Drop unused seed KeyMap rows from IPC (95k lab map on a CSV click).
        // Needed maps keep full entries — we do not permanently shrink lab data.
        const transport = workspaceForPreviewTransport(ws);
        const result = await previewWorkspace(
          transport,
          conns,
          srcs,
          projectRef,
          mode === "full"
            ? { fullPreview: true }
            : { rowLimit: PREVIEW_SAMPLE_LIMIT },
        );
        if (!isCurrentRequest(previewReqGenRef.current, reqId)) return;
        if (heavy && focus) {
          heavyPreviewCacheRef.current.set(
            heavyPreviewCacheKey(ws, focus, mode),
            result,
          );
        }
        setPreview(result);
        setPreviewMode(mode);
        setError(null);
      } catch (e) {
        if (!isCurrentRequest(previewReqGenRef.current, reqId)) return;
        const msg = typeof e === "string" ? e : String(e);
        // Preempted by a newer preview / prepare — keep UI quiet.
        if (isHostCancelled(e)) {
          return;
        }
        setPreview(null);
        setError(msg);
      } finally {
        if (isCurrentRequest(previewReqGenRef.current, reqId)) {
          setLoading(false);
        }
      }
    },
    [project],
  );

  const centerTabRef = useRef(centerTab);
  centerTabRef.current = centerTab;

  const debouncedPreview = useMemo(
    () =>
      debounce((ws: Workspace, conns: ConnectionDef[], srcs: SourceDef[]) => {
        // Pending debounce can fire after switching to the quality overview tab.
        if (
          centerTabRef.current === QUALITY_TAB ||
          centerTabRef.current === HELP_LAB_TAB
        ) {
          return;
        }
        // Auto path is always the sample LIMIT (ADR-0041).
        void runPreview(
          ws,
          conns,
          srcs,
          projectRefContext(projectRef.current),
          "sample",
        );
      }, 150),
    [runPreview],
  );

  const overlayOpen =
    switchChoice !== null ||
    connEditorOpen ||
    helpOpen ||
    optionsOpen ||
    showPgPicker ||
    showPgImport ||
    showS3Dialog ||
    showHiveDialog ||
    Boolean(mapPickPending) ||
    Boolean(addRefPending);

  useEffect(() => {
    // Don't fight the modal for main-thread / DuckDB while a dialog has focus.
    // Mapping quality overview owns preview while its tab is open (same preemptible lane).
    if (
      overlayOpen ||
      centerTab === QUALITY_TAB ||
      centerTab === HELP_LAB_TAB ||
      !dataWorkspace
    ) {
      return;
    }
    // Heavy focuses still auto-sample (LIMIT 50). Full is on demand (ADR-0041).
    // Unused seed maps are stripped in workspaceForPreviewTransport.
    debouncedPreview(dataWorkspace, connections, sources);
  }, [
    dataWorkspace,
    connections,
    sources,
    debouncedPreview,
    overlayOpen,
    centerTab,
    activeQueryId,
    focusQueryId,
    project.workspace,
  ]);

  // Free the preview lane when the quality overview takes over.
  useEffect(() => {
    if (centerTab !== QUALITY_TAB) return;
    nextRequestGen(previewReqGenRef.current);
    setLoading(false);
    cancelHeavyQuery();
  }, [centerTab]);

  // Join Lens Load sides after Inspect — keep the global bar in sync.
  useEffect(() => {
    if (!lensPrepareBusy) {
      if (qualityHandoffRef.current) return;
      setOpProgress((cur) =>
        cur?.kind === "prepare" || cur?.kind === "quality" ? null : cur,
      );
      return;
    }
    qualityHandoffRef.current = false;
    setOpProgress({
      kind: "prepare",
      phase: "Loading join sides for sample…",
      percent: 8,
    });
    const poll = window.setInterval(() => {
      void joinPrepareProgress()
        .then((p) => {
          if (!p.active && p.fraction <= 0) return;
          setOpProgress({
            kind: "prepare",
            phase: p.message || p.stage || "Loading join sides…",
            percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100),
          });
        })
        .catch(() => {});
    }, 250);
    return () => window.clearInterval(poll);
  }, [lensPrepareBusy]);

  // Schema-aware Join: column lists from truncated preview (left before Join, full right).
  useEffect(() => {
    if (
      overlayOpen ||
      centerTab === QUALITY_TAB ||
      centerTab === HELP_LAB_TAB
    ) {
      return;
    }
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (step?.type !== "Join") {
      return;
    }
    const hostId = activeQueryId;
    // Skip full lab Join — describe/prepare would ship the 95k-row map on every tab switch.
    if (isFullQualityJoin(hostId)) {
      setJoinLeftColumns((c) => (c.length === 0 ? c : []));
      setJoinRightColumns((c) => (c.length === 0 ? c : []));
      setJoinColsLoading((v) => (v ? false : v));
      return;
    }
    const rightId = joinRightId || targetKey(step.payload.right_query_id);
    if (!hostId || !rightId) {
      setJoinLeftColumns((c) => (c.length === 0 ? c : []));
      setJoinRightColumns((c) => (c.length === 0 ? c : []));
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
    centerTab,
  ]);

  // Clear stale diagnostics when leaving Join / changing keys — do not auto-run
  // full-input scans (explicit "Run diagnostics" in the panel).
  const joinDiagIdentity = (() => {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      step?.type !== "Join"
    ) {
      return "";
    }
    return `${activeQueryId}#${selectedStepIndex}:${step.payload.left_on.join(",")}|${step.payload.right_on.join(",")}`;
  })();
  useEffect(() => {
    setJoinDiag((cur) => (cur == null ? cur : null));
    setJoinDiagError((cur) => (cur == null ? cur : null));
    setJoinDiagLoading((cur) => (cur ? false : cur));
    setDiagView((cur) => (cur == null ? cur : null));
    setJoinPrepareLabel((cur) => (cur == null ? cur : null));
  }, [joinDiagIdentity]);

  useEffect(() => {
    if (!joinDiagIdentity) return;
    if (isFullQualityJoin(activeQueryId)) {
      setJoinPrepareLabel(null);
      return;
    }
    refreshJoinPrepareStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinDiagIdentity, sources, activeQueryId]);

  function refreshJoinPrepareStatus() {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      step?.type !== "Join"
    ) {
      setJoinPrepareLabel(null);
      return;
    }
    void joinPrepareStatus(
      project.workspace,
      activeQueryId,
      selectedStepIndex,
      sources,
      connections,
      projectRefContext(project),
    )
      .then((s) => {
        if (s.prepared) {
          setJoinPrepareLabel(formatJoinPrepareStatusHint(s));
        } else if (s.stale) {
          setJoinPrepareLabel("Loaded sides are outdated — Reload sides after graph/source changes");
        } else {
          setJoinPrepareLabel(null);
        }
      })
      .catch(() => setJoinPrepareLabel(null));
  }

  function runPrepareJoinInputs() {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      step?.type !== "Join"
    ) {
      return;
    }
    const { left_on, right_on } = step.payload;
    if (left_on.length === 0 || left_on.length !== right_on.length) {
      setJoinDiagError("Set join keys and Apply before preparing inputs.");
      return;
    }
    setJoinPrepareLoading(true);
    setJoinDiagError(null);
    void cancelRunningQuery().catch(() => {});
    nextRequestGen(previewReqGenRef.current);
    setLoading(false);
    setOpProgress({
      kind: "prepare",
      phase: "Queued…",
      percent: 1,
    });
    const poll = window.setInterval(() => {
      void joinPrepareProgress()
        .then((p) => {
          if (!p.active && p.fraction <= 0) return;
          setOpProgress({
            kind: "prepare",
            phase: p.message || p.stage || "Preparing…",
            percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100),
          });
        })
        .catch(() => {});
    }, 250);
    void prepareJoinInputs(
      project.workspace,
      activeQueryId,
      selectedStepIndex,
      connections,
      sources,
      !!joinPrepareLabel,
      projectRefContext(project),
    )
      .then((r) => {
        setJoinPrepareLabel(formatJoinPrepareHint(r));
        setJoinPrepareLoading(false);
        setOpProgress(null);
      })
      .catch((e) => {
        setJoinPrepareLoading(false);
        setOpProgress(null);
        if (isHostCancelled(e)) return;
        const msg = e instanceof Error ? e.message : String(e);
        setJoinDiagError(msg);
      })
      .finally(() => {
        window.clearInterval(poll);
      });
  }

  function runJoinDiagnostics() {
    const step =
      selectedStepIndex != null && activeQuery
        ? activeQuery.steps[selectedStepIndex]
        : undefined;
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      step?.type !== "Join"
    ) {
      return;
    }
    const { left_on, right_on } = step.payload;
    if (left_on.length === 0 || left_on.length !== right_on.length) {
      setJoinDiagError("Set join keys and Apply before running diagnostics.");
      return;
    }
    setJoinDiagLoading(true);
    setJoinDiagError(null);
    void cancelRunningQuery().catch(() => {});
    nextRequestGen(previewReqGenRef.current);
    setLoading(false);
    setOpProgress({
      kind: "prepare",
      phase: "Diagnostics — materializing sides…",
      percent: 5,
    });
    const poll = window.setInterval(() => {
      void joinPrepareProgress()
        .then((p) => {
          if (!p.active && p.fraction <= 0) return;
          setOpProgress({
            kind: "prepare",
            phase: p.message || p.stage || "Diagnostics…",
            percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100),
          });
        })
        .catch(() => {});
    }, 250);
    void joinDiagnostics(
      project.workspace,
      activeQueryId,
      selectedStepIndex,
      connections,
      sources,
      projectRefContext(project),
    )
      .then((d) => {
        setJoinDiag(d);
        setJoinDiagLoading(false);
        setOpProgress(null);
        refreshJoinPrepareStatus();
      })
      .catch((e) => {
        setJoinDiag(null);
        setJoinDiagLoading(false);
        setOpProgress(null);
        if (isHostCancelled(e)) return;
        const msg = e instanceof Error ? e.message : String(e);
        setJoinDiagError(msg);
      })
      .finally(() => {
        window.clearInterval(poll);
      });
  }

  function cancelHeavyQuery() {
    void cancelRunningQuery().catch(() => {});
  }

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
    // Same IPC slim as data preview — emit does not need inline seed rows.
    const modelWs = workspaceForPreviewTransport({
      ...project.workspace,
      focus_query_id: id,
    });
    void previewDbtModel(
      modelWs,
      id,
      projectDialect(project),
      connections,
      sources,
      projectRefContext(project),
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
        setJoinRightId(targetKey(j.payload.right_query_id));
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
        fq && fq.type === "FromQuery" ? targetKey(fq.payload.query_id) : "",
      );
      const a = q.steps.find((s) => s.type === "Append");
      if (a && a.type === "Append") {
        const first = a.payload.other_query_ids[0];
        setAppendOtherId(first ? targetKey(first) : "");
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
        setJoinRightId(targetKey(step.payload.right_query_id));
        setJoinKeyPairsBoth(
          pairsFromOn(step.payload.left_on, step.payload.right_on),
        );
        setJoinType(step.payload.join_type);
        break;
      case "FromQuery":
        setFromQueryId(targetKey(step.payload.query_id));
        break;
      case "Append": {
        const first = step.payload.other_query_ids[0];
        setAppendOtherId(first ? targetKey(first) : "");
        break;
      }
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
      setSelectedExternalKey(null);
      setActiveQueryId(id);
      const q = queries.find((x) => x.id === id);
      syncInspectorFromQuery(q);
      if (!q || q.steps.length === 0) {
        setSelectedStepIndex(null);
        return;
      }
      // Ephemeral check cohort: land on Join so Join Lens mounts (Filter/Sort
      // alone shows PreviewTable — often empty after a tight cohort predicate).
      const joinIdx = isQualityInspectionQuery(id)
        ? q.steps.findIndex((s) => s.type === "Join")
        : -1;
      const idx = joinIdx >= 0 ? joinIdx : q.steps.length - 1;
      setSelectedStepIndex(idx);
      loadStepIntoEditor(q.steps[idx]);
    },
    [queries, syncInspectorFromQuery, loadStepIntoEditor],
  );

  const externalBoundaries = useMemo(
    () => collectExternalBoundaries(project),
    [project],
  );

  useEffect(() => {
    const file = project.root_path;
    const refs = project.references ?? [];
    if (!file || refs.length === 0) {
      setRefStatuses((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    let cancelled = false;
    void referenceStatuses(file, refs)
      .then((list) => {
        if (!cancelled) setRefStatuses(list);
      })
      .catch(() => {
        if (!cancelled) setRefStatuses((cur) => (cur.length === 0 ? cur : []));
      });
    return () => {
      cancelled = true;
    };
  }, [project.root_path, project.references]);

  useEffect(() => {
    const file = project.root_path;
    const refs = project.references ?? [];
    if (!file || refs.length === 0) {
      setRefCatalogs((cur) =>
        Object.keys(cur).length === 0 ? cur : {},
      );
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: typeof refCatalogs = {};
      for (const r of refs) {
        try {
          const owner = await loadProject(resolveOwnerPath(file, r.locator));
          next[r.id] = {
            alias: r.alias,
            queries: owner.workspace.queries.map((q) => ({
              id: q.id,
              name: q.name,
            })),
            maps: (owner.workspace.key_maps ?? []).map((m) => ({
              id: m.id,
              name: m.name,
            })),
          };
        } catch {
          next[r.id] = { alias: r.alias, queries: [], maps: [] };
        }
      }
      if (!cancelled) setRefCatalogs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.root_path, project.references]);

  function objectTargetFromPicker(value: string): ObjectTarget {
    return parseTargetKey(value) ?? value;
  }

  async function handleAddReference() {
    let path = project.root_path;
    if (!path) {
      const pickedSave =
        (await save({
          defaultPath: `${project.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`,
          filters: [{ name: "DWH Project", extensions: ["json"] }],
        })) ?? null;
      if (typeof pickedSave !== "string") return;
      try {
        const saved = await saveProject(pickedSave, {
          ...project,
          root_path: pickedSave,
        });
        path = pickedSave;
        setProject((p) => ({
          ...p,
          ...saved,
          root_path: pickedSave,
          connections: p.connections,
        }));
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
        return;
      }
    }
    const picked = await open({
      multiple: false,
      filters: [{ name: "DWH Project", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    if (norm(picked) === norm(path)) {
      setError("A project cannot reference itself (same file)");
      return;
    }
    try {
      const owner = await loadProject(picked);
      if (
        project.project_uid?.trim() &&
        owner.project_uid?.trim() &&
        project.project_uid === owner.project_uid
      ) {
        setError(
          "Same project_uid as the open project (likely a copied file). Save As the owner first to fork identity, then reference it.",
        );
        return;
      }
      setAddRefPending({
        consumerPath: path,
        ownerPath: picked,
        alias: owner.name?.trim() || "Shared",
      });
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function confirmAddReference() {
    if (!addRefPending) return;
    const { consumerPath, ownerPath, alias } = addRefPending;
    const name = alias.trim() || "Shared";
    try {
      const ref = await makeProjectReference(consumerPath, ownerPath, name);
      setProject((p) => ({
        ...p,
        references: [...(p.references ?? []), ref],
      }));
      setTreeExpanded((e) => ({ ...e, references: true }));
      setAddRefPending(null);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function handleRefreshReference(ref: ProjectReference) {
    try {
      const updated = await refreshReference(project, ref.id);
      setProject((p) => ({
        ...p,
        references: (p.references ?? []).map((r) =>
          r.id === ref.id ? updated : r,
        ),
      }));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function handleRelinkReference(ref: ProjectReference) {
    const file = project.root_path;
    if (!file) {
      setError("Save the project before relinking");
      return;
    }
    const picked = await open({
      multiple: false,
      filters: [{ name: "DWH Project", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const updated = await relinkReference(file, ref, picked);
      setProject((p) => ({
        ...p,
        references: (p.references ?? []).map((r) =>
          r.id === ref.id ? updated : r,
        ),
      }));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function handleOpenReferenceOwner(ref: ProjectReference) {
    const file = project.root_path;
    if (!file) {
      setError("Save the project to resolve reference paths");
      return;
    }
    try {
      await revealItemInDir(resolveOwnerPath(file, ref.locator));
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  async function handleRemoveReference(ref: ProjectReference) {
    try {
      const consumers = await referenceConsumers(project.workspace, ref.id);
      if (consumers.length > 0) {
        setError(
          `Cannot remove “${ref.alias}”: still used by ${consumers.join(", ")}`,
        );
        return;
      }
      setProject((p) => ({
        ...p,
        references: (p.references ?? []).filter((r) => r.id !== ref.id),
      }));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  function selectExternalBoundary(key: string) {
    setSelectedExternalKey(key);
    setActiveQueryId(null);
    setSelectedStepIndex(null);
    setSelectedKeyMapId(null);
    setCenterTab("canvas");
  }

  function useReferencedQuery(
    referenceId: string,
    queryId: string,
    nameHint: string,
  ) {
    const q = newQueryFromExternal(
      project,
      externalTarget(referenceId, "query", queryId),
      nameHint,
    );
    setQueries((prev) => [...prev, q]);
    selectQuery(q.id);
  }

  function deriveFromExternalKey(key: string) {
    const target = parseTargetKey(key);
    if (!target || !isExternalTarget(target)) return;
    if (target.kind !== "query") {
      setError("Use-in-new-query applies to referenced queries");
      return;
    }
    const alias =
      (project.references ?? []).find((r) => r.id === target.reference_id)
        ?.alias ?? target.reference_id;
    useReferencedQuery(
      target.reference_id,
      target.id,
      `${alias}_${target.id}`,
    );
  }

  async function createLocalCopyOfExternal(key: string) {
    const target = parseTargetKey(key);
    const file = project.root_path;
    if (!target || !isExternalTarget(target) || !file) {
      setError("Save the project and select an external object first");
      return;
    }
    const ref = (project.references ?? []).find(
      (r) => r.id === target.reference_id,
    );
    if (!ref) {
      setError("Unknown reference");
      return;
    }
    if (target.kind !== "query" && target.kind !== "mapping") {
      setError("Create local copy supports queries and mappings");
      return;
    }
    try {
      const id =
        target.kind === "query"
          ? newQueryId(
              `${target.id}_copy`,
              project.workspace.queries.map((q) => q.id),
            )
          : newId(
              "map",
              `${target.id}_copy`,
              (project.workspace.key_maps ?? []).map((m) => m.id),
            );
      const copied = await copyReferencedObject(
        file,
        project.references ?? [],
        ref.id,
        target.kind,
        target.id,
        id,
        "",
        {
          connectionBindings: project.connection_bindings ?? [],
          connections,
          executionEngine: projectEngine(project),
        },
      );
      if (copied.kind === "query") {
        setQueries((prev) => [...prev, copied.query]);
        selectQuery(copied.query.id);
        return;
      }
      setProject((p) => ({
        ...p,
        workspace: {
          ...p.workspace,
          key_maps: [...(p.workspace.key_maps ?? []), copied.key_map],
        },
      }));
      setSelectedKeyMapId(copied.key_map.id);
      openKeyMapEditor(copied.key_map);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }

  /** Close map tab; if opened from Join Lens, restore Join + Lens No match. */
  function closeKeyMapTab(mapId: string, wsForJoin?: Workspace) {
    const closing = keyMapTabs.find((t) => t.map.id === mapId);
    const joinCtx = closing?.joinCtx;
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
    if (!joinCtx) return;
    const ws = wsForJoin ?? project.workspace;
    setActiveQueryId(joinCtx.hostQueryId);
    setBottomTab("data");
    setJoinLensOn(true);
    setDiagView(null);
    const idx = resolveJoinStepFromCtx(ws, joinCtx);
    if (idx != null) {
      setSelectedStepIndex(idx);
      const q = ws.queries.find((x) => x.id === joinCtx.hostQueryId);
      const step = q?.steps[idx];
      if (step) loadStepIntoEditor(step);
    }
    // Re-enter No match (map was opened from Lens unmatched / Suggest flow).
    setForceProbeNonce((n) => n + 1);
  }

  function patchKeyMapTab(mapId: string, patch: Partial<KeyMapTabSession> | ((t: KeyMapTabSession) => KeyMapTabSession)) {
    setKeyMapTabs((tabs) =>
      tabs.map((t) => {
        if (t.map.id !== mapId) return t;
        return typeof patch === "function" ? patch(t) : { ...t, ...patch };
      }),
    );
  }

  // After apply_keymap commits into projectBag — close tab or show error (never
  // read apply outcome from impure setProject locals).
  useEffect(() => {
    const result = projectBag.keyMapApplyResult;
    if (!result) return;
    dispatchProject({ type: "clear_keymap_apply_result" });
    if (result.status === "join_gone") {
      setError(
        result.reason?.trim() ||
          "Join was removed or changed while Save was pending — mapping was saved, but Apply was skipped. Re-open the Join and Apply again.",
      );
      return;
    }
    if (result.status === "stale") {
      setError(
        result.reason?.trim() ||
          "Mapping changed since Apply was prepared — re-open the map and Apply again.",
      );
      return;
    }
    closeKeyMapTab(result.mapId, result.workspace);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeKeyMapTab closes over latest tabs/project
  }, [projectBag.keyMapApplyResult]);

  // After confirm_remap commits — tab/Save only when reducer reports applied.
  useEffect(() => {
    const result = projectBag.confirmRemapResult;
    if (!result) return;
    dispatchProject({ type: "clear_confirm_remap_result" });
    if (pendingConfirmOpIdRef.current !== result.opId) {
      return;
    }
    pendingConfirmOpIdRef.current = null;
    confirmRemapInFlightRef.current = false;
    setConfirmRemapBusy(false);
    if (result.status === "stale") {
      setError(result.reason);
      return;
    }
    patchKeyMapTab(result.mapId, (s) => ({
      ...s,
      map: { ...result.nextMap, id: s.map.id },
      dirtyDelta: result.dirtyDelta,
      localDraft: true,
    }));
    setFrozenRemap(null);
    setExportMsg(result.message);
    setCenterTab(QUALITY_TAB);
    lastCheckRunFingerprint.current = null;
    void saveKeyMapToProject(result.nextMap, {
      dirtyDelta: result.dirtyDelta,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save/patch close over latest handlers
  }, [projectBag.confirmRemapResult]);

  // After create_mapping — open existing editor only on applied (no WH Save).
  useEffect(() => {
    const result = projectBag.mappingCreateResult;
    if (!result) return;
    dispatchProject({ type: "clear_mapping_create_result" });
    if (pendingMappingCreateOpIdRef.current !== result.opId) return;
    pendingMappingCreateOpIdRef.current = null;
    if (result.status === "stale" || result.status === "error") {
      setError(result.reason);
      return;
    }
    setMappingCreateOpen(false);
    setExportMsg(result.message);
    setTreeExpanded((e) => ({ ...e, keyMaps: true }));
    openKeyMapEditor(result.map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectBag.mappingCreateResult]);

  const selectedStepIndexRef = useRef(selectedStepIndex);
  selectedStepIndexRef.current = selectedStepIndex;

  // Keep forms in sync when steps change; clamp selected step index.
  // Do not call other setStates inside the setSelectedStepIndex updater —
  // that re-enters React and can hit "Maximum update depth" on graph clicks.
  // Fingerprint the active query steps so a new `queries` array identity with
  // identical IR does not re-seed Join key drafts every App render.
  const inspectorSyncKey = useMemo(() => {
    if (!activeQueryId) return "";
    const q = queries.find((x) => x.id === activeQueryId);
    if (!q) return `${activeQueryId}:missing`;
    return `${activeQueryId}:${q.steps.length}:${JSON.stringify(q.steps)}`;
  }, [activeQueryId, queries]);

  useEffect(() => {
    if (!activeQueryId) {
      setSelectedStepIndex((cur) => (cur == null ? cur : null));
      return;
    }
    const q = queries.find((x) => x.id === activeQueryId);
    syncInspectorFromQuery(q);
    if (!q || q.steps.length === 0) {
      setSelectedStepIndex((cur) => (cur == null ? cur : null));
      return;
    }
    const prev = selectedStepIndexRef.current;
    const next =
      prev === null || prev >= q.steps.length ? q.steps.length - 1 : prev;
    if (next !== prev) setSelectedStepIndex(next);
    loadStepIntoEditor(q.steps[next]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inspectorSyncKey
  }, [inspectorSyncKey, syncInspectorFromQuery, loadStepIntoEditor]);

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
    nameOverride?: string,
    /** Source-only: Hive partition folders (not a step field). */
    hivePartitioning?: boolean,
  ) {
    const base = path.split(/[/\\]/).pop() ?? "file";
    const name =
      nameOverride ??
      (kind === "csv"
        ? base.replace(/\.csv$/i, "")
        : base.replace(/\.parquet$/i, ""));
    const id = newQueryId(name, queries.map((q) => q.id));
    const bound = connectionId
      ? { path, path_kind: "absolute" as const }
      : bindFilePath(path, project.root_path);
    const step: TransformationStep =
      kind === "csv"
        ? { type: "LoadCsv", payload: bound }
        : {
            type: "LoadParquet",
            payload: {
              ...bound,
              connection_id: connectionId,
            },
          };
    const q: QueryDef = { id, name, steps: [step] };
    setProject((p) => {
      const nextQueries = [...p.workspace.queries, q];
      let nextSources = syncSourcesFromQueries(p.sources, nextQueries);
      if (kind === "parquet" && hivePartitioning) {
        nextSources = nextSources.map((s) =>
          s.kind === "parquet" &&
          s.path === path &&
          (s.connection_id ?? undefined) === (connectionId ?? undefined)
            ? { ...s, hive_partitioning: true }
            : s,
        );
      }
      return {
        ...p,
        sources: nextSources,
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
      step = {
        type: "LoadCsv",
        payload: {
          path: source.path,
          path_kind: source.path_kind ?? "absolute",
        },
      };
      name = source.name.replace(/\.csv$/i, "") || name;
    } else if (source.kind === "parquet" && source.path) {
      step = {
        type: "LoadParquet",
        payload: {
          path: source.path,
          path_kind: source.path_kind ?? "absolute",
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

  function addSourceOnlyHive(path: string) {
    const name = parquetSourceName(path);
    const id = newSourceId(
      name,
      project.sources.map((s) => s.id),
    );
    setProject((p) => ({
      ...p,
      sources: [
        ...p.sources,
        { id, name, kind: "parquet", path, hive_partitioning: true },
      ],
    }));
    setSelectedSourceId(id);
    setShowHiveDialog(false);
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

  function openHiveDialog(intent: "source" | "query") {
    setPickerIntent(intent);
    setShowHiveDialog(true);
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

  function handleSetTargetDialect(d: WarehouseDialect) {
    // Legacy: set both engine and destination on the *current* project only.
    // App defaults live in File → Options… (ADR-0021).
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
  }

  async function rememberRecentProject(path: string) {
    const next = {
      ...appSettings,
      recent_projects: pushRecentProject(appSettings.recent_projects, path),
    };
    await persistAppSettings(next);
  }

  async function handleClearRecent() {
    await persistAppSettings({ ...appSettings, recent_projects: [] });
  }

  async function handleOpenRecentProject(path: string) {
    await openProjectPath(path, true);
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

  async function handleLoadDemo(id: DemoId | string) {
    await requestProjectReplacement(async () => {
      const workspace = await loadDemoWorkspace(id);
      const next = labProject(id, workspace, projectRef.current, appSettings);
      if (id === "mapping_quality") next.mapping_checks = ensureLabCheck([]);
      return next;
    }, (next) => {
      applyLoadedProject(next);
      setLabTask(startLabTask(id, next.project_uid));
      // A loaded lab is a new unsaved document, not a saved baseline.
      savedProjectFingerprint.current = null;
      setCenterTab(id === "mapping_quality" ? QUALITY_TAB : "canvas");
      setExportMsg(null);
    });
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
            s.type === "Join" &&
            targetKey(s.payload.right_query_id) === rightQueryId,
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
        const joinStep =
          activeQuery?.steps[joinDiag.join_step_index] ??
          project.workspace.queries.find((q) => q.id === activeQueryId)
            ?.steps[joinDiag.join_step_index];
        const rightTarget =
          joinStep?.type === "Join"
            ? joinStep.payload.right_query_id
            : joinDiag.right_query_id;
        ws = workspaceFocusingObject(project.workspace, rightTarget);
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
      const result = await previewWorkspace(
        ws,
        connections,
        sources,
        projectRefContext(project),
      );
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
    const rightWs: Workspace | null = rightQueryId
      ? workspaceFocusingObject(project.workspace, rightQueryId)
      : null;

    // Schema only — avoid LIMIT 50 scans just to populate Join column pickers.
    const pref = projectRefContext(project);
    const leftRes = leftWs
      ? await describeWorkspace(leftWs, connections, sources, pref).catch(
          () => null,
        )
      : null;
    const rightRes = rightWs
      ? await describeWorkspace(rightWs, connections, sources, pref).catch(
          () => null,
        )
      : null;
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
                targetKey(s.payload.right_query_id) === edge.otherQueryId,
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
            s.type === "FromQuery" &&
            targetKey(s.payload.query_id) === edge.otherQueryId,
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
              targetKey(s.payload.query_id) === edge.otherQueryId
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
                targetKey(s.payload.right_query_id) === edge.otherQueryId
              ) {
                return false;
              }
              if (
                edge.stepIndex == null &&
                targetKey(s.payload.right_query_id) === edge.otherQueryId
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
                  targetKey(s.payload.query_id) === edge.otherQueryId
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
                (id) => targetKey(id) !== edge.otherQueryId,
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
            if (
              s.type === "Join" &&
              targetKey(s.payload.right_query_id) === queryId
            ) {
              return null;
            }
            if (
              s.type === "FromQuery" &&
              targetKey(s.payload.query_id) === queryId
            ) {
              return null;
            }
            if (s.type === "Append") {
              const others = s.payload.other_query_ids.filter(
                (id) => targetKey(id) !== queryId,
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
        workspace: { ...p.workspace, queries: scrubbed, focus_query_id: focus },
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

  // GraphCanvas calls only on drag stop. Commit now so a subsequent Save/switch
  // sees the move, and no old-project debounce can mutate the next project.
  const persistCanvasPositions = useCallback((positions: CanvasPositions) => {
    const owner = project.project_uid;
    setProject((p) => p.project_uid === owner ? { ...p, canvas: { positions } } : p);
  }, [project.project_uid]);

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
      // Deleting the root while later transforms remain → "requires a previous step".
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

  /** Rebind LoadCsv / local LoadParquet to another file (Sources catalog had no path edit). */
  async function changeSelectedLoadFile() {
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      !selectedStep ||
      (selectedStep.type !== "LoadCsv" && selectedStep.type !== "LoadParquet")
    ) {
      return;
    }
    if (
      selectedStep.type === "LoadParquet" &&
      selectedStep.payload.connection_id
    ) {
      setError("Remote Parquet path is set via the S3 / connection picker.");
      return;
    }
    const kind = selectedStep.type === "LoadCsv" ? "csv" : "parquet";
    const picked = await open({
      multiple: false,
      filters:
        kind === "csv"
          ? [{ name: "CSV", extensions: ["csv"] }]
          : [{ name: "Parquet", extensions: ["parquet"] }],
    });
    if (typeof picked !== "string") return;
    const bound = bindFilePath(picked, project.root_path);
    const oldPath = selectedStep.payload.path;
    const oldBase = oldPath.split(/[/\\]/).pop() ?? "";
    const newBase = bound.path.split(/[/\\]/).pop() ?? bound.path;
    const stepIndex = selectedStepIndex;
    const queryId = activeQueryId;
    setProject((p) => {
      const nextQueries = p.workspace.queries.map((q) => {
        if (q.id !== queryId) return q;
        return {
          ...q,
          steps: q.steps.map((s, i) => {
            if (i !== stepIndex) return s;
            if (s.type === "LoadCsv") {
              return { type: "LoadCsv" as const, payload: { ...bound } };
            }
            if (s.type === "LoadParquet") {
              return {
                type: "LoadParquet" as const,
                payload: { ...s.payload, ...bound },
              };
            }
            return s;
          }),
        };
      });
      const nextSources = p.sources.map((s) => {
        if (s.kind !== kind || s.path !== oldPath) return s;
        const renameDefault = !s.name.trim() || s.name === oldBase;
        return {
          ...s,
          path: bound.path,
          path_kind: bound.path_kind,
          name: renameDefault ? newBase : s.name,
        };
      });
      return {
        ...p,
        sources: syncSourcesFromQueries(nextSources, nextQueries),
        workspace: { ...p.workspace, queries: nextQueries },
      };
    });
    setError(null);
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

  function showReconLabStart() {
    if (!activeLabTask) return;
    const target = reconJoinTarget(project.workspace);
    if (!target) return;
    selectQuery(target.queryId);
    setSelectedStepIndex(target.stepIndex);
    loadStepIntoEditor(project.workspace.queries.find((q) => q.id === target.queryId)?.steps[target.stepIndex]);
    setBottomTab("data");
    setJoinLensOn(true);
    setDiagView(null);
  }

  function projectWithoutEphemeralInspect(p: typeof project) {
    const workspace = stripQualityInspectionQueries(p.workspace);
    const positions = { ...(p.canvas?.positions ?? {}) };
    for (const id of Object.keys(positions)) {
      if (isQualityInspectionQuery(id)) delete positions[id];
    }
    const outputs = (p.outputs ?? []).filter(
      (id) => !isQualityInspectionQuery(id),
    );
    return {
      ...p,
      workspace,
      canvas: { ...p.canvas, positions },
      outputs,
    };
  }

  function documentFingerprint(p: Project) {
    return projectFingerprint(projectWithoutEphemeralInspect(p));
  }

  function hasUnsavedEditorDrafts() {
    return matchingTabsLiveRef.current.some((t) => t.hasUnsavedDecisions) ||
      keyMapTabsLiveRef.current.some((t) => t.localDraft || dirtyDeltaHasChanges(t.dirtyDelta ?? null));
  }

  function replacementState() {
    return {
      token: `${projectRef.current.root_path ?? ""}:${documentFingerprint(projectRef.current)}`,
      drafts: JSON.stringify([
        keyMapTabsLiveRef.current.map((t) => [t.map, t.localDraft, t.dirtyDelta]),
        matchingTabsLiveRef.current,
      ]),
      busy: projectSaveInFlight.current || mapWritesInFlight.current > 0 || confirmRemapInFlightRef.current ||
        keyMapTabsLiveRef.current.some((t) => t.saveInFlight || t.saveApi?.isSaving()),
    };
  }

  async function requestProjectReplacement(load: () => Promise<Project>, commit: (next: Project) => void) {
    if (projectSwitchInFlight.current) return;
    projectSwitchInFlight.current = true;
    try {
      await replaceProject({
        read: replacementState,
        dirty: () => hasUnsavedEditorDrafts() ||
          savedProjectFingerprint.current !== documentFingerprint(projectRef.current),
        choose: () => new Promise<SwitchDecision>((resolve) => {
          setSwitchChoice(() => (decision: SwitchDecision) => {
            setSwitchChoice(null);
            resolve(decision);
          });
        }),
        save: async () => {
          if (hasUnsavedEditorDrafts()) {
            setError("Save Mapping and Matching drafts in their editors first, then retry opening the project. The current project is still open.");
            return false;
          }
          return handleSaveProject();
        },
        load,
        commit,
      });
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      projectSwitchInFlight.current = false;
    }
  }

  async function openProjectPath(path: string, pruneFailedRecent = false) {
    await requestProjectReplacement(async () => {
      try {
        return await loadProject(path, { remember: true });
      } catch (e) {
        // Keep ADR-0021 missing-recent pruning, but never prune on Cancel/Save failure.
        if (pruneFailedRecent) {
          await persistAppSettings({ ...appSettings,
            recent_projects: (appSettings.recent_projects ?? []).filter((p) => p !== path),
          }).catch(() => {});
        }
        throw e;
      }
    }, (loaded) => {
      applyLoadedProject(loaded, path);
      setExportMsg(`Opened ${path}`);
      void rememberRecentProject(path).catch((e) => setError(String(e)));
    });
  }

  async function writeProjectTo(path: string, snapshot = projectRef.current, comparisonSnapshot = snapshot): Promise<boolean> {
    try {
      const base =
        path
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.dwhproj\.json$/i, "")
          .replace(/\.json$/i, "") ?? snapshot.name;
      const persisted = projectWithoutEphemeralInspect(snapshot);
      const saved = await saveProject(path, {
        ...persisted,
        root_path: path,
        name: base,
      });
      const savedState: Project = {
        ...snapshot,
        connections: projectRef.current.connections,
        root_path: path,
        name: base,
        format_version: saved.format_version ?? snapshot.format_version,
        project_uid: saved.project_uid ?? snapshot.project_uid,
        sources: saved.sources ?? snapshot.sources,
        workspace: {
          ...snapshot.workspace,
          queries: [
            ...(saved.workspace?.queries ?? persisted.workspace.queries),
            ...snapshot.workspace.queries.filter((q) => isQualityInspectionQuery(q.id)),
          ],
        },
      };
      const unchanged = documentFingerprint(projectRef.current) === documentFingerprint(comparisonSnapshot);
      // Record the bytes actually saved, not edits made while the write awaited IPC.
      savedProjectFingerprint.current = documentFingerprint(savedState);
      if (unchanged) {
        projectRef.current = savedState;
        setProject(savedState);
      }
      setExportMsg(`Project saved → ${path}`);
      setError(unchanged ? null : "Project saved, but newer edits remain unsaved. The current project is still open.");
      await rememberRecentProject(path).catch((e) => setError(String(e)));
      return unchanged;
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      return false;
    }
  }

  async function handleSaveProject(): Promise<boolean> {
    if (projectSaveInFlight.current) return false;
    projectSaveInFlight.current = true;
    try {
      let path = projectRef.current.root_path;
      if (!path) {
        const picked = await save({
          defaultPath: `${projectRef.current.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`,
          filters: [{ name: "DWH Project", extensions: ["json"] }],
        });
        if (typeof picked !== "string") return false;
        path = picked;
      }
      return await writeProjectTo(path);
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      projectSaveInFlight.current = false;
    }
  }

  async function handleSaveProjectAs() {
    if (projectSaveInFlight.current) return;
    projectSaveInFlight.current = true;
    try {
      const picked = await save({
        defaultPath:
          projectRef.current.root_path?.split(/[/\\]/).pop() ??
          `${projectRef.current.name.replace(/\s+/g, "_") || "project"}.dwhproj.json`,
        filters: [{ name: "DWH Project", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      const current = projectRef.current;
      // ADR-0025: a copy is a new identity.
      const normalize = (path: string) => {
        const slashes = path.replace(/\\/g, "/");
        return /^[A-Za-z]:\//.test(slashes) ? slashes.toLowerCase() : slashes;
      };
      const sameFile = current.root_path && normalize(current.root_path) === normalize(picked);
      const forked = sameFile ? current : { ...current, project_uid: crypto.randomUUID() };
      await writeProjectTo(picked, forked, current);
    } catch (e) {
      setError(String(e));
    } finally {
      projectSaveInFlight.current = false;
    }
  }

  function applyLoadedProject(loaded: Project, pathHint?: string) {
    setLabTask(null);
    const withConnections: Project = migrateProject({
      ...loaded,
      connections: loaded.connections ?? [],
      sources: loaded.sources ?? [],
      root_path: loaded.root_path ?? pathHint,
    });
    savedProjectFingerprint.current = documentFingerprint(withConnections);
    projectRef.current = withConnections;
    setProject(withConnections);
    setKeyMapTabs([]);
    setMatchingTabs([]);
    setSelectedKeyMapId(null);
    setCenterTab("canvas");
    const focused = withConnections.workspace.queries.find(
      (q) => q.id === withConnections.workspace.focus_query_id,
    );
    setSelectedStepIndex(focused?.steps.length ? focused.steps.length - 1 : null);
    nextRequestGen(previewReqGenRef.current);
    setPreview(null);
    setLoading(false);
    setDiagView(null);
    setJoinDiag(null);
    setJoinDiagError(null);
    setFrozenRemap(null);
    setCheckDeltaNote(null);
    setCheckAllowNote(null);
    lastCheckRunFingerprint.current = null;
    setActiveQueryId(withConnections.workspace.focus_query_id || null);
    void refreshExportTree(withConnections.last_dbt_export_path);
    setError(null);
    // After first export, seeds/map_*.csv is SoT (ADR-0020).
    const exportPath = withConnections.last_dbt_export_path;
    if (exportPath) {
      const baselineMapIds = new Set(
        (withConnections.workspace.key_maps ?? []).map((m) => m.id),
      );
      void syncKeyMapsFromExport(withConnections.workspace, exportPath)
        .then((synced) => {
          setProject((p) => {
            if (p.project_uid !== withConnections.project_uid || p.last_dbt_export_path !== exportPath) return p;
            // Don't clobber maps the user deleted while sync was in flight.
            const stillPresent = new Set(
              (p.workspace.key_maps ?? []).map((m) => m.id),
            );
            const removedDuringSync = [...baselineMapIds].filter(
              (id) => !stillPresent.has(id),
            );
            if (removedDuringSync.length === 0) {
              return { ...p, workspace: synced.workspace };
            }
            const key_maps = (synced.workspace.key_maps ?? []).filter(
              (m) => !removedDuringSync.includes(m.id),
            );
            return {
              ...p,
              workspace: { ...synced.workspace, key_maps },
            };
          });
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
      suggestedFromParts?: string[][];
      joinCtx?: NonNullable<KeyMapTabSession["joinCtx"]>;
    },
  ) {
    const normalized = normalizeKeyMapForEditor(map);
    setSelectedKeyMapId(normalized.id);
    setKeyMapTabs((tabs) => {
      const i = tabs.findIndex((t) => t.map.id === normalized.id);
      if (i < 0) {
        return [
          ...tabs,
          {
            map: normalized,
            pickTo: opts?.pickTo,
            suggestedFrom: opts?.suggestedFrom,
            suggestedFromParts: opts?.suggestedFromParts,
            joinCtx: opts?.joinCtx,
          },
        ];
      }
      const next = [...tabs];
      next[i] = mergeKeyMapTabSession(tabs[i]!, normalized, opts);
      return next;
    });
    setCenterTab(normalized.id);
    // Source-backed: KeyMapEditor loads paged rows (ADR-0022). Do not full-read here —
    // a late unbounded read would replace the page and drop dirty overlays.
    if (normalized.storage?.kind === "source") {
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
        const resolved = resolveKeyMapConnection(
          project,
          normalized,
          conns,
          false,
        );
        if (!resolved.ok) {
          setError(resolved.error);
        }
      })();
    }
  }

  async function saveKeyMapToProject(
    map: KeyMapDef,
    opts?: Parameters<typeof saveKeyMapToProjectImpl>[1],
  ): Promise<KeyMapSaveResult> {
    mapWritesInFlight.current += 1;
    try {
      return await saveKeyMapToProjectImpl(map, opts);
    } finally {
      mapWritesInFlight.current -= 1;
    }
  }

  async function saveKeyMapToProjectImpl(
    map: KeyMapDef,
    opts?: {
      /** When set (e.g. check Confirm), prefer this over editor capture/tab delta. */
      dirtyDelta?: import("./lib/bridge").KeyMapDirtyDelta | null;
    },
  ): Promise<KeyMapSaveResult> {
    if ((map.storage?.kind ?? "seed") === "source") {
      const refusal = importWriteRefusal(project.pg_import, map.id);
      if (refusal) {
        const result = sourceSaveSkipped(refusal);
        setExportMsg(result.message);
        return result;
      }
    }
    // Persist to project AST first (local). External sync reports separately.
    setProject((p) => upsertKeyMapIntoProject(p, map));
    setSelectedKeyMapId(map.id);
    const kind = map.storage?.kind ?? "seed";
    if (kind === "seed") {
      // Settle only if tab still holds the revision we published (R1).
      const savedFp = keyMapEntriesFingerprint(map);
      const settleSeed = () =>
        patchKeyMapTab(map.id, (s) => settleSeedDraftAfterSave(s, savedFp));
      const exportPath = project.last_dbt_export_path;
      if (!exportPath) {
        settleSeed();
        const result = seedSaveResult({ exportPath: null });
        setExportMsg(result.message);
        return result;
      }
      try {
        await pushKeyMapToExport(exportPath, map);
        settleSeed();
        const result = seedSaveResult({ exportPath });
        setExportMsg(result.message);
        setError(null);
        return result;
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        const result = seedSaveResult({ exportPath, syncError: msg });
        setError(
          result.external === "conflict"
            ? msg
            : `Mapping saved in project, but seed sync failed: ${msg}`,
        );
        setExportMsg(
          result.external === "conflict"
            ? "Mapping saved in project · seed CONFLICT"
            : "Mapping saved in project · seed sync FAILED",
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
        const result = sourceSaveSkipped(resolved.error);
        setError(resolved.error);
        setExportMsg("Mapping saved in project · warehouse write skipped");
        return result;
      }
      const tab = keyMapTabs.find((t) => t.map.id === map.id);
      const expectedHash = tab?.contentHash;
      const bindingAtStart = keyMapBindingFingerprint(map);
      // One in-flight WH Save per mapping.
      if (tab?.saveInFlight || tab?.saveApi?.isSaving()) {
        const result = sourceSaveSkipped("Mapping save already in progress");
        setExportMsg(result.message);
        return result;
      }
      const forcedDelta = opts?.dirtyDelta;
      const captured =
        forcedDelta !== undefined ? null : (tab?.saveApi?.captureSave() ?? null);
      if (forcedDelta === undefined && tab?.saveApi && !captured) {
        const result = sourceSaveSkipped("Mapping save already in progress");
        setExportMsg(result.message);
        return result;
      }
      const saveToken = captured?.token;
      const delta =
        forcedDelta !== undefined
          ? forcedDelta
          : (captured?.delta ?? tab?.dirtyDelta ?? null);
      if (!dirtyDeltaHasChanges(delta)) {
        if (saveToken != null) tab?.saveApi?.abortSave(saveToken);
        // ADR-0022: never full-sync from a paged/empty local cache (would wipe WH).
        const result = sourceSaveSkipped(
          "Mapping saved in project · no dirty rows — warehouse unchanged",
        );
        setExportMsg(result.message);
        setError(null);
        return result;
      }
      patchKeyMapTab(map.id, (s) => ({ ...s, saveInFlight: true }));
      try {
        const r = await writeKeyMap(
          map,
          resolved.dsn,
          expectedHash,
          delta,
          project.pg_import,
        );
        // Late ack must not settle a rebound tab (different WH relation).
        const settle = { kind: "drop" as "apply" | "drop" };
        patchKeyMapTab(map.id, (s) => {
          if (keyMapBindingFingerprint(s.map) !== bindingAtStart) {
            settle.kind = "drop";
            return { ...s, saveInFlight: false };
          }
          settle.kind = "apply";
          if (tab?.saveApi && saveToken != null) {
            return {
              ...s,
              contentHash: r.content_hash,
              localDraft: false,
              saveInFlight: false,
            };
          }
          return {
            ...s,
            contentHash: r.content_hash,
            dirtyDelta: null,
            localDraft: false,
            dirtyResetSeq: (s.dirtyResetSeq ?? 0) + 1,
            saveInFlight: false,
          };
        });
        if (settle.kind === "apply" && tab?.saveApi && saveToken != null) {
          tab.saveApi.confirmSave(saveToken);
        } else if (settle.kind === "drop" && saveToken != null) {
          tab?.saveApi?.abortSave(saveToken);
        }
        const result = sourceSaveSynced({
          schema: r.schema,
          table: r.table,
          rowsWritten: r.rows_written,
          contentHash: r.content_hash,
        });
        setExportMsg(result.message);
        setError(null);
        return result;
      } catch (e) {
        if (saveToken != null) tab?.saveApi?.abortSave(saveToken);
        patchKeyMapTab(map.id, (s) => ({ ...s, saveInFlight: false }));
        const msg = typeof e === "string" ? e : String(e);
        const result = sourceSaveFailed(msg);
        setError(
          result.external === "conflict"
            ? msg
            : `Mapping saved in project, but warehouse write-back failed: ${msg}`,
        );
        setExportMsg(
          result.external === "conflict"
            ? "Mapping saved in project · warehouse CONFLICT"
            : "Mapping saved in project · warehouse write FAILED",
        );
        return result;
      }
    }
    const savedFp = keyMapEntriesFingerprint(map);
    patchKeyMapTab(map.id, (s) => settleSeedDraftAfterSave(s, savedFp));
    const result = refSaveResult();
    setExportMsg(result.message);
    return result;
  }

  function handleAddKeyMap() {
    const map = emptyKeyMap("Mapping");
    void saveKeyMapToProject(map);
    openKeyMapEditor(map);
    setTreeExpanded((e) => ({ ...e, keyMaps: true }));
  }

  function handleMappingCreateConfirm(plan: MappingCreatePlan) {
    const opId = `create_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    pendingMappingCreateOpIdRef.current = opId;
    dispatchProject({
      type: "create_mapping",
      intent: { opId, plan },
    });
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
    const map = (project.workspace.key_maps ?? []).find((m) => m.id === mapId);
    const exportPath = project.last_dbt_export_path;
    const isSeed =
      !map?.storage || map.storage.kind === "seed";

    setProject((p) => {
      const { workspace } = deleteKeyMapFromWorkspace(p.workspace, mapId);
      return { ...p, workspace };
    });
    if (selectedKeyMapId === mapId) setSelectedKeyMapId(null);
    closeKeyMapTab(mapId);

    // Seed is SoT after export — remove CSV or sync/reopen recreates the map.
    if (exportPath && isSeed) {
      void removeKeyMapFromExport(exportPath, mapId)
        .then((r) => {
          if (r.path) {
            setExportMsg(`Deleted Mapping · removed ${r.path}`);
            void refreshExportTree(exportPath);
          }
        })
        .catch((e) => {
          setError(
            `Mapping removed from project, but seed file could not be deleted: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
    }
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
    fromParts?: string[][],
    cellPatches?: import("./lib/keyMap").LensOutputCell[][],
  ) {
    const merged = mergeFromValuesIntoMap({
      map,
      fromValues,
      joinCtx,
      toValues,
      fromParts,
      cellPatches,
    });
    // Persist into the project so Join Lens can hide mapped unmatched keys immediately.
    setProject((p) => upsertKeyMapIntoProject(p, merged));
    openKeyMapEditor(merged, {
      suggestedFrom: fromValues,
      suggestedFromParts: fromParts,
      joinCtx,
    });
  }

  async function confirmFrozenCheckRemap() {
    if (confirmRemapInFlightRef.current) return;
    const frozenAtStart = frozenRemapLiveRef.current;
    if (!frozenAtStart) return;
    const projectAtStart = projectLiveRef.current;
    const mapAtStart = (projectAtStart.workspace.key_maps ?? []).find(
      (m) => m.id === frozenAtStart.map_id,
    );
    if (!mapAtStart) {
      setError("Mapping missing — refresh the remap preview.");
      return;
    }
    const projectIdAtStart = projectAtStart.id;
    const bindingAtStart = keyMapBindingFingerprint(mapAtStart);
    const revisionAtStart = keyMapRevision(
      mapAtStart,
      projectAtStart.workspace,
    );

    confirmRemapInFlightRef.current = true;
    setConfirmRemapBusy(true);
    try {
      let priorEntries = mapAtStart.entries;
      if (mapAtStart.storage?.kind === "source") {
        let conns = projectAtStart.connections;
        let resolved = resolveKeyMapConnection(
          projectAtStart,
          mapAtStart,
          conns,
          true,
        );
        if (!resolved.ok) {
          try {
            conns = await getGlobalConnections();
            if (conns.length) {
              setProject((p) => ({ ...p, connections: conns }));
            }
            // Re-resolve against live project after await.
            resolved = resolveKeyMapConnection(
              projectLiveRef.current,
              mapAtStart,
              conns.length ? conns : projectLiveRef.current.connections,
              true,
            );
          } catch {
            /* ignore */
          }
        }
        if (!resolved.ok) {
          setError(
            `Cannot read warehouse baselines for Confirm: ${resolved.error}`,
          );
          return;
        }
        try {
          const fromExact = [
            ...new Set(
              frozenAtStart.changes
                .map((c) => c.from.trim())
                .filter(Boolean),
            ),
          ].map((from) => [from]);
          if (fromExact.length === 0) {
            setError(
              "Confirm has no From keys to baseline — stage changes first.",
            );
            return;
          }
          // Bounded exact equality IN — not prefix/ILIKE page + client filter.
          const page = await readKeyMap(mapAtStart, resolved.dsn, {
            fromExact,
          });
          priorEntries = page.entries;
        } catch (e) {
          setError(
            `Cannot read warehouse baselines for Confirm: ${typeof e === "string" ? e : String(e)}`,
          );
          return;
        }
      }

      const liveProject = projectLiveRef.current;
      const liveFrozen = frozenRemapLiveRef.current;
      const liveMap = (liveProject.workspace.key_maps ?? []).find(
        (m) => m.id === frozenAtStart.map_id,
      );
      const stale = confirmContextStillValid({
        frozenAtStart,
        liveFrozen,
        projectIdAtStart,
        liveProjectId: liveProject.id,
        bindingAtStart,
        liveMap,
        bindingOf: keyMapBindingFingerprint,
        workspace: liveProject.workspace,
      });
      if (stale) {
        setError(stale);
        return;
      }
      if (keyMapRevision(liveMap!, liveProject.workspace) !== revisionAtStart) {
        setError(
          "Mapping changed while reading baselines — refresh the remap preview.",
        );
        return;
      }

      const openTab = keyMapTabsLiveRef.current.find(
        (t) => t.map.id === frozenAtStart.map_id,
      );
      const result = confirmFrozenCheckRemapSvc({
        frozen: liveFrozen!,
        workspace: liveProject.workspace,
        checks: liveProject.mapping_checks ?? [],
        priorEntries,
        openTabDirty: openTab?.dirtyDelta,
        openTabLocalDraft: openTab?.localDraft,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      // Commit via reducer (like apply_keymap) — effects run only on applied.
      const opId = `confirm_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      pendingConfirmOpIdRef.current = opId;
      dispatchProject({
        type: "confirm_remap",
        intent: {
          opId,
          nextMap: result.nextMap,
          dirtyDelta: result.dirtyDelta,
          message: result.message,
          projectIdAtStart,
          bindingAtStart,
          expectedMapRevision: frozenAtStart.expected_map_revision,
        },
      });
      // Busy/in-flight cleared by confirmRemapResult effect (or finally if no dispatch).
      return;
    } finally {
      if (pendingConfirmOpIdRef.current == null) {
        confirmRemapInFlightRef.current = false;
        setConfirmRemapBusy(false);
      }
    }
  }

  /**
   * ADR-0042: Apply accepted from Join Lens Auto — merge into KeyMap + ApplyKeyMap
   * without opening the Mapping tab (confirm stays in Lens).
   */
  function handleApplyAcceptedFromLens(
    fromValues: string[],
    toValues: string[],
    opts?: {
      fromParts?: string[][];
      applyColumns?: string[];
      outputColumn?: string;
      fromLabels?: (string | null)[];
      toLabels?: (string | null)[];
    },
  ) {
    if (!joinLensTarget || fromValues.length === 0) return;
    if (frozenRemap) {
      if (toValues.length) {
        setFrozenRemap((prev) =>
          prev ? stageFrozenRemapChanges(prev, fromValues, toValues) : prev,
        );
      }
      return;
    }
    const {
      leftOn: lensLeftOn,
      rightOn: lensRightOn,
      hostQueryId,
      joinStepIndex,
      rightQueryId,
      joinType,
    } = joinLensTarget;
    const planned = planMapFillFromLens({
      probeSide: "left",
      fromValues,
      lensLeftOn,
      lensRightOn,
      hostQueryId,
      joinStepIndex,
      rightQueryId,
      joinType,
      toValues,
      fromParts: opts?.fromParts,
      applyColumns: opts?.applyColumns,
      outputColumn: opts?.outputColumn,
    });
    const { joinCtx, fromParts } = planned;
    const maps = project.workspace.key_maps ?? [];
    const applyLeftOn = joinCtx.applyLeftOn ?? [
      joinCtx.leftOn[0] ?? "key",
    ];
    const preferredId = findApplyKeyMapIdForJoin(
      project.workspace,
      joinCtx,
    );
    const preferred = preferredId
      ? maps.find((m) => m.id === preferredId)
      : undefined;
    const wantNameAttrs =
      (opts?.fromLabels?.some((s) => (s ?? "").trim()) ?? false) ||
      (opts?.toLabels?.some((s) => (s ?? "").trim()) ?? false);
    let base =
      preferred ??
      (() => {
        const arity = applyLeftOn.length;
        const from_columns = arity > 1 ? applyLeftOn : ["from"];
        return {
          ...emptyKeyMap("join aliases"),
          from_columns,
          from_column: from_columns[0],
          editable_columns: wantNameAttrs
            ? ["from_name", "to_name"]
            : [],
        };
      })();
    // Prefer an existing ApplyKeyMap; otherwise a fresh seed — no map-picker hop.
    if (!preferred && maps.length > 0) {
      const colHint = (joinCtx.leftOn[0] ?? joinCtx.rightOn[0] ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      const hinted =
        colHint.length >= 3
          ? maps.find((m) => {
              const hay = `${m.id} ${m.name}`.toLowerCase();
              return hay.includes(colHint);
            })
          : undefined;
      if (hinted) base = hinted;
    }
    if (wantNameAttrs) {
      const editable = new Set(base.editable_columns ?? []);
      editable.add("from_name");
      editable.add("to_name");
      base = { ...base, editable_columns: [...editable] };
    }
    let merged = mergeFromValuesIntoMap({
      map: base,
      fromValues,
      joinCtx,
      toValues,
      fromParts,
    });
    if (wantNameAttrs) {
      merged = {
        ...merged,
        entries: merged.entries.map((e) => {
          const i = fromValues.findIndex((f, idx) => {
            const parts = fromParts?.[idx] ?? [f];
            const ep = e.from_parts?.length ? e.from_parts : [e.from];
            return (
              JSON.stringify(parts.map((p) => p.trim())) ===
              JSON.stringify(ep.map((p) => p.trim()))
            );
          });
          if (i < 0) return e;
          const attrs = { ...(e.attrs ?? {}) };
          const fl = opts?.fromLabels?.[i]?.trim();
          const tl = opts?.toLabels?.[i]?.trim();
          if (fl) attrs.from_name = fl;
          if (tl) attrs.to_name = tl;
          return { ...e, attrs };
        }),
      };
    }
    const withMap = upsertKeyMapIntoProject(project, merged);
    const liveMap =
      (withMap.workspace.key_maps ?? []).find((m) => m.id === merged.id) ??
      merged;
    const plan = resolveApplyPlan(
      liveMap,
      joinCtx,
      "left",
      undefined,
      withMap.workspace,
    );
    if ("error" in plan) {
      setProject(() => withMap);
      setError(plan.error);
      return;
    }
    const fold = applyKeyMapOntoProject(withMap, intentFromApplyPlan(plan));
    setProject(() => fold.project);
    if (fold.result.status === "ok") {
      setExportMsg(
        `Applied ${fromValues.length} accepted alias${fromValues.length === 1 ? "" : "es"} · ${fold.result.mapId}`,
      );
      patchKeyMapTab(fold.result.mapId, (s) => {
        const nextMap =
          (fold.project.workspace.key_maps ?? []).find(
            (m) => m.id === fold.result.mapId,
          ) ?? s.map;
        return { ...s, map: nextMap, joinCtx };
      });
    } else if (fold.result.status === "stale") {
      setError(
        fold.result.reason ||
          "Mapping changed while applying — review Auto and Apply accepted again.",
      );
    } else {
      setError(
        fold.result.reason?.trim() ||
          "Join changed while applying — mapping rows were saved; re-open Apply.",
      );
    }
  }

  function handleMapKeyFromLens(
    side: "left" | "right",
    fromValues: string[],
    opts?: {
      toValues?: string[];
      fromParts?: string[][];
      applyColumns?: string[];
      outputColumn?: string;
      cellPatches?: import("./lib/keyMap").LensOutputCell[][];
      applyAcceptedInPlace?: boolean;
      fromLabels?: (string | null)[];
      toLabels?: (string | null)[];
    },
  ) {
    if (!joinLensTarget || fromValues.length === 0) return;
    if (
      opts?.applyAcceptedInPlace &&
      opts.toValues?.length &&
      opts.toValues.some((t) => t.trim())
    ) {
      handleApplyAcceptedFromLens(fromValues, opts.toValues, {
        fromParts: opts.fromParts,
        applyColumns: opts.applyColumns,
        outputColumn: opts.outputColumn,
        fromLabels: opts.fromLabels,
        toLabels: opts.toLabels,
      });
      return;
    }
    // Check Inspect mode: stage only — do not open/mutate the live map until Confirm.
    if (frozenRemap) {
      if (opts?.toValues?.length) {
        setFrozenRemap((prev) =>
          prev
            ? stageFrozenRemapChanges(prev, fromValues, opts.toValues!)
            : prev,
        );
      }
      return;
    }
    const {
      leftOn: lensLeftOn,
      rightOn: lensRightOn,
      hostQueryId,
      joinStepIndex,
      rightQueryId,
      joinType,
    } = joinLensTarget;
    const maps = project.workspace.key_maps ?? [];
    const planned = planMapFillFromLens({
      probeSide: side,
      fromValues,
      lensLeftOn,
      lensRightOn,
      hostQueryId,
      joinStepIndex,
      rightQueryId,
      joinType,
      toValues: opts?.toValues,
      fromParts: opts?.fromParts,
      applyColumns: opts?.applyColumns,
      outputColumn: opts?.outputColumn,
    });
    const { joinCtx, toValues, fromParts } = planned;
    const cellPatches = opts?.cellPatches;
    const applyLeftOn = joinCtx.applyLeftOn ?? [
      joinCtx.leftOn[0] ?? "key",
    ];
    if (maps.length === 0) {
      const arity = applyLeftOn.length;
      const from_columns = arity > 1 ? applyLeftOn : ["from"];
      openMapWithFromValues(
        {
          ...emptyKeyMap("join aliases"),
          from_columns,
          from_column: from_columns[0],
          entries: fromValues.map((from, i) => {
            const parts = fromParts?.[i] ?? [from];
            return {
              from: parts[0] ?? from,
              from_parts: parts,
              to: toValues?.[i] ?? "",
            };
          }),
        },
        fromValues,
        joinCtx,
        toValues,
        fromParts,
        cellPatches,
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
      openMapWithFromValues(
        preferred,
        fromValues,
        joinCtx,
        toValues,
        fromParts,
        cellPatches,
      );
      setMapSwitchOffer({
        fromValues,
        toValues,
        fromParts,
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
    setMapPickPending({ fromValues, toValues, fromParts, joinCtx });
    setMapSwitchOffer(null);
  }

  function openMapPickerFromSwitchOffer() {
    if (!mapSwitchOffer) return;
    const { fromValues, toValues, fromParts, joinCtx, preferredMapId } =
      mapSwitchOffer;
    setMapPickChoice(preferredMapId);
    setMapPickPending({
      fromValues,
      toValues,
      fromParts,
      joinCtx,
      preferredMapId,
    });
  }

  async function refreshExportTree(exportPath: string | undefined) {
    const ownerUid = projectRef.current.project_uid;
    if (!exportPath) {
      setExportFiles([]);
      return;
    }
    try {
      const files = await listExportTree(exportPath);
      if (projectRef.current.project_uid === ownerUid && projectRef.current.last_dbt_export_path === exportPath) {
        setExportFiles(files);
      }
    } catch {
      if (projectRef.current.project_uid === ownerUid) setExportFiles([]);
    }
  }

  async function handleOpenProject() {
    const path = await open({
      multiple: false,
      filters: [{ name: "DWH Project", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    await openProjectPath(path);
  }

  /**
   * Electron Playwright / website-capture hooks — only when built with
   * `DWH_E2E=1` or `DWH_CAPTURE=1` (both set `import.meta.env.DWH_E2E`).
   * Production / normal electron packs omit these.
   */
  useEffect(() => {
    if (String(import.meta.env.DWH_E2E ?? "") !== "1") return;
    let cancelled = false;
    void import("./lib/e2eBridge").then(
      ({
        e2eArmDescribeHold,
        e2eReleaseDescribeHold,
        e2eWaitDescribeSettled,
        e2eWaitDescribeStarted,
      }) => {
        if (cancelled) return;
        function openPath(path: string) {
          void (async () => {
            try {
              const loaded = await loadProject(path, { remember: true });
              applyLoadedProject(loaded, path);
              setExportMsg(`Opened ${path}`);
              await rememberRecentProject(path);
            } catch (e) {
              setError(typeof e === "string" ? e : String(e));
            }
          })();
        }
        function onE2eOpen(ev: Event) {
          const path = (ev as CustomEvent<{ path?: string }>).detail?.path;
          if (typeof path === "string" && path) openPath(path);
        }
        window.addEventListener("dwh-e2e-open-project", onE2eOpen);
        const w = window as unknown as {
          __dwhE2eOpenProject?: (path: string) => void;
          __dwhE2ePatchProject?: (updater: (p: Project) => Project) => void;
          __dwhE2eSaveProject?: (path: string) => Promise<void>;
          __dwhE2eGetProject?: () => Project;
          __dwhE2eArmDescribeHold?: () => void;
          __dwhE2eReleaseDescribeHold?: () => void;
          __dwhE2eWaitDescribeStarted?: () => Promise<void>;
          __dwhE2eWaitDescribeSettled?: () => Promise<void>;
        };
        w.__dwhE2eOpenProject = openPath;
        w.__dwhE2ePatchProject = (updater) => {
          setProject((p) => updater(p));
        };
        w.__dwhE2eGetProject = () => projectRef.current;
        w.__dwhE2eSaveProject = async (path: string) => {
          const toSave = { ...projectRef.current, root_path: path };
          await saveProject(path, toSave);
          setProject(toSave);
          setExportMsg(`Saved ${path}`);
        };
        w.__dwhE2eArmDescribeHold = e2eArmDescribeHold;
        w.__dwhE2eReleaseDescribeHold = e2eReleaseDescribeHold;
        w.__dwhE2eWaitDescribeStarted = e2eWaitDescribeStarted;
        w.__dwhE2eWaitDescribeSettled = e2eWaitDescribeSettled;
        (
          window as unknown as { __dwhE2eCleanup?: () => void }
        ).__dwhE2eCleanup = () => {
          window.removeEventListener("dwh-e2e-open-project", onE2eOpen);
          delete w.__dwhE2eOpenProject;
          delete w.__dwhE2ePatchProject;
          delete w.__dwhE2eSaveProject;
          delete w.__dwhE2eGetProject;
          delete w.__dwhE2eArmDescribeHold;
          delete w.__dwhE2eReleaseDescribeHold;
          delete w.__dwhE2eWaitDescribeStarted;
          delete w.__dwhE2eWaitDescribeSettled;
        };
      },
    );
    return () => {
      cancelled = true;
      (
        window as unknown as { __dwhE2eCleanup?: () => void }
      ).__dwhE2eCleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- e2e hook once
  }, []);

  // Load app settings + global connections, then restore last project.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let settings: AppSettings = {
        default_target_dialect: "duckdb",
        default_dbt_target: "v1",
        default_execution_engine: "duckdb",
        default_destination_kind: "duckdb",
        dbt_venv_path: "",
        recent_projects: [],
        explorer_width_px: 240,
        inspector_width_px: 300,
        llm: {
          base_url: "",
          model: "",
          api_key: "",
        },
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
      let restored = false;
      try {
        const path = await getLastProjectPath();
        if (cancelled) return;
        if (path) {
          const loaded = await loadProject(path, { remember: true });
          if (cancelled) return;
          applyLoadedProject(loaded, path);
          setExportMsg(`Restored ${path}`);
          const nextRecent = pushRecentProject(settings.recent_projects, path);
          const withRecent = { ...settings, recent_projects: nextRecent };
          setAppSettingsState(withRecent);
          try {
            await setAppSettings(withRecent);
          } catch {
            /* ignore MRU persist on restore */
          }
          restored = true;
        }
      } catch {
        // Missing/corrupt session — fall through to Untitled.
      }
      if (!cancelled && !restored) {
        const initial = {
          ...emptyProject("Untitled", settings),
          connections: globalConns,
        };
        savedProjectFingerprint.current = documentFingerprint(initial);
        setProject(initial);
      }
      // ADR-0023: offer dbt setup when CLI missing and not dismissed.
      try {
        const st = await dbtSetupStatus();
        if (cancelled) return;
        setDbtSetupStatusState(st);
        if (!st.found && !st.dismissed && !settings.dbt_setup_dismissed) {
          setDbtSetupOpen(true);
        }
      } catch {
        /* host too old / offline — skip */
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
        stripQualityInspectionQueries(workspace),
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
        sources,
        projectRefContext(project),
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
      if (switchChoice) return;
      if (e.key === "Escape" && centerTab !== "canvas") {
        e.preventDefault();
        if (centerTab === QUALITY_TAB) openMappingQualityCanvas();
        else if (centerTab === HELP_LAB_TAB) {
          setCenterTab("canvas");
          setSelectedKeyMapId(null);
        } else closeKeyMapTab(centerTab);
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
  }, [workspace, showPgPicker, project.name, project.dbt_target, centerTab, keyMapTabs, switchChoice]);

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

  // Join Lens needs Join payload. Inspect attrs embed Join; lab SqlModel wraps
  // QUALITY_JOIN — resolve via resolveInspectJoinLensTarget (not findIndex alone).
  // Memoize so leftOn/rightOn array identities stay stable across App re-renders
  // (JoinLens effects key off those arrays — new identities → update-depth loops).
  const joinLensTarget = useMemo(() => {
    if (!activeQueryId || !activeQuery || selectedStepIndex === null) {
      return null;
    }
    if (isQualityInspectionQuery(activeQueryId)) {
      return resolveInspectJoinLensTarget(project.workspace, activeQuery);
    }
    if (isFullQualityJoin(activeQueryId)) return null;
    const step = activeQuery.steps[selectedStepIndex];
    if (step?.type !== "Join" || step.payload.left_on.length === 0) {
      return null;
    }
    return {
      hostQueryId: activeQueryId,
      joinStepIndex: selectedStepIndex,
      rightQueryId: targetKey(step.payload.right_query_id),
      leftOn: step.payload.left_on,
      rightOn: step.payload.right_on,
      joinType: step.payload.join_type,
    };
  }, [activeQueryId, activeQuery, selectedStepIndex, project.workspace]);

  /** Stable ProjectRef for JoinLens memo — fresh object every render breaks memo. */
  const joinLensProjectRef = useMemo(
    () => projectRefContext(project),
    [
      project.root_path,
      project.project_uid,
      project.references,
      project.connection_bindings,
      project.execution_engine,
      project.target_dialect,
    ],
  );

  /** Columns to pick from — prefer live preview of the active/focus query. */
  // When editing SelectColumns, load columns from the query truncated *before* that step
  // so the picker still lists fields that the step currently drops.
  useEffect(() => {
    if (
      !activeQueryId ||
      selectedStepIndex === null ||
      selectedStep?.type !== "SelectColumns"
    ) {
      setUpstreamColumnNames((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    let cancelled = false;
    const hostId = activeQueryId;
    const upto = selectedStepIndex;
    const upstreamSteps =
      activeQuery?.steps.slice(0, upto) ?? [];
    if (upstreamSteps.length === 0) {
      setUpstreamColumnNames((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    const leftWs: Workspace = {
      ...project.workspace,
      focus_query_id: hostId,
      queries: project.workspace.queries.map((q) =>
        q.id === hostId ? { ...q, steps: upstreamSteps } : q,
      ),
    };
    void previewWorkspace(
      leftWs,
      connections,
      sources,
      projectRefContext(project),
    )
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
          setError("Apply Mapping needs a prior step");
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
    { id: "ApplyKeyMap", label: "Apply Mapping" },
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
        return "Apply Mapping";
      default:
        return step.type;
    }
  }

  const canCopySql =
    bottomTab === "model" ? Boolean(modelPreview?.sql) : Boolean(preview?.sql);

  return (
    <div className="flex h-screen flex-col text-slate-100">
      {switchChoice && <ProjectSwitchDialog name={project.name}
        hasDrafts={hasUnsavedEditorDrafts()} onChoose={switchChoice} />}
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
        recentProjects={appSettings.recent_projects ?? []}
        onOpenRecent={(p) => void handleOpenRecentProject(p)}
        onClearRecent={() => void handleClearRecent()}
        onOptions={() => setOptionsOpen(true)}
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
        explorerVisible={!explorerCollapsed}
        inspectorVisible={!inspectorCollapsed}
        onToggleExplorer={() =>
          setExplorerCollapsedPersist(!explorerCollapsed)
        }
        onToggleInspector={() =>
          setInspectorCollapsedPersist(!inspectorCollapsed)
        }
        onFocusJoinLens={focusJoinLensLayout}
        onCopySql={() => void copySql()}
        onNewConnection={() => openNewConnection("postgres")}
        onSetExecutionEngine={handleSetExecutionEngine}
        onSetDestinationKind={handleSetDestinationKind}
        onSetDestinationConnection={handleSetDestinationConnection}
        onSetTargetDialect={(d: WarehouseDialect) =>
          handleSetTargetDialect(d)
        }
        onLoadDemo={(id) => void handleLoadDemo(id)}
        onOpenHelpLab={() => {
          setCenterTab(HELP_LAB_TAB);
          setSelectedKeyMapId(null);
        }}
        onOpenHelp={() => setHelpOpen(true)}
        onZoomIn={() => void windowAction("zoom-in")}
        onZoomOut={() => void windowAction("zoom-out")}
        onZoomReset={() => void windowAction("zoom-reset")}
        onToggleFullscreen={() => void windowAction("toggle-fullscreen")}
        onCloseWindow={() => void windowAction("close")}
      />

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {checkSetup && (
        <MappingCheckSetupDialog
          open
          mode={checkSetup.mode}
          mapName={checkSetup.mapName}
          hostName={checkSetup.hostName}
          leftOn={checkSetup.leftOn}
          rightOn={checkSetup.rightOn}
          leftColumns={checkSetup.leftColumns}
          rightColumns={checkSetup.rightColumns}
          inferred={checkSetup.inferred}
          initial={checkSetup.initial}
          onClose={() => setCheckSetup(null)}
          onConfirm={confirmMappingCheckSetup}
        />
      )}
      {addRefPending && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddRefPending(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-ref-title"
            className="w-full max-w-sm rounded-xl border border-slate-700 bg-[#0a1219] p-4 shadow-2xl shadow-black/50"
          >
            <h2
              id="add-ref-title"
              className="text-sm font-semibold text-teal-100"
            >
              Add reference
            </h2>
            <p className="mt-1 text-[11px] text-slate-500">
              Alias used in pickers and on the canvas. Does not change export
              names.
            </p>
            <label className="mt-3 block text-[10px] uppercase tracking-wide text-slate-500">
              Alias
              <input
                autoFocus
                value={addRefPending.alias}
                onChange={(e) =>
                  setAddRefPending((p) =>
                    p ? { ...p, alias: e.target.value } : p,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirmAddReference();
                  if (e.key === "Escape") setAddRefPending(null);
                }}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
                onClick={() => setAddRefPending(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-teal-400"
                onClick={() => void confirmAddReference()}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
      <OptionsDialog
        open={optionsOpen}
        settings={appSettings}
        onClose={() => setOptionsOpen(false)}
        onSave={(next) => persistAppSettings(next)}
      />
      <DbtSetupDialog
        open={dbtSetupOpen}
        status={dbtSetupStatusState}
        variant="first-run"
        onClose={() => setDbtSetupOpen(false)}
        onInstalled={async (venvPath) => {
          const next = {
            ...appSettings,
            dbt_venv_path: venvPath,
            dbt_setup_dismissed: true,
          };
          await persistAppSettings(next);
          setDbtSetupOpen(false);
          setExportMsg(`dbt installed → ${venvPath}`);
        }}
        onDismiss={async () => {
          await persistAppSettings({
            ...appSettings,
            dbt_setup_dismissed: true,
          });
        }}
      />
      {opProgress && <OpProgress state={opProgress} />}

      <MappingCreateWizard
        open={mappingCreateOpen}
        project={project}
        onCancel={() => setMappingCreateOpen(false)}
        onConfirm={handleMappingCreateConfirm}
      />

      {frozenRemap && (
        <div
          className="fixed inset-x-0 bottom-0 z-[81] border-t border-amber-800/50 bg-[#140f08]/95 px-4 py-3 shadow-[0_-8px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
          role="status"
        >
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 text-[12px]">
            <div className="min-w-0 text-amber-100/90">
              <span className="font-medium text-amber-50">
                Check remap preview
              </span>
              <span className="mx-2 text-amber-500/80">·</span>
              <span className="text-amber-200/80">
                {frozenRemap.changes.length} staged From→To · locked map
                revision {frozenRemap.expected_map_revision.slice(0, 24)}…
              </span>
              {frozenRemap.expected_input_revisions.some(
                (r) => r.revision == null,
              ) && (
                <p className="mt-1 text-[11px] text-amber-200/70">
                  Some inputs are not versioned — confirm is mapping-gated for
                  those; file / live source changes may not invalidate this
                  preview.
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className="rounded border border-amber-700/60 px-2.5 py-1 text-amber-100 hover:bg-amber-500/10"
                onClick={() => setFrozenRemap(null)}
              >
                Discard
              </button>
              <button
                type="button"
                className="rounded border border-amber-400/50 bg-amber-500/15 px-2.5 py-1 font-medium text-amber-50 hover:bg-amber-500/25 disabled:opacity-40"
                disabled={
                  !frozenRemap.changes.length || confirmRemapBusy
                }
                onClick={() => confirmFrozenCheckRemap()}
              >
                Confirm into KeyMap
              </button>
            </div>
          </div>
        </div>
      )}

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
              <span className="text-slate-300">Mapping tab</span> (next to
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
                    const arity =
                      pending.fromParts?.find((p) => p.length)?.length ?? 1;
                    const from_columns =
                      arity > 1 && pending.joinCtx.leftOn.length >= arity
                        ? pending.joinCtx.leftOn.slice(0, arity)
                        : ["from"];
                    openMapWithFromValues(
                      {
                        ...emptyKeyMap("join aliases"),
                        from_columns,
                        from_column: from_columns[0],
                        entries: pending.fromValues.map((from, i) => {
                          const parts = pending.fromParts?.[i] ?? [from];
                          return {
                            from: parts[0] ?? from,
                            from_parts: parts,
                            to: pending.toValues?.[i] ?? "",
                          };
                        }),
                      },
                      pending.fromValues,
                      pending.joinCtx,
                      pending.toValues,
                      pending.fromParts,
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
                    pending.fromParts,
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
      <PgImportWizard
        open={showPgImport}
        project={project}
        connectionId={pgImportConnectionId}
        dirtyMapIds={keyMapTabs
          .filter(
            (t) =>
              Boolean(t.localDraft) ||
              dirtyDeltaHasChanges(t.dirtyDelta ?? null),
          )
          .map((t) => t.map.id)}
        saveInFlightMapIds={keyMapTabs
          .filter((t) => t.saveInFlight)
          .map((t) => t.map.id)}
        onClose={() => setShowPgImport(false)}
        onRequestNewConnection={() => openNewConnection("postgres")}
        onCommitted={(outcome, submitted) => {
          if (submitted !== projectRef.current) {
            setShowPgImport(false);
            setError(
              "Проект изменился во время импорта. Результат не применён — повторите проверку.",
            );
            return;
          }
          setProject(outcome.project);
          setShowPgImport(false);
          const focus = outcome.focus_query_id;
          if (focus) {
            setCenterTab("canvas");
            setActiveQueryId(focus);
            const query = outcome.project.workspace.queries.find(
              (q) => q.id === focus,
            );
            const idx = outcome.focus_step_index ?? 0;
            const step = query?.steps[idx];
            if (step) {
              setSelectedStepIndex(idx);
              loadStepIntoEditor(step);
            }
            if (outcome.open_join_lens) {
              setJoinLensOn(true);
              setBottomTab("data");
            }
          }
          setKeyMapTabs((tabs) =>
            tabs.map((t) => {
              if (!outcome.touched_map_ids.includes(t.map.id)) return t;
              const fresh = (outcome.project.workspace.key_maps ?? []).find(
                (m) => m.id === t.map.id,
              );
              if (!fresh) return t;
              return {
                ...t,
                map: fresh,
                dirtyResetSeq: (t.dirtyResetSeq ?? 0) + 1,
                localDraft: false,
                dirtyDelta: null,
              };
            }),
          );
        }}
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
      <HiveParquetDialog
        open={showHiveDialog}
        confirmLabel={pickerIntent === "source" ? "Add source" : "Add as query"}
        onClose={() => setShowHiveDialog(false)}
        onSelect={(path) => {
          if (pickerIntent === "source") {
            addSourceOnlyHive(path);
          } else {
            addFileQuery(
              path,
              "parquet",
              undefined,
              parquetSourceName(path),
              true,
            );
            setShowHiveDialog(false);
          }
        }}
      />

      {empty && centerTab !== HELP_LAB_TAB ? (
        <EmptyHero
          onOpenHelpLab={() => {
            setCenterTab(HELP_LAB_TAB);
            setSelectedKeyMapId(null);
          }}
          onLoadDemo={(id) => void handleLoadDemo(id)}
          onAddCsv={() => void addCsvQuery()}
          onAddParquet={() => void addParquetQuery()}
          onAddHiveParquet={() => openHiveDialog("query")}
          onAddPostgres={() => openPgPicker("query")}
          onAddSqlModel={() => addSqlModelQuery()}
        />
      ) : empty && centerTab === HELP_LAB_TAB ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Workspace"
            className="flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-[var(--line)] bg-[#060d14]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={false}
              onClick={() => setCenterTab("canvas")}
              className="shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
            >
              Pipeline canvas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected
              className="shrink-0 border-r border-[var(--line)] bg-[#0a1520] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-200"
            >
              Help Lab
            </button>
          </div>
          <HelpLab onOpenLab={(id) => void handleLoadDemo(id)} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Explorer — fully collapsible like a VS Code side bar */}
          {!explorerCollapsed && (
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
                referenceStatuses={refStatuses}
                referenceCatalogs={refCatalogs}
                onAddReference={() => void handleAddReference()}
                onRefreshReference={(r) => void handleRefreshReference(r)}
                onRelinkReference={(r) => void handleRelinkReference(r)}
                onOpenReferenceOwner={(r) => void handleOpenReferenceOwner(r)}
                onRemoveReference={(r) => void handleRemoveReference(r)}
                onUseReferencedQuery={useReferencedQuery}
                onAddConnection={() => openNewConnection("postgres")}
                onImportPostgres={(connectionId) => {
                  if (!connectionId) {
                    openNewConnection("postgres");
                    return;
                  }
                  setPgImportConnectionId(connectionId);
                  setShowPgImport(true);
                }}
                onAddSourceCsv={() => void addSourceOnlyCsv()}
                onAddSourceParquet={() => void addSourceOnlyParquet()}
                onAddSourceHiveParquet={() => openHiveDialog("source")}
                onAddSourceS3={() => openS3Dialog("source")}
                onAddSourcePostgres={() => openPgPicker("source")}
                onNewQueryCsv={() => void addCsvQuery()}
                onNewQueryParquet={() => void addParquetQuery()}
                onNewQueryHiveParquet={() => openHiveDialog("query")}
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
                onCreateKeyMapFromData={() => setMappingCreateOpen(true)}
                onRenameKeyMap={handleRenameKeyMap}
                onDeleteKeyMap={handleDeleteKeyMap}
              />
            </aside>
          )}
          <PanelResizeHandle
            collapsedRail={explorerCollapsed}
            aria-label={
              explorerCollapsed ? "Show explorer" : "Resize explorer"
            }
            title={
              explorerCollapsed
                ? "Drag right or double-click to show Explorer"
                : "Drag to resize · drag past the edge or double-click to hide Explorer"
            }
            onDelta={(dx) => {
              if (explorerCollapsed) {
                if (dx > 0) {
                  setExplorerCollapsedPersist(false);
                  const next = clampPanelWidth(
                    Math.max(explorerWidthRef.current, 160) + dx,
                    160,
                    480,
                  );
                  explorerWidthRef.current = next;
                  setExplorerWidth(next);
                }
                return;
              }
              const raw = explorerWidthRef.current + dx;
              if (raw < SIDE_PANEL_COLLAPSE_SNAP) {
                setExplorerCollapsedPersist(true);
                return;
              }
              const next = clampPanelWidth(raw, 160, 480);
              explorerWidthRef.current = next;
              setExplorerWidth(next);
            }}
            onDragEnd={() => {
              if (explorerCollapsed) return;
              persistPanelWidths(
                explorerWidthRef.current,
                inspectorWidthRef.current,
              );
            }}
            onDoubleClick={() =>
              setExplorerCollapsedPersist(!explorerCollapsed)
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
                  if (isMappingQualityLab(project.workspace)) {
                    openMappingQualityCanvas();
                  } else {
                    setCenterTab("canvas");
                    setSelectedKeyMapId(null);
                  }
                }}
                className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  centerTab === "canvas"
                    ? "bg-[#0a1520] text-teal-200"
                    : "text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
                }`}
              >
                Pipeline canvas
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={centerTab === HELP_LAB_TAB}
                onClick={() => {
                  setCenterTab(HELP_LAB_TAB);
                  setSelectedKeyMapId(null);
                }}
                className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  centerTab === HELP_LAB_TAB
                    ? "bg-[#0a1520] text-teal-200"
                    : "text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
                }`}
              >
                Help Lab
              </button>
              {(isMappingQualityLab(project.workspace) ||
                (project.mapping_checks?.length ?? 0) > 0) && (
                <button type="button" role="tab" aria-selected={centerTab === QUALITY_TAB}
                  onClick={() => { setCenterTab(QUALITY_TAB); setSelectedKeyMapId(null); }}
                  className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[12px] ${centerTab === QUALITY_TAB ? "bg-[#10251f] text-teal-100" : "text-slate-400 hover:text-teal-200"}`}>
                  ◈ Mapping quality
                </button>
              )}
              {matchingTabs.map((tab) => {
                const key = matchingTabKey(tab.id);
                const on = centerTab === key;
                return (
                  <div
                    key={key}
                    className={`group flex shrink-0 items-stretch border-r border-[var(--line)] ${
                      on ? "bg-[#0a1520]" : "hover:bg-slate-900/50"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setCenterTab(key)}
                      className={`max-w-[16rem] truncate px-3 py-2 text-left text-[12px] ${
                        on
                          ? "text-amber-100"
                          : "text-slate-500 group-hover:text-slate-300"
                      }`}
                      title={tab.title}
                    >
                      {tab.title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          tab.hasUnsavedDecisions &&
                          !window.confirm(
                            "Matching has unsaved decisions. Close this tab? The draft will be lost.",
                          )
                        ) {
                          return;
                        }
                        setMatchingTabs((tabs) =>
                          tabs.filter((t) => t.id !== tab.id),
                        );
                        if (centerTab === key) setCenterTab("canvas");
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

            {activeLabTask && centerTab === "canvas" && (activeLabTask.visible ? (
              <LabTaskCard canStart={reconJoinTarget(project.workspace) !== null}
                onStart={showReconLabStart}
                onDismiss={() => setLabTask((task) => task ? { ...task, visible: false } : null)} />
            ) : (
              <button type="button" data-testid="lab-task-reopen"
                onClick={() => setLabTask((task) => task ? { ...task, visible: true } : null)}
                className="mx-3 mt-1 self-start rounded px-2 py-1 text-xs text-teal-300 hover:bg-teal-500/10">Lab task</button>
            ))}

            {(error || exportMsg) && (
              <div className="shrink-0 space-y-1 px-3 pb-1 pt-2">
                {error && (
                  <ErrorBanner
                    message={error}
                    onDismiss={() => setError(null)}
                  />
                )}
                {exportMsg && (
                  <div className="flex items-start gap-2 rounded-lg border border-teal-900/50 bg-teal-950/30 px-3 py-2 text-sm text-teal-200">
                    <p className="min-w-0 flex-1 leading-snug">{exportMsg}</p>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-teal-400/80 hover:bg-teal-500/10 hover:text-teal-100"
                      onClick={() => setExportMsg(null)}
                      title="Dismiss"
                      aria-label="Dismiss message"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )}

            {centerTab === HELP_LAB_TAB && (
              <div className="flex min-h-0 flex-1 flex-col">
                <HelpLab onOpenLab={(id) => void handleLoadDemo(id)} />
              </div>
            )}

            {centerTab === QUALITY_TAB &&
              (isMappingQualityLab(project.workspace) ||
                (project.mapping_checks?.length ?? 0) > 0) && (
              <div className="flex min-h-0 flex-1 flex-col">
                <MappingQualityOverview
                  active
                  projection={
                    activeMappingCheck?.projection ?? LAB_V1_PROJECTION
                  }
                  attrsJoin={attrsJoinForActiveCheck}
                  onChangeAttrs={
                    activeMappingCheck?.projection.kind === "attrs"
                      ? () =>
                          void openMappingCheckSetup({
                            mode: "edit",
                            checkId: activeMappingCheck.id,
                            mapId: activeMappingCheck.map_id,
                            hostQueryId:
                              activeMappingCheck.projection.kind === "attrs"
                                ? activeMappingCheck.projection.host_query_id
                                : undefined,
                          })
                      : undefined
                  }
                  workspace={project.workspace}
                  connections={project.connections}
                  sources={project.sources}
                  onProgress={onQualityProgress}
                  onCanvas={() => openMappingQualityCanvas()}
                  deltaNote={checkDeltaNote}
                  allowNote={checkAllowNote}
                  onCheckRun={({
                    cells,
                    totalPositions,
                    cellsIncomplete,
                    groupCount,
                    coveredPositions,
                    unmappedPositions,
                  }) => {
                    const check = activeMappingCheck ?? labMappingCheck();
                    const recorded = recordCheckRun({
                      project,
                      check,
                      cells,
                      totalPositions,
                      cellsIncomplete,
                      groupCount,
                      coveredPositions,
                      unmappedPositions,
                    });
                    setCheckDeltaNote(recorded.deltaNote);
                    lastCheckRunFingerprint.current = recorded.run.id;
                    setProject((p) => ({
                      ...p,
                      mapping_checks: recorded.mapping_checks,
                      mapping_check_runs: recorded.mapping_check_runs,
                    }));
                  }}
                  onAllowDifference={(groupKey, explanation) => {
                    const checkId =
                      activeMappingCheck?.id ?? "check_lab_quality";
                    const allowed = allowCheckDifference({
                      checks: project.mapping_checks ?? [],
                      checkId,
                      groupKey,
                      explanation,
                    });
                    if (!allowed.ok) {
                      setError(allowed.error);
                      return;
                    }
                    setProject((p) => ({
                      ...p,
                      mapping_checks: allowed.mapping_checks,
                    }));
                    setCheckAllowNote(allowed.allowNote);
                  }}
                  onInspect={(payload) => {
                    try {
                      const check = activeMappingCheck ?? labMappingCheck();
                      const plan = planCheckInspect({
                        project,
                        check,
                        payload,
                      });
                      setProject((p) => ({
                        ...p,
                        mapping_checks: plan.mapping_checks,
                      }));
                      const focusValue = plan.orderedKeys[0] ?? "";
                      setQueries((qs) =>
                        upsertQualityInspection(qs, plan.sampleQuery),
                      );
                      setActiveQueryId(QUALITY_INSPECTION);
                      // JoinLens mounts only when the selected step is Join
                      // (preview rows + joinCtx). Last step is Filter/Sort — that
                      // left DATA as an empty PreviewTable after Inspect.
                      const joinStepIdx = plan.sampleQuery.steps.findIndex(
                        (s) => s.type === "Join",
                      );
                      setSelectedStepIndex(
                        joinStepIdx >= 0
                          ? joinStepIdx
                          : Math.max(0, plan.sampleQuery.steps.length - 1),
                      );
                      setDiagView(null);
                      setPreview(null);
                      setLensFocusHint(
                        focusValue
                          ? { column: plan.sampleColumn, value: focusValue }
                          : null,
                      );
                      if (plan.frozenRemap) setFrozenRemap(plan.frozenRemap);
                      qualityHandoffRef.current = true;
                      setOpProgress({
                        kind: "quality",
                        phase: plan.progressPhase,
                        percent: 15,
                      });
                      focusJoinLensLayout();
                      setAutoPrepareNonce((n) => n + 1);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                />
              </div>
            )}
            {matchingTabs.map((tab) => {
              const key = matchingTabKey(tab.id);
              const on = centerTab === key;
              return (
                <div
                  key={key}
                  className={on ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                  aria-hidden={!on}
                >
                  <MatchingWorkspace
                    session={tab}
                    onChange={(next) =>
                      setMatchingTabs((tabs) =>
                        tabs.map((t) => (t.id === next.id ? next : t)),
                      )
                    }
                    onOpenLens={() => {
                      setCenterTab("canvas");
                      focusJoinLensLayout();
                    }}
                    writeAllowed={
                      !tab.targetMapId ||
                      importWriteRefusal(project.pg_import, tab.targetMapId) ==
                        null
                    }
                    writeRefusalReason={
                      tab.targetMapId
                        ? importWriteRefusal(
                            project.pg_import,
                            tab.targetMapId,
                          )
                        : null
                    }
                    onSaveToMap={async ({ upserts, session: nextSession }) => {
                      const mapId = nextSession.targetMapId;
                      if (!mapId || !upserts.length) return;
                      const map =
                        project.workspace.key_maps?.find((m) => m.id === mapId) ??
                        keyMapTabs.find((t) => t.map.id === mapId)?.map;
                      if (!map) {
                        setError("Matching Save: target Mapping not found");
                        return;
                      }
                      const fromValues = upserts.map(
                        (u) => u.fromParts[0] ?? "",
                      );
                      const toValues = upserts.map(
                        (u) => u.outputValues[0] ?? "",
                      );
                      const arity = Math.max(
                        ...upserts.map((u) => u.fromParts.length),
                        map.from_columns?.length ?? 1,
                        1,
                      );
                      const stubJoinCtx = {
                        hostQueryId: "",
                        joinStepIndex: 0,
                        rightQueryId: "",
                        leftOn: map.from_columns?.length
                          ? [...map.from_columns]
                          : Array.from({ length: arity }, (_, i) =>
                              i === 0 ? (map.from_column ?? "from") : `from_${i}`,
                            ),
                        rightOn: ["to"],
                        joinType: "left" as const,
                      };
                      const cellPatches = upserts.map((u) =>
                        (map.output_columns?.length
                          ? map.output_columns
                          : ["to"]
                        ).map((column, i) => ({
                          column,
                          value: u.outputValues[i] ?? "",
                        })),
                      );
                      const merged = mergeFromValuesIntoMap({
                        map,
                        fromValues,
                        toValues,
                        fromParts: upserts.map((u) => u.fromParts),
                        cellPatches,
                        joinCtx: stubJoinCtx,
                      });
                      await saveKeyMapToProject(merged);
                      setMatchingTabs((tabs) =>
                        tabs.map((t) =>
                          t.id === nextSession.id ? nextSession : t,
                        ),
                      );
                    }}
                  />
                </div>
              );
            })}
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
                  workspace={project.workspace}
                  connections={project.connections}
                  pickToOptions={keyMapEditor.pickTo}
                  suggestedFrom={keyMapEditor.suggestedFrom}
                  suggestedFromParts={keyMapEditor.suggestedFromParts}
                  dirtyResetSeq={keyMapEditor.dirtyResetSeq}
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
                          leftOnCols: keyMapEditor.joinCtx.leftOn,
                          rightOnCols: keyMapEditor.joinCtx.rightOn,
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
                    patchKeyMapTab(keyMapEditor.map.id, (s) => {
                      const transition = applyKeyMapTabMapChange(s, {
                        ...map,
                        id: keyMapEditor.map.id,
                      });
                      if (!transition.ok) {
                        setError(transition.reason);
                        setExportMsg(transition.reason);
                        return s;
                      }
                      const next = transition.session;
                      const entriesChanged =
                        JSON.stringify(next.map.entries) !==
                        JSON.stringify(s.map.entries);
                      // Seed/ref have no WH dirtyDelta requirement — mark draft
                      // whenever the editor publishes a different entry set.
                      if (entriesChanged) {
                        return { ...next, localDraft: true };
                      }
                      return next;
                    })
                  }
                  onWarehouseRead={(contentHash, totalCount) =>
                    patchKeyMapTab(keyMapEditor.map.id, (s) => {
                      // Freeze concurrency token while dirty — page changes must not
                      // refresh hash over an outstanding row-level baseline delta.
                      const dirty = s.dirtyDelta;
                      const hasDirty =
                        !!dirty &&
                        (dirty.upserts.length > 0 ||
                          dirty.deletedFroms.length > 0 ||
                          (dirty.deletedFromParts?.length ?? 0) > 0);
                      return {
                        ...s,
                        contentHash:
                          hasDirty || s.localDraft ? s.contentHash : contentHash,
                        totalCount,
                      };
                    })
                  }
                  onDirtyChange={(dirtyDelta) =>
                    patchKeyMapTab(keyMapEditor.map.id, (s) => ({
                      ...s,
                      dirtyDelta,
                      localDraft:
                        dirtyDeltaHasChanges(dirtyDelta) || Boolean(s.localDraft),
                    }))
                  }
                  saveInFlight={keyMapEditor.saveInFlight}
                  onSaveApi={(saveApi) =>
                    patchKeyMapTab(keyMapEditor.map.id, (s) => ({
                      ...s,
                      saveApi,
                    }))
                  }
                  onMappingCheck={() =>
                    void openMappingCheckSetup({
                      mode: "create",
                      mapId: keyMapEditor.map.id,
                    })
                  }
                  onOpenMatching={() => {
                    const id = newMatchingSessionId();
                    const map = keyMapEditor.map;
                    const session = emptyMatchingSession({
                      id,
                      title: `Matching: ${map.name || map.id}`,
                      targetMapId: map.id,
                      entry: "mapping",
                      scope: "full",
                      queryOptions: (project.workspace.queries ?? []).map(
                        (q) => q.id,
                      ),
                      instructionText: "",
                      plan: null,
                      hasUnsavedDecisions: false,
                      chatCollapsed: false,
                    });
                    setMatchingTabs((tabs) => [...tabs, session]);
                    setCenterTab(matchingTabKey(id));
                  }}
                  onClose={() => closeKeyMapTab(keyMapEditor.map.id)}
                  importNotice={(() => {
                    const rel = project.pg_import?.relations.find(
                      (r) => r.keymap_id === keyMapEditor.map.id,
                    );
                    if (!rel) return null;
                    if (rel.binding_status === "broken") {
                      return (
                        rel.binding_issues?.join("; ") ||
                        "Binding карты сломан"
                      );
                    }
                    if (rel.quality_notes && rel.quality_notes.length > 0) {
                      return rel.quality_notes.join("; ");
                    }
                    if (!rel.write_back) return "Запись в эту relation не разрешена";
                    return null;
                  })()}
                  importRowsLocked={
                    importWriteRefusal(project.pg_import, keyMapEditor.map.id) != null
                  }
                  onSave={
                    keyMapEditor.joinCtx ||
                    importWriteRefusal(project.pg_import, keyMapEditor.map.id) != null
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
                              `Delete Mapping “${keyMapEditor.map.name}”? Apply Mapping steps that use it will be removed.${
                                project.last_dbt_export_path &&
                                (!keyMapEditor.map.storage ||
                                  keyMapEditor.map.storage.kind === "seed")
                                  ? " The export seed CSV will be deleted too."
                                  : ""
                              }`,
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
                      ? (side, choice) => {
                          const ctx = keyMapEditor.joinCtx!;
                          const map = keyMapEditor.map;
                          void saveKeyMapToProject(map).then((result) => {
                            if (
                              result.external === "conflict" ||
                              result.external === "error"
                            ) {
                              setError(
                                result.message ||
                                  "Mapping save failed — Apply cancelled. Fix the save, then Apply again.",
                              );
                              return;
                            }
                            if (
                              result.external === "skipped" &&
                              /already in progress/i.test(result.message)
                            ) {
                              setError(
                                "Mapping save already in progress — wait for it to finish, then Apply again. Mapping drafts are unchanged.",
                              );
                              return;
                            }
                            // ADR-0038: one resolve → ApplyPlan; App does not invent bindings.
                            const plan = resolveApplyPlan(
                              map,
                              ctx,
                              side,
                              choice
                                ? {
                                    side,
                                    bindings: choice.bindings,
                                    joinRewrite: choice.joinRewrite,
                                  }
                                : undefined,
                              project.workspace,
                            );
                            if ("error" in plan) {
                              setError(plan.error);
                              return;
                            }
                            dispatchProject({
                              type: "apply_keymap",
                              intent: intentFromApplyPlan(plan),
                            });
                          });
                        }
                      : undefined
                  }
                />
              </div>
            ))}

            {/* Keep mounted while a Mapping tab is active so Join Lens (mode, scroll,
                selection, chat) survives open/close of the map editor. */}
            <div
              ref={canvasDockStackRef}
              className={
                centerTab === "canvas"
                  ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                  : "hidden"
              }
              aria-hidden={centerTab !== "canvas"}
            >
            <div className="min-h-0 flex-1 overflow-hidden px-3 pb-1 pt-2">
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
                externalBoundaries={externalBoundaries}
                selectedExternalKey={selectedExternalKey}
                onSelectExternal={selectExternalBoundary}
                onDeriveExternal={deriveFromExternalKey}
              />
            </div>
            <PanelResizeHandle
              orientation="horizontal"
              aria-label="Resize data panel"
              title="Drag to resize · double-click to maximize Join Lens / Data (collapse graph)"
              onDelta={(dy) => {
                dockDraggingRef.current = true;
                const stackH =
                  canvasDockStackRef.current?.clientHeight ?? 0;
                const next = clampBottomDockHeight(
                  bottomDockHeightRef.current - dy,
                  stackH,
                );
                bottomDockHeightRef.current = next;
                bottomDockRestoreRef.current = null;
                // One React commit per frame — continuous setState storms
                // React Flow ResizeObservers ("loop completed…").
                if (dockHeightRafRef.current) return;
                dockHeightRafRef.current = requestAnimationFrame(() => {
                  dockHeightRafRef.current = 0;
                  setBottomDockHeight(bottomDockHeightRef.current);
                });
              }}
              onDoubleClick={() => {
                const stackH =
                  canvasDockStackRef.current?.clientHeight ?? 0;
                if (stackH <= 0) return;
                const maxH = clampBottomDockHeight(stackH, stackH);
                setBottomDockHeight((h) => {
                  const nearMax = h >= maxH - 12;
                  const next = nearMax
                    ? clampBottomDockHeight(
                        bottomDockRestoreRef.current ?? 360,
                        stackH,
                      )
                    : maxH;
                  if (!nearMax) bottomDockRestoreRef.current = h;
                  else bottomDockRestoreRef.current = null;
                  bottomDockHeightRef.current = next;
                  try {
                    localStorage.setItem(
                      BOTTOM_DOCK_HEIGHT_KEY,
                      String(next),
                    );
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }}
              onDragEnd={() => {
                dockDraggingRef.current = false;
                if (dockHeightRafRef.current) {
                  cancelAnimationFrame(dockHeightRafRef.current);
                  dockHeightRafRef.current = 0;
                }
                setBottomDockHeight(bottomDockHeightRef.current);
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
              className="flex shrink-0 flex-col overflow-hidden border-t border-[var(--line)] bg-[#060d14]"
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
                  {bottomTab === "data" &&
                    !diagView &&
                    !joinLensOn &&
                    isHeavyPreviewFocus(
                      project.workspace,
                      dataWorkspace?.focus_query_id ||
                        activeQueryId ||
                        focusQueryId,
                    ) && (
                    <>
                      <span
                        className="rounded border border-slate-700/80 px-2 py-0.5 text-[10px] text-slate-400"
                        title={
                          previewMode === "full"
                            ? "Full preview — no output row LIMIT"
                            : `Sample — LIMIT ${PREVIEW_SAMPLE_LIMIT}`
                        }
                      >
                        {previewMode === "full"
                          ? "Full preview"
                          : `Sample · LIMIT ${PREVIEW_SAMPLE_LIMIT}`}
                      </span>
                      {previewMode === "sample" ? (
                        <button
                          type="button"
                          data-testid="preview-load-full"
                          disabled={loading || !dataWorkspace}
                          onClick={() => {
                            if (!dataWorkspace) return;
                            void runPreview(
                              dataWorkspace,
                              connections,
                              sources,
                              projectRefContext(project),
                              "full",
                            );
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
                            void runPreview(
                              dataWorkspace,
                              connections,
                              sources,
                              projectRefContext(project),
                              "sample",
                            );
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
                            setDiagView(null);
                            setJoinLensOn(true);
                            setForceProbeNonce((n) => n + 1);
                          }}
                        >
                          Open No match
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
                        enabled={
                          joinLensOn &&
                          !overlayOpen &&
                          centerTab === "canvas"
                        }
                        workspace={project.workspace}
                        hostQueryId={joinLensTarget.hostQueryId}
                        joinStepIndex={joinLensTarget.joinStepIndex}
                        rightQueryId={joinLensTarget.rightQueryId}
                        leftOn={joinLensTarget.leftOn}
                        rightOn={joinLensTarget.rightOn}
                        connections={connections}
                        sources={sources}
                        projectRef={joinLensProjectRef}
                        columns={preview.columns}
                        rows={preview.rows}
                        joinDiag={joinDiag}
                        joinDiagLoading={joinDiagLoading}
                        forceProbeNonce={forceProbeNonce}
                        autoPrepareNonce={autoPrepareNonce}
                        focusResultHint={lensFocusHint}
                        onApplyNearMiss={handleApplyNearMiss}
                        onMapKey={handleMapKeyFromLens}
                        onPrepareBusy={setLensPrepareBusy}
                        onRunDiagnostics={runJoinDiagnostics}
                        onOpenMatching={(opts) => {
                          const id = newMatchingSessionId();
                          const sourceRef =
                            opts.leftSourceQueryId || opts.hostQueryId;
                          const title = `Matching: ${sourceRef} → ${opts.rightQueryId}`;
                          const queryOptions = (
                            project.workspace.queries ?? []
                          ).map((q) => q.id);
                          const plan = buildLensMatchingPlan({
                            leftOn: opts.leftOn,
                            rightOn: opts.rightOn,
                            sourceRef,
                            targetRef: opts.rightQueryId,
                            sourceColumns: opts.sourceColumns,
                            targetColumns: opts.targetColumns,
                            scope: opts.scope,
                          });
                          const session = emptyMatchingSession({
                            id,
                            title,
                            entry: "lens",
                            scope: opts.scope,
                            lensCtx: {
                              hostQueryId: opts.hostQueryId,
                              joinStepIndex: opts.joinStepIndex,
                              leftOn: opts.leftOn,
                              rightOn: opts.rightOn,
                              rightQueryId: opts.rightQueryId,
                              leftSourceQueryId: opts.leftSourceQueryId,
                              sourceColumns: opts.sourceColumns,
                              targetColumns: opts.targetColumns,
                            },
                            queryOptions,
                            instructionText: "",
                            plan,
                            hasUnsavedDecisions: false,
                            chatCollapsed: false,
                          });
                          setMatchingTabs((tabs) => [...tabs, session]);
                          setCenterTab(matchingTabKey(id));
                        }}
                      />
                    ) : preview ? (
                      <PreviewTable
                        columns={preview.columns}
                        rows={preview.rows}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-slate-600">
                        {loading
                          ? "Computing preview…"
                          : "Waiting for preview…"}
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
            </div>
          </section>

          {centerTab !== QUALITY_TAB && <>
          <PanelResizeHandle
            collapsedRail={inspectorCollapsed}
            aria-label={
              inspectorCollapsed ? "Show inspector" : "Resize inspector"
            }
            title={
              inspectorCollapsed
                ? "Drag left or double-click to show Inspector"
                : "Drag to resize · drag past the edge or double-click to hide Inspector"
            }
            onDelta={(dx) => {
              if (inspectorCollapsed) {
                if (dx < 0) {
                  setInspectorCollapsedPersist(false);
                  const next = clampPanelWidth(
                    Math.max(inspectorWidthRef.current, 220) - dx,
                    220,
                    560,
                  );
                  inspectorWidthRef.current = next;
                  setInspectorWidth(next);
                }
                return;
              }
              const raw = inspectorWidthRef.current - dx;
              if (raw < SIDE_PANEL_COLLAPSE_SNAP) {
                setInspectorCollapsedPersist(true);
                return;
              }
              const next = clampPanelWidth(raw, 220, 560);
              inspectorWidthRef.current = next;
              setInspectorWidth(next);
            }}
            onDragEnd={() => {
              if (inspectorCollapsed) return;
              persistPanelWidths(
                explorerWidthRef.current,
                inspectorWidthRef.current,
              );
            }}
            onDoubleClick={() =>
              setInspectorCollapsedPersist(!inspectorCollapsed)
            }
          />

          {/* Inspector — fully collapsible like a VS Code side bar */}
          {!inspectorCollapsed && (
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
                  <div className="mb-3 space-y-2">
                    {(selectedStep.type === "LoadCsv" ||
                      selectedStep.type === "LoadParquet") && (
                      <div className="space-y-2 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[10px] text-slate-500">
                            Source step (pinned at s0)
                          </p>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                              (selectedStep.payload.path_kind ?? "absolute") ===
                              "relative"
                                ? "bg-teal-500/20 text-teal-100"
                                : "bg-slate-700/80 text-slate-300"
                            }`}
                            title="ADR-0043 path_kind — relative is vs the project file directory"
                          >
                            {selectedStep.payload.path_kind ?? "absolute"}
                          </span>
                        </div>
                        <p
                          className="break-all font-mono text-[11px] text-slate-300"
                          title={selectedStep.payload.path}
                        >
                          {selectedStep.payload.path}
                        </p>
                        {!project.root_path && (
                          <p className="text-[10px] text-amber-200/80">
                            Save the project to store paths relative to the
                            project file.
                          </p>
                        )}
                        <button
                          type="button"
                          className="w-full rounded-lg border border-teal-800/80 bg-teal-500/10 px-3 py-1.5 text-xs font-semibold text-teal-100 hover:bg-teal-500/20 disabled:opacity-40"
                          disabled={
                            selectedStep.type === "LoadParquet" &&
                            !!selectedStep.payload.connection_id
                          }
                          title={
                            selectedStep.type === "LoadParquet" &&
                            selectedStep.payload.connection_id
                              ? "Remote Parquet — use S3 / connection picker"
                              : "Pick another file for this Load step"
                          }
                          onClick={() => void changeSelectedLoadFile()}
                        >
                          Change file…
                        </button>
                      </div>
                    )}
                    {selectedStep.type === "LoadPostgres" && (
                      <p className="rounded-md border border-slate-800 bg-slate-950/60 px-2 py-2 font-mono text-[11px] text-slate-400">
                        Source step (pinned at s0). Table comes from the Postgres
                        import / picker.
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
                          <optgroup label="This project">
                            {otherQueries.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.name}
                              </option>
                            ))}
                          </optgroup>
                          {Object.entries(refCatalogs).map(([rid, cat]) =>
                            cat.queries.length > 0 ? (
                              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                                {cat.queries.map((q) => (
                                  <option
                                    key={`${rid}:${q.id}`}
                                    value={targetKey(
                                      externalTarget(rid, "query", q.id),
                                    )}
                                  >
                                    {cat.alias}.{q.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null,
                          )}
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
                              payload: {
                                query_id: objectTargetFromPicker(fromQueryId),
                              },
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
                          disabled={
                            otherQueries.length === 0 &&
                            Object.values(refCatalogs).every(
                              (c) => c.queries.length === 0,
                            )
                          }
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
                        >
                          <option value="">right query…</option>
                          <optgroup label="This project">
                            {otherQueries.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.name}
                              </option>
                            ))}
                          </optgroup>
                          {Object.entries(refCatalogs).map(([rid, cat]) =>
                            cat.queries.length > 0 ? (
                              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                                {cat.queries.map((q) => (
                                  <option
                                    key={`${rid}:${q.id}`}
                                    value={targetKey(
                                      externalTarget(rid, "query", q.id),
                                    )}
                                  >
                                    {cat.alias}.{q.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null,
                          )}
                        </select>
                        {otherQueries.length === 0 &&
                          Object.values(refCatalogs).every(
                            (c) => c.queries.length === 0,
                          ) && (
                          <p className="text-[11px] text-amber-500/90">
                            Need another query (local or referenced) to join.
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
                                right_query_id:
                                  objectTargetFromPicker(joinRightId),
                                join_type: joinType,
                                left_on,
                                right_on,
                              },
                            });
                          }}
                        >
                          Apply
                        </button>
                        {activeQueryId &&
                          selectedStepIndex != null &&
                          (() => {
                            const hosts = (
                              project.workspace.key_maps ?? []
                            ).flatMap((m) =>
                              findJoinHostsForMap(queries, m.id)
                                .filter(
                                  (h) =>
                                    h.host.id === activeQueryId &&
                                    h.joinStepIndex === selectedStepIndex,
                                )
                                .map((h) => ({ map: m, host: h })),
                            );
                            const hit = hosts[0];
                            if (!hit) return null;
                            return (
                              <button
                                type="button"
                                className="w-full rounded-lg border border-teal-800/40 bg-teal-950/40 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/15"
                                onClick={() =>
                                  void openMappingCheckSetup({
                                    mode: "create",
                                    mapId: hit.map.id,
                                    hostQueryId: activeQueryId,
                                    joinStepIndex: selectedStepIndex,
                                  })
                                }
                              >
                                Mapping check… ({hit.map.name})
                              </button>
                            );
                          })()}
                        <JoinDiagnosticsPanel
                          loading={joinDiagLoading}
                          error={joinDiagError}
                          diag={joinDiag}
                          onRun={runJoinDiagnostics}
                          onPrepare={runPrepareJoinInputs}
                          prepareLoading={joinPrepareLoading}
                          prepareLabel={joinPrepareLabel}
                          onCancel={cancelHeavyQuery}
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
                          <optgroup label="This project">
                            {otherQueries.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.name}
                              </option>
                            ))}
                          </optgroup>
                          {Object.entries(refCatalogs).map(([rid, cat]) =>
                            cat.queries.length > 0 ? (
                              <optgroup key={rid} label={`Ref · ${cat.alias}`}>
                                {cat.queries.map((q) => (
                                  <option
                                    key={`${rid}:${q.id}`}
                                    value={targetKey(
                                      externalTarget(rid, "query", q.id),
                                    )}
                                  >
                                    {cat.alias}.{q.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null,
                          )}
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
                              payload: {
                                other_query_ids: [
                                  objectTargetFromPicker(appendOtherId),
                                ],
                              },
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
                                key={`akm-asof-${selectedStepIndex}-${selectedStep.payload.as_of_column ?? ""}`}
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
                                      key={`${rid}:${m.id}`}
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
                            const el = document.getElementById(
                              "apply-keymap-col",
                            ) as HTMLInputElement | null;
                            const asOfEl = document.getElementById(
                              "apply-keymap-asof",
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
              </>
              )}
            </div>
          </aside>
          )}
          </>}
        </div>
      )}
    </div>
  );
}

export default App;
