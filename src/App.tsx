import { QueryWorkspace } from "./components/query/QueryWorkspace";
import type { JoinDraftReader } from "./components/query/QueryStepEditor";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { type SwitchDecision } from "./app/projectLifecycle";
import { ProjectController, type ProjectControllerPorts } from "./app/projectController";
import { useJoinDiagnostics } from "./app/joinDiagnostics/useJoinDiagnostics";
import type { JoinInput } from "./app/joinDiagnostics/controller";
import { resetProjectSession } from "./app/projectSessionReset";
import {
  createQueryEditingService, type QueryEditingService, type QueryEditResult,
} from "./app/queryEditing/service";
import {
  captureJoinTarget, createQueryNavigation, isCurrentQueryContext, joinTargetUnavailable,
  transitionQueryContext, type QueryContext, type QueryDestination,
} from "./app/queryNavigation";
import { ProjectSwitchDialog } from "./components/ProjectSwitchDialog";
import { LabTaskCard } from "./components/LabTaskCard";
import { LabHint } from "./components/LabHint";
import { previewScopeLabel } from "./help/previewState";
import { ownsLabTask, reconComparisonTargets, reconHintPhase, reconJoinTarget, type LabTaskSession, type ReconView } from "./help/reconLab";

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
import {
  QUERY_TAB, HELP_TAB, QUALITY_WORKSPACE_TAB, mappingTab, matchingTab,
  tabKey, sameTab, initialTabs, openTab, activateTab, closeTab,
  type WorkspaceTab,
} from "./app/workbench/tabs";
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

import { KeyMapEditor } from "./components/KeyMapEditor";
import { MatchingWorkspace } from "./components/MatchingWorkspace";
import { createMatchingDemoSession } from "./app/matching/executionPolicy";
import { buildLensMatchingPlan } from "./app/matching/planDefaults";
import { matchingSaveRevision, persistMatchingSession } from "./app/matching/persistSave";
import {
  emptyMatchingSession,
  newMatchingSessionId,
  type MatchingTabSession,
} from "./app/matching/types";
import { MappingQualityOverview } from "./components/mapping-quality/MappingQualityOverview";
import { MappingCheckSetupDialog } from "./components/MappingCheckSetupDialog";
import {
  isFullQualityJoin,
  isMappingQualityLab,
  isQualityInspectionQuery,
  stripQualityInspectionQueries,
  upsertQualityInspection,
} from "./lib/mappingQuality";
import {
  keyMapRevision,
  labMappingCheck,
  normalizeAttrsProjection,
  resolveInspectJoinLensTarget,
  type FrozenRemapPreview,
} from "./lib/mappingCheck";
import {
  isHeavyPreviewFocus,
  workspaceForPreviewTransport,
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
import { useQueryPreview } from "./app/queryPreview/useQueryPreview";
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
  pairsToOn,
  suggestJoinPairs,
  type JoinKeyPair,
} from "./lib/joinKeys";
import {
  type CanvasPositions,
  type GraphEdgeInfo,
} from "./components/GraphCanvas";

import {
  PostgresPicker,
  type PostgresSelection,
} from "./components/PostgresPicker";
import { PgImportWizard } from "./components/PgImportWizard";

import { S3SourceDialog } from "./components/S3SourceDialog";

import { bindFilePath } from "./lib/filePath";
import {
  describePostgresObject,
  describeWorkspace,
  exportDbt,
  listExportTree,
  dbtSetupStatus,
  getAppSettings,
  type DbtSetupStatus,
  getGlobalConnections,
  getLastProjectPath,
  copyReferencedObject,
  loadProject,
  loadDemoWorkspace,
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
  projectDestination,
  projectDialect,
  projectEngine,
  routeLabel,
  externalTarget,
  isExternalTarget,
  newId,
  targetKey,
  togglePublishedOutput,
  type ProjectReference,
  syncSourcesFromQueries,
  type ConnectionDef,
  type ConnectionKind,
  type DestinationKind,
  type ExecutionEngine,
  type JoinType,
  type ColumnMetadata,
  parquetSourceName,
  type Project,
  type QueryDef,
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
  queryEditResult: { result: QueryEditResult; session: number } | null;
};

type ProjectBagAction =
  | { type: "set"; updater: (p: Project) => Project }
  | { type: "apply_keymap"; intent: KeyMapApplyIntent }
  | { type: "clear_keymap_apply_result" }
  | { type: "confirm_remap"; intent: ConfirmRemapApplyIntent }
  | { type: "clear_confirm_remap_result" }
  | { type: "create_mapping"; intent: MappingCreateApplyIntent }
  | { type: "clear_mapping_create_result" }
  | { type: "edit_query"; edit: (editing: QueryEditingService) => QueryEditResult;
      ownerId: string; ownerUid: string | undefined; session: number }
  | { type: "clear_query_edit_result"; receipt: NonNullable<ProjectBag["queryEditResult"]> };

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
    case "edit_query": {
      if (state.project.id !== action.ownerId || state.project.project_uid !== action.ownerUid) return state;
      const result = action.edit(createQueryEditingService(state.project));
      return { ...state, project: result.project, queryEditResult: { result, session: action.session } };
    }
    case "clear_query_edit_result":
      return state.queryEditResult === action.receipt ? { ...state, queryEditResult: null } : state;
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
    queryEditResult: null,
  });
  const project = projectBag.project;
  const projectRef = useRef(project);
  projectRef.current = project;
  const lifecycleRef = useRef<ProjectController | null>(null);
  const mapWritesInFlight = useRef(0);
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
    if (!activeQueryId) return;
    queryNavigation.openQuery(activeQueryId, { stepIndex: selectedStepIndex, view: "data", lens: true, focusLens: true });
  }

  function applyJoinLensLayout() {
    setExplorerCollapsedPersist(true);
    setInspectorCollapsedPersist(true);
    setJoinLensOn(true);
    setBottomTab("data");
    setCenterTab(QUERY_TAB);
    maximizeBottomDock();
  }

  /** Canvas from the quality lab without scheduling the 100K join preview/IPC. */
  function openMappingQualityCanvas() {
    if (isFullQualityJoin(activeQueryId)) {
      queryNavigation.openQuery("quality_catalog", { stepIndex: 0, lens: false });
    } else if (isQualityInspectionQuery(activeQueryId)) {
      // Re-entering canvas with an Inspect cohort: keep Join selected so DATA
      // mounts Join Lens instead of an empty post-Filter PreviewTable.
      const q = queries.find((x) => x.id === activeQueryId);
      const joinIdx = q?.steps.findIndex((s) => s.type === "Join") ?? -1;
      if (joinIdx >= 0) {
        queryNavigation.openQuery(q!.id, { stepIndex: joinIdx, lens: true, view: "data" });
      }
    }
    setCenterTab(QUERY_TAB);
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
    const context = queryContextRef.current!;
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
      if (!contextIsCurrent(context)) return;
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
      if (contextIsCurrent(context)) setError(typeof e === "string" ? e : String(e));
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
      setCenterTab(QUALITY_WORKSPACE_TAB);
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
    setCenterTab(QUALITY_WORKSPACE_TAB);
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
  const joinDraftReader = useRef<JoinDraftReader | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(
    null,
  );
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
  /** Navigation identities only; document/session state remains above. */
  const [workbenchTabs, setWorkbenchTabs] = useState(initialTabs);
  const centerTab = workbenchTabs.active;
  function setCenterTab(tab: WorkspaceTab) {
    setWorkbenchTabs((state) => openTab(state, tab));
  }
  function activateCenterTab(tab: WorkspaceTab) {
    setWorkbenchTabs((state) => activateTab(state, tab));
  }
  /** True while the graph↔dock splitter is dragged — skip RO clamp (avoids RO loop). */
  const dockDraggingRef = useRef(false);
  const dockHeightRafRef = useRef(0);
  const stackClampRafRef = useRef(0);

  useEffect(() => {
    if (centerTab.kind !== "query") return;
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
  const [sqlCopied, setSqlCopied] = useState(false);
  const [modelPreview, setModelPreview] = useState<PreviewDbtModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [queryError, setError] = useState<string | null>(null);
  // Project failures must survive unrelated preview completion (ADR-0045).
  const [projectLifecycleError, setProjectLifecycleError] = useState<string | null>(null);
  const error = projectLifecycleError ?? queryError;
  const querySessionGenerationRef = useRef(0);
  /** Bottom dock: sample rows vs generated model SQL (H0 projection; H1 editable later). */
  const [bottomTab, setBottomTab] = useState<"data" | "model">("data");
  const queryContextRef = useRef<QueryContext | null>(null);
  const queryContext = transitionQueryContext(queryContextRef.current, {
    projectUid: project.project_uid, queryId: activeQueryId, stepIndex: selectedStepIndex,
    view: `${tabKey(centerTab)}:${bottomTab}`, mode: joinLensOn ? "lens" : "preview",
    workspace: project.workspace,
    connections: project.connections, sources: project.sources, projectFile: project.root_path,
  });
  queryContextRef.current = queryContext;
  const contextIsCurrent = (captured: QueryContext) =>
    isCurrentQueryContext(captured, queryContextRef.current!) &&
    captured.projectUid === projectRef.current.project_uid && captured.workspace === projectRef.current.workspace &&
    captured.connections === projectRef.current.connections && captured.sources === projectRef.current.sources &&
    captured.projectFile === projectRef.current.root_path;
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportFiles, setExportFiles] = useState<string[]>([]);
  const [otherProgress, setOpProgress] = useState<OpProgressState | null>(null);
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
  const connections = project.connections ?? [];
  const sources = project.sources ?? [];
  const focusQueryId = project.workspace.focus_query_id || null;
  const activeQuery = queries.find((q) => q.id === activeQueryId) ?? null;
  const observeLabLensMode = useCallback((mode: "linked" | "probe" | "auto") => {
    const target = reconJoinTarget(projectRef.current.workspace);
    if (!target || mode !== "probe" || activeQueryId !== target.queryId || selectedStepIndex !== target.stepIndex) return;
    setLabTask((task) => ownsLabTask(task, projectRef.current.project_uid) && task?.hints && !task.completed
      ? { ...task, completed: true } : task);
  }, [activeQueryId, selectedStepIndex, project.project_uid, activeLabTask?.hints, activeLabTask?.completed]);

  function dismissLabHints() {
    setLabTask((task) => task ? { ...task, hints: false } : null);
  }

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

  const centerTabRef = useRef(centerTab);
  centerTabRef.current = centerTab;

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

  const queryPreview = useQueryPreview({
    project, workspace: dataWorkspace,
    enabled: !overlayOpen && centerTab.kind === "query",
    surface: tabKey(centerTab), clientError: setError,
  });
  const { preview, phase: previewPhase, mode: previewMode, loading } = queryPreview;
  const previewController = queryPreview.controller;

  const joinSession = useJoinDiagnostics({
    project, context: queryContext, skipStatus: isFullQualityJoin(activeQueryId),
    isCurrent: contextIsCurrent, preemptPreview: () => previewController.preempt(),
    sampleWorkspace: diagnosticWorkspace, showData: () => setBottomTab("data"),
  });
  const joinController = joinSession.controller;
  const { diag: joinDiag, error: joinDiagError, diagnosticsLoading: joinDiagLoading,
    prepareLoading: joinPrepareLoading, lensBusy: lensPrepareBusy,
    prepareLabel: joinPrepareLabel, sample: diagView } = joinSession;
  const opProgress = joinSession.progress ?? otherProgress;
  const runPrepareJoinInputs = () => { void joinController.run("prepare"); };
  const runJoinDiagnostics = () => { void joinController.run("diagnostics"); };
  const openJoinDiagnostic = joinController.openSample;

  // Schema-aware Join: column lists from truncated preview (left before Join, full right).
  useEffect(() => { setCheckSetup(null); }, [queryContext.revision]);

  function cancelHeavyQuery() {
    joinController.cancel(false);
    previewController.cancel();
  }

  function recomputeCurrentPreview() {
    joinController.clearSample();
    void previewController.refresh();
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
    setModelPreview(null);
    setModelError(null);
    const session = querySessionGenerationRef.current;
    const context = queryContextRef.current!;
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
        if (!cancelled && session === querySessionGenerationRef.current && contextIsCurrent(context)) {
          setModelPreview(m);
          setModelError(null);
        }
      })
      .catch((e) => {
        if (!cancelled && session === querySessionGenerationRef.current && contextIsCurrent(context)) {
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
    queryContext.revision,
    activeQueryId,
    focusQueryId,
    queries.length,
    connections,
    overlayOpen,
  ]);

  function applyQueryDestination(destination: QueryDestination) {
    const { query, stepIndex, view, lens, focusLens } = destination;
    queryPreview.navigationChanged();
    // Invalidate synchronously, before an already-resolved async reply can publish.
    queryContextRef.current = transitionQueryContext(queryContextRef.current, {
      projectUid: projectRef.current.project_uid, queryId: query.id, stepIndex,
      view: `${tabKey(QUERY_TAB)}:${view ?? bottomTab}`, mode: (lens ?? joinLensOn) ? "lens" : "preview",
      workspace: projectRef.current.workspace,
      connections: projectRef.current.connections, sources: projectRef.current.sources, projectFile: projectRef.current.root_path,
    }, true);
    setCenterTab(QUERY_TAB);
    setSelectedKeyMapId(null);
    setSelectedExternalKey(null);
    setActiveQueryId(query.id);
    setSelectedStepIndex(stepIndex);
    if (!isQualityInspectionQuery(query.id)) setLensFocusHint(null);
    if (view) setBottomTab(view);
    if (lens !== undefined) setJoinLensOn(lens);
    if (focusLens) applyJoinLensLayout();
  }

  const queryNavigation = createQueryNavigation({
    project: () => projectRef.current,
    select: applyQueryDestination,
    openMapping: (id) => {
      // Navigation must not merge a persisted map over the mounted editor draft.
      if (keyMapTabsLiveRef.current.some((tab) => tab.map.id === id)) {
        setCenterTab(mappingTab(id));
        return;
      }
      const map = projectRef.current.workspace.key_maps?.find((m) => m.id === id);
      if (map) openKeyMapEditor(map);
    },
    openMatching: (id) => setCenterTab(matchingTab(id)),
  });

  function openMatchingSession(session: MatchingTabSession) {
    const lensCtx = session.lensCtx;
    const bound = lensCtx && lensCtx.navigationTarget === undefined ? { ...session, lensCtx: {
      ...lensCtx, navigationTarget: captureJoinTarget(projectRef.current, lensCtx.hostQueryId, lensCtx.joinStepIndex),
    } } : session;
    setMatchingTabs((tabs) => [...tabs.filter((t) => t.id !== bound.id), bound]);
    queryNavigation.openMatching(bound.id);
  }

  function selectQuery(id: string) {
    const q = projectRef.current.workspace.queries.find((q) => q.id === id);
    const joinIdx = isQualityInspectionQuery(id) ? q?.steps.findIndex((s) => s.type === "Join") ?? -1 : -1;
    queryNavigation.openQuery(id, joinIdx >= 0 ? { stepIndex: joinIdx } : undefined);
  }

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
    setCenterTab(QUERY_TAB);
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

  function acceptTabClose(tab: WorkspaceTab, dirty: boolean, message: string): boolean {
    const result = closeTab(workbenchTabs, tab, { dirty });
    if (result.status === "unchanged") return false;
    if (result.status === "confirmation_required" && !window.confirm(message)) return false;
    setWorkbenchTabs((state) => closeTab(state, tab, { discard: true }).state);
    return true;
  }

  function closeMatchingTab(sessionId: string) {
    const session = matchingTabsLiveRef.current.find((t) => t.id === sessionId);
    if (!session || !acceptTabClose(matchingTab(sessionId), session.hasUnsavedDecisions,
      "Matching has unsaved decisions. Close this tab? The draft will be lost.")) return;
    setMatchingTabs((tabs) => tabs.filter((t) => t.id !== sessionId));
  }

  /** Close map tab; if opened from Join Lens, restore Join + Lens No match. */
  function closeKeyMapTab(mapId: string, wsForJoin?: Workspace) {
    const closing = keyMapTabs.find((t) => t.map.id === mapId);
    const joinCtx = closing?.joinCtx;
    if (!closing || !acceptTabClose(mappingTab(mapId),
      Boolean(closing.localDraft) || dirtyDeltaHasChanges(closing.dirtyDelta ?? null),
      "Mapping has unsaved changes. Close this tab? The draft will be lost.")) return;
    setKeyMapTabs((tabs) => tabs.filter((t) => t.map.id !== mapId));
    setSelectedKeyMapId((id) => (id === mapId ? null : id));
    if (!joinCtx) return;
    const ws = wsForJoin ?? project.workspace;
    setActiveQueryId(joinCtx.hostQueryId);
    setBottomTab("data");
    setJoinLensOn(true);
    joinController.clearSample();
    const idx = resolveJoinStepFromCtx(ws, joinCtx);
    if (idx != null) {
      setSelectedStepIndex(idx);
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
    setCenterTab(QUALITY_WORKSPACE_TAB);
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

  const handledQueryEdit = useRef<ProjectBag["queryEditResult"]>(null);
  useEffect(() => {
    const receipt = projectBag.queryEditResult;
    if (!receipt || handledQueryEdit.current === receipt) return;
    handledQueryEdit.current = receipt;
    dispatchProject({ type: "clear_query_edit_result", receipt });
    const result = receipt.result;
    // A later replacement/graph edit must not receive an old selection or error.
    if (receipt.session !== querySessionGenerationRef.current ||
      result.project.workspace !== projectRef.current.workspace ||
      result.project.project_uid !== projectRef.current.project_uid) return;
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    const destination = result.navigation;
    if (!destination) return;
    if (destination.queryId === null) {
      queryPreview.navigationChanged();
      setActiveQueryId(null);
      setSelectedStepIndex(null);
    } else {
      queryNavigation.openQuery(destination.queryId, { stepIndex: destination.stepIndex });
    }
    // Navigation ports belong to the current render, not reducer execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectBag.queryEditResult]);

  const selectedStepIndexRef = useRef(selectedStepIndex);
  selectedStepIndexRef.current = selectedStepIndex;

  // Selection bounds only. Draft hydration belongs to the identity-scoped editor.
  useEffect(() => {
    const q = queries.find(q => q.id === activeQueryId);
    const prev = selectedStepIndexRef.current;
    const next = !q?.steps.length ? null : prev === null || prev >= q.steps.length ? q.steps.length - 1 : prev;
    if (next !== prev) setSelectedStepIndex(next);
  }, [activeQueryId, queries]);

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
          ...p.workspace,
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
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
          ...p.workspace,
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
    setSelectedSourceId(source.id);
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
          ...p.workspace,
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
    setSelectedStepIndex(0);
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
          ...p.workspace,
          queries: nextQueries,
          focus_query_id: p.workspace.focus_query_id || id,
        },
      };
    });
    setActiveQueryId(id);
    setShowPgPicker(false);
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
    await lifecycle.loadLab(id);
  }

  function commitQueryEdit(edit: (editing: QueryEditingService) => QueryEditResult) {
    const owner = projectRef.current;
    dispatchProject({ type: "edit_query", edit, ownerId: owner.id,
      ownerUid: owner.project_uid, session: querySessionGenerationRef.current });
  }

  function applyJoinTo(
    hostQueryId: string,
    rightQueryId: string,
    pairs: JoinKeyPair[],
    type: JoinType = "inner",
  ) {
    if (!rightQueryId) return;
    const right = parseTargetKey(rightQueryId) ?? rightQueryId;
    commitQueryEdit(editing => editing.applyJoin({ queryId: hostQueryId, right, pairs, joinType: type }));
  }

  /** Domain projection only; request/sample ownership lives in Join controller. */
  function diagnosticWorkspace(input: JoinInput, diag: JoinDiagnostics, kind: JoinDiagKind): Workspace {
    const ws = input.project.workspace;
    const hostId = input.context.queryId!;
    const host = ws.queries.find((q) => q.id === hostId);
    if (kind === "right") {
      const step = host?.steps[diag.join_step_index];
      return workspaceFocusingObject(ws, step?.type === "Join" ? step.payload.right_query_id : diag.right_query_id);
    }
    const steps = host?.steps.slice(0, diag.join_step_index + (kind === "left" ? 0 : 1)) ?? [];
    if (!steps.length) throw new Error("Join has no left input (need a step before Join)");
    return { ...ws, focus_query_id: hostId,
      queries: ws.queries.map((q) => q.id === hostId ? { ...q, steps } : q) };
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
    const context = queryContextRef.current!;
    // Prefer complete pairs already in the inspector; else schema-suggest; never fake "id".
    const draft = joinDraftReader.current?.read();
    let pairs = draft?.queryId === hostQueryId ? draft.pairs : [emptyJoinKeyPair()];
    if (!joinPairsComplete(pairs)) {
      try {
        const host = queries.find((q) => q.id === hostQueryId);
        const upto = host?.steps.length ?? 0;
        const cols = await fetchJoinSideColumns(
          hostQueryId,
          rightQueryId,
          upto,
        );
        if (!contextIsCurrent(context)) return;
        pairs = suggestJoinPairs(cols.left, cols.right);
      } catch {
        if (!contextIsCurrent(context)) return;
        pairs = [emptyJoinKeyPair()];
      }
    }
    applyJoinTo(hostQueryId, rightQueryId, pairs, draft?.queryId === hostQueryId ? draft.type : "inner");
  }

  function selectEdgeOnCanvas(edge: GraphEdgeInfo) {
    const host = queries.find((q) => q.id === edge.hostQueryId);
    if (edge.kind === "join") {
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
        queryNavigation.openQuery(edge.hostQueryId, { stepIndex: idx });
      }
    } else if (edge.kind === "append") {
      const idx = host?.steps.findIndex((s) => s.type === "Append") ?? -1;
      if (idx >= 0 && host) {
        queryNavigation.openQuery(edge.hostQueryId, { stepIndex: idx });
      }
    } else if (edge.kind === "from") {
      const idx =
        host?.steps.findIndex(
          (s) =>
            s.type === "FromQuery" &&
            targetKey(s.payload.query_id) === edge.otherQueryId,
        ) ?? -1;
      if (idx >= 0 && host) {
        queryNavigation.openQuery(edge.hostQueryId, { stepIndex: idx });
      }
    }
  }

  function removeEdgeOnCanvas(edge: GraphEdgeInfo) {
    const selection = { queryId: activeQueryId, stepIndex: selectedStepIndex };
    commitQueryEdit(editing => editing.removeEdge({
      queryId: edge.hostQueryId, kind: edge.kind,
      other: parseTargetKey(edge.otherQueryId) ?? edge.otherQueryId,
      stepIndex: edge.stepIndex, selection,
    }));
  }

  /** Branch: new query = FromQuery(selected) — dbt `ref`, no duplicate Load. */
  function deriveQueryFrom(fromQueryId: string) {
    commitQueryEdit(editing => editing.deriveQuery({ queryId: fromQueryId }));
  }

  /** Drop a query node: remove from workspace, scrub Join/Append refs, fix focus. */
  function removeQueryOnCanvas(queryId: string) {
    const prepared = createQueryEditingService(projectRef.current).prepareRemoveQuery({ queryId });
    if (!prepared.ok) {
      setError(prepared.error.message);
      return;
    }
    if (prepared.consequences.length) {
      const details = prepared.consequences.map(effect =>
        `• Query "${effect.queryName}" — ${effect.operation === "Join" ? "JOIN" : "Append"} (step ${effect.stepIndex + 1}): ${effect.action === "remove_step" ? "remove operation" : "remove this input; keep other inputs"}`);
      if (!window.confirm(`Delete Query "${prepared.queryName}"?\n\nThis will also change:\n${details.join("\n")}\n\nThese Queries may return different results. Continue?`)) return;
    }
    const selection = { queryId: activeQueryId, stepIndex: selectedStepIndex };
    commitQueryEdit(editing => editing.removeQuery({ queryId, selection,
      expectedRemovalRevision: prepared.revision,
    }));
  }

  // GraphCanvas calls only on drag stop. Commit now so a subsequent Save/switch
  // sees the move, and no old-project debounce can mutate the next project.
  const persistCanvasPositions = useCallback((positions: CanvasPositions) => {
    const owner = project.project_uid;
    setProject((p) => p.project_uid === owner ? { ...p, canvas: { positions } } : p);
  }, [project.project_uid]);

  function removeStepAt(index: number) {
    if (!activeQueryId) return;
    const queryId = activeQueryId;
    const selectedIndex = selectedStepIndex;
    commitQueryEdit(editing => editing.removeStep({ queryId, index, selectedIndex }));
  }

  function moveStepAt(index: number, dir: -1 | 1) {
    if (!activeQueryId) return;
    const queryId = activeQueryId;
    commitQueryEdit(editing => editing.moveStep({ queryId, index, direction: dir }));
  }

  function replaceStepAt(index: number, step: TransformationStep) {
    if (!activeQueryId) return;
    const queryId = activeQueryId;
    commitQueryEdit(editing => editing.replaceStep({ queryId, index, step }));
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
    if (!activeQueryId) return;
    const queryId = activeQueryId;
    commitQueryEdit(editing => editing.appendStep({ queryId, step }));
  }

  function selectStepAt(index: number) {
    if (activeQueryId) queryNavigation.openQuery(activeQueryId, { stepIndex: index });
  }

  function showReconLabStart() {
    if (!activeLabTask) return;
    const target = reconJoinTarget(project.workspace);
    if (!target) return;
    setLabTask((task) => task ? { ...task, hints: true, completed: false } : null);
    queryNavigation.inspectJoin(captureJoinTarget(projectRef.current, target.queryId, target.stepIndex));
  }

  function navigateReconView(view: ReconView) {
    if (!activeLabTask) return;
    const target = reconComparisonTargets(project.workspace).find((item) => item.view === view);
    if (!target?.available) return;
    dismissLabHints();
    queryNavigation.openQuery(target.queryId, { stepIndex: target.stepIndex, view: "data", lens: view !== "monthly" });
  }

  const lifecyclePorts: ProjectControllerPorts = {
    project: () => projectRef.current,
    update: (updater) => {
      projectRef.current = updater(projectRef.current);
      setProject(updater);
    },
    drafts: () => ({
      mappings: keyMapTabsLiveRef.current,
      matching: matchingTabsLiveRef.current,
      mutationBusy: mapWritesInFlight.current > 0 || confirmRemapInFlightRef.current,
    }),
    choose: () => new Promise<SwitchDecision>((resolve) => {
      setSwitchChoice(() => (decision: SwitchDecision) => {
        setSwitchChoice(null);
        resolve(decision);
      });
    }),
    pickSave: async (defaultPath) => {
      const picked = await save({ defaultPath, filters: [{ name: "DWH Project", extensions: ["json"] }] });
      return typeof picked === "string" ? picked : null;
    },
    save: saveProject,
    load: (path) => loadProject(path, { remember: true }),
    loadLab: loadDemoWorkspace,
    defaults: () => appSettings,
    newUid: () => crypto.randomUUID(),
    remember: rememberRecentProject,
    pruneRecent: (path) => persistAppSettings({ ...appSettings,
      recent_projects: (appSettings.recent_projects ?? []).filter((p) => p !== path),
    }),
    reset: (next, labId) => resetProjectSession({
      setLabTask, setKeyMapTabs, setMatchingTabs, setSelectedKeyMapId, setWorkbenchTabs,
      setSelectedStepIndex, setActiveQueryId,
      setModelPreview, setModelError, setError,
      setFrozenRemap, setCheckDeltaNote, setCheckAllowNote, setOpProgress,
      resetJoin: joinController.reset,
      setSelectedExternalKey, setSelectedSourceId, setCheckSetup, setMapPickPending,
      setMapSwitchOffer, setLensFocusHint,
      resetPreview: () => {
        querySessionGenerationRef.current++;
        previewController.reset();
      },
      clearCheckFingerprint: () => { lastCheckRunFingerprint.current = null; },
    }, next, labId),
    refreshExport: refreshExportTree,
    syncMaps: syncKeyMapsFromExport,
    error: setProjectLifecycleError,
    message: setExportMsg,
  };
  if (!lifecycleRef.current) lifecycleRef.current = new ProjectController(lifecyclePorts);
  else lifecycleRef.current.setPorts(lifecyclePorts);
  const lifecycle = lifecycleRef.current;
  const openProjectPath = (path: string, pruneFailedRecent = false) => lifecycle.open(path, pruneFailedRecent);
  const handleSaveProject = () => lifecycle.save();
  const handleSaveProjectAs = () => lifecycle.save(true);
  const applyLoadedProject = (loaded: Project, pathHint?: string) => lifecycle.applyLoaded(loaded, pathHint);

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
    setCenterTab(mappingTab(normalized.id));
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
      /** Matching owns its delta, not edits made in the Mapping editor during IPC. */
      preserveEditorDraft?: boolean;
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
          if (opts?.preserveEditorDraft &&
            (s.localDraft || dirtyDeltaHasChanges(s.dirtyDelta) || s.saveApi?.isSaving())) {
            return { ...s, contentHash: r.content_hash, saveInFlight: false };
          }
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
        e2eArmPreviewHold,
        e2eReleasePreviewHold,
        e2eWaitPreviewStarted,
        e2eWaitPreviewSettled,
        e2eJoinHolds,
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
          __dwhE2eOpenMatchingSession?: (session: MatchingTabSession) => void;
          __dwhE2eGetMatchingSessions?: () => MatchingTabSession[];
          __dwhE2eOpenMapping?: (mapId: string) => void;
          __dwhE2eGetMappingDrafts?: () => { map: KeyMapDef; dirty: boolean }[];
          __dwhE2eArmDescribeHold?: () => void;
          __dwhE2eReleaseDescribeHold?: () => void;
          __dwhE2eWaitDescribeStarted?: () => Promise<void>;
          __dwhE2eWaitDescribeSettled?: () => Promise<void>;
          __dwhE2eArmPreviewHold?: () => void;
          __dwhE2eReleasePreviewHold?: () => void;
          __dwhE2eWaitPreviewStarted?: () => Promise<void>;
          __dwhE2eWaitPreviewSettled?: () => Promise<void>;
          __dwhE2eJoinHolds?: typeof e2eJoinHolds;
        };
        w.__dwhE2eOpenProject = openPath;
        w.__dwhE2ePatchProject = (updater) => {
          setProject((p) => updater(p));
        };
        w.__dwhE2eGetProject = () => projectRef.current;
        w.__dwhE2eOpenMatchingSession = (session) => {
          openMatchingSession(session);
        };
        w.__dwhE2eGetMatchingSessions = () => matchingTabsLiveRef.current;
        w.__dwhE2eOpenMapping = (mapId) => {
          queryNavigation.openMapping(mapId);
        };
        w.__dwhE2eGetMappingDrafts = () => keyMapTabsLiveRef.current.map((t) => ({
          map: t.map, dirty: Boolean(t.localDraft) || dirtyDeltaHasChanges(t.dirtyDelta ?? null),
        }));
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
        w.__dwhE2eArmPreviewHold = e2eArmPreviewHold;
        w.__dwhE2eReleasePreviewHold = e2eReleasePreviewHold;
        w.__dwhE2eWaitPreviewStarted = e2eWaitPreviewStarted;
        w.__dwhE2eWaitPreviewSettled = e2eWaitPreviewSettled;
        w.__dwhE2eJoinHolds = e2eJoinHolds;
        (
          window as unknown as { __dwhE2eCleanup?: () => void }
        ).__dwhE2eCleanup = () => {
          window.removeEventListener("dwh-e2e-open-project", onE2eOpen);
          delete w.__dwhE2eOpenProject;
          delete w.__dwhE2ePatchProject;
          delete w.__dwhE2eSaveProject;
          delete w.__dwhE2eGetProject;
          delete w.__dwhE2eOpenMatchingSession;
          delete w.__dwhE2eGetMatchingSessions;
          delete w.__dwhE2eOpenMapping;
          delete w.__dwhE2eGetMappingDrafts;
          delete w.__dwhE2eArmDescribeHold;
          delete w.__dwhE2eReleaseDescribeHold;
          delete w.__dwhE2eWaitDescribeStarted;
          delete w.__dwhE2eWaitDescribeSettled;
          delete w.__dwhE2eArmPreviewHold;
          delete w.__dwhE2eReleasePreviewHold;
          delete w.__dwhE2eWaitPreviewStarted;
          delete w.__dwhE2eWaitPreviewSettled;
          delete w.__dwhE2eJoinHolds;
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
    const startupSnapshot = lifecycle.snapshot();
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
          if (!lifecycle.unchangedSince(startupSnapshot)) return;
          // Connections come from app settings, not the remembered document.
          projectRef.current = { ...projectRef.current, connections: globalConns };
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
      if (!cancelled && !restored && lifecycle.unchangedSince(startupSnapshot)) {
        const initial = {
          ...emptyProject("Untitled", settings),
          connections: globalConns,
        };
        lifecycle.markClean(initial);
        projectRef.current = initial;
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
      if (e.key === "Escape" && activeLabTask?.hints && !activeLabTask.completed) {
        e.preventDefault();
        dismissLabHints();
        return;
      }
      if (e.key === "Escape" && centerTab.kind !== "query") {
        e.preventDefault();
        if (centerTab.kind === "quality") openMappingQualityCanvas();
        else if (centerTab.kind === "help_lab") {
          setCenterTab(QUERY_TAB);
          setSelectedKeyMapId(null);
        } else if (centerTab.kind === "mapping") closeKeyMapTab(centerTab.mapId);
        else if (centerTab.kind === "matching") closeMatchingTab(centerTab.sessionId);
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
        if (centerTab.kind !== "query") {
          const tab = keyMapTabs.find((t) => centerTab.kind === "mapping" && t.map.id === centerTab.mapId);
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
  }, [workspace, showPgPicker, project.name, project.dbt_target, workbenchTabs, centerTab, keyMapTabs, matchingTabs, switchChoice, activeLabTask?.hints, activeLabTask?.completed]);

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

  const columnChoices = [...new Set([...(preview?.columns.map(c => c.name) ?? []),
    ...(selectedStep?.type === "SelectColumns" ? selectedStep.payload.columns : [])])];

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
          const pairs = joinDraftReader.current?.read()?.pairs ?? [];
          const { left_on, right_on } = joinPairsComplete(pairs)
            ? pairsToOn(pairs)
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

  const canCopySql =
    bottomTab === "model" ? Boolean(modelPreview?.sql) : Boolean(preview?.sql);

  const labPhase = reconHintPhase(activeLabTask, project.workspace, activeQueryId, selectedStepIndex);
  const labStartTarget = activeLabTask ? reconJoinTarget(project.workspace) : null;
  const showJoinHint = centerTab.kind === "query" && labPhase === "find_join" &&
    activeQueryId === labStartTarget?.queryId && !inspectorCollapsed;
  const showLensToggleHint = centerTab.kind === "query" && labPhase === "open_no_match" &&
    bottomTab === "data" && !!joinLensTarget && !diagView && !joinLensOn && bottomDockHeight > 80;
  const showNoMatchHint = centerTab.kind === "query" && labPhase === "open_no_match" &&
    bottomTab === "data" && !!preview && !!joinLensTarget && !diagView && joinLensOn && !overlayOpen && bottomDockHeight > 120;
  const showLabFallback = centerTab.kind === "query" && (labPhase === "find_join" || labPhase === "open_no_match") &&
    !showJoinHint && !showLensToggleHint && !showNoMatchHint;

  return (
    <div className="flex h-screen flex-col text-slate-100">
      {switchChoice && <ProjectSwitchDialog name={project.name}
        hasDrafts={lifecycle.hasUnsavedEditorDrafts()} onChoose={switchChoice} />}
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
          setCenterTab(HELP_TAB);
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
            setCenterTab(QUERY_TAB);
            setActiveQueryId(focus);
            const query = outcome.project.workspace.queries.find(
              (q) => q.id === focus,
            );
            const idx = outcome.focus_step_index ?? 0;
            const step = query?.steps[idx];
            if (step) {
              setSelectedStepIndex(idx);
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

      {empty && centerTab.kind !== "help_lab" ? (
        <EmptyHero
          onOpenHelpLab={() => {
            setCenterTab(HELP_TAB);
            setSelectedKeyMapId(null);
          }}
          onLoadDemo={(id) => void handleLoadDemo(id)}
          onAddCsv={() => void addCsvQuery()}
          onAddParquet={() => void addParquetQuery()}
          onAddHiveParquet={() => openHiveDialog("query")}
          onAddPostgres={() => openPgPicker("query")}
          onAddSqlModel={() => addSqlModelQuery()}
        />
      ) : empty && centerTab.kind === "help_lab" ? (
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
              onClick={() => setCenterTab(QUERY_TAB)}
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
                  queryNavigation.openMapping(map.id);
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

          <QueryWorkspace active={centerTab.kind === "query"}
            shellTools={<>            <div
              role="tablist"
              aria-label="Workspace"
              className="flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-[var(--line)] bg-[#060d14]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={centerTab.kind === "query"}
                onClick={() => {
                  if (isMappingQualityLab(project.workspace)) {
                    openMappingQualityCanvas();
                  } else {
                    setCenterTab(QUERY_TAB);
                    setSelectedKeyMapId(null);
                  }
                }}
                className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  centerTab.kind === "query"
                    ? "bg-[#0a1520] text-teal-200"
                    : "text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
                }`}
              >
                Pipeline canvas
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={centerTab.kind === "help_lab"}
                onClick={() => {
                  setCenterTab(HELP_TAB);
                  setSelectedKeyMapId(null);
                }}
                className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
                  centerTab.kind === "help_lab"
                    ? "bg-[#0a1520] text-teal-200"
                    : "text-slate-500 hover:bg-slate-900/50 hover:text-slate-300"
                }`}
              >
                Help Lab
              </button>
              {(isMappingQualityLab(project.workspace) ||
                (project.mapping_checks?.length ?? 0) > 0) && (
                <button type="button" role="tab" aria-selected={centerTab.kind === "quality"}
                  onClick={() => { setCenterTab(QUALITY_WORKSPACE_TAB); setSelectedKeyMapId(null); }}
                  className={`shrink-0 border-r border-[var(--line)] px-3 py-2 text-[12px] ${centerTab.kind === "quality" ? "bg-[#10251f] text-teal-100" : "text-slate-400 hover:text-teal-200"}`}>
                  ◈ Mapping quality
                </button>
              )}
              {matchingTabs.map((tab) => {
                const key = tabKey(matchingTab(tab.id));
                const on = sameTab(centerTab, matchingTab(tab.id));
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
                      onClick={() => activateCenterTab(matchingTab(tab.id))}
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
                        closeMatchingTab(tab.id);
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
                const on = sameTab(centerTab, mappingTab(tab.map.id));
                return (
                  <div
                    key={tabKey(mappingTab(tab.map.id))}
                    className={`group flex shrink-0 items-stretch border-r border-[var(--line)] ${
                      on ? "bg-[#0a1520]" : "hover:bg-slate-900/50"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => {
                        activateCenterTab(mappingTab(tab.map.id));
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

            {activeLabTask && centerTab.kind === "query" && (activeLabTask.visible ? (
              <LabTaskCard canStart={reconJoinTarget(project.workspace) !== null}
                targets={reconComparisonTargets(project.workspace)} onNavigate={navigateReconView}
                onStart={showReconLabStart}
                onDismiss={() => setLabTask((task) => task ? { ...task, visible: false, hints: false } : null)} />
            ) : (
              <button type="button" data-testid="lab-task-reopen"
                onClick={() => setLabTask((task) => task ? { ...task, visible: true } : null)}
                className="mx-3 mt-1 self-start rounded px-2 py-1 text-xs text-teal-300 hover:bg-teal-500/10">Lab task</button>
            ))}
            {showLabFallback && <div className="mx-3 mb-2 shrink-0">
              <LabHint fallback onDismiss={dismissLabHints}>{labPhase === "find_join"
                ? "Select the original Join step in dirty_recon. Show me can return you there."
                : "Open Join Lens in Data, then select No match. Waiting for a preview is normal while it runs."}</LabHint>
            </div>}

            {(error || exportMsg) && (
              <div className="shrink-0 space-y-1 px-3 pb-1 pt-2">
                {error && (
                  <ErrorBanner
                    message={error}
                    onDismiss={() => { setProjectLifecycleError(null); setError(null); }}
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

            {centerTab.kind === "help_lab" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <HelpLab onOpenLab={(id) => void handleLoadDemo(id)} />
              </div>
            )}

            {centerTab.kind === "quality" &&
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
                      // JoinLens mounts only when the selected step is Join
                      // (preview rows + joinCtx). Last step is Filter/Sort — that
                      // left DATA as an empty PreviewTable after Inspect.
                      const joinStepIdx = plan.sampleQuery.steps.findIndex(
                        (s) => s.type === "Join",
                      );
                      const stepIndex = joinStepIdx >= 0 ? joinStepIdx : Math.max(0, plan.sampleQuery.steps.length - 1);
                      // The inspection query is being authored in this same event;
                      // apply that exact destination, never the previous active query.
                      applyQueryDestination({ query: plan.sampleQuery, stepIndex,
                        step: plan.sampleQuery.steps[stepIndex], view: "data", lens: true, focusLens: true });
                      joinController.clearSample();
                      previewController.preempt();
                      setLensFocusHint(
                        focusValue
                          ? { column: plan.sampleColumn, value: focusValue }
                          : null,
                      );
                      if (plan.frozenRemap) setFrozenRemap(plan.frozenRemap);
                      setOpProgress({
                        kind: "quality",
                        phase: plan.progressPhase,
                        percent: 15,
                      });
                      setAutoPrepareNonce((n) => n + 1);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                />
              </div>
            )}
            {matchingTabs.map((tab) => {
              const key = tabKey(matchingTab(tab.id));
              const on = sameTab(centerTab, matchingTab(tab.id));
              return (
                <div
                  key={key}
                  className={on ? "flex min-h-0 flex-1 flex-col" : "hidden"}
                  aria-hidden={!on}
                >
                  <MatchingWorkspace
                    session={tab}
                    onOpenDemo={() => {
                      const demo = createMatchingDemoSession();
                      openMatchingSession(demo);
                    }}
                    onChange={(next) =>
                      setMatchingTabs((tabs) =>
                        tabs.map((t) => (t.id === next.id ? next : t)),
                      )
                    }
                    lensUnavailableReason={joinTargetUnavailable(project, tab.lensCtx?.navigationTarget)}
                    onOpenLens={() => {
                      queryNavigation.inspectJoin(tab.lensCtx?.navigationTarget, { focusLens: true });
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
                    onSaveToMap={async ({ session }) => {
                      if (mapWritesInFlight.current) {
                        return { status: "refused", message: "A Mapping write is already in progress. Retry after it finishes." };
                      }
                      const ownerUid = projectRef.current.project_uid;
                      const revision = matchingSaveRevision(session);
                      const isSessionCurrent = () =>
                        projectRef.current.project_uid === ownerUid &&
                        matchingTabsLiveRef.current.some((s) => s.id === session.id && matchingSaveRevision(s) === revision);
                      let ownWriteStarted = false;
                      // Cover baseline reads/planning as well as the existing persistent write.
                      mapWritesInFlight.current += 1;
                      try {
                        return await persistMatchingSession(session, {
                          isSessionCurrent,
                          context: () => {
                            const current = projectRef.current;
                            const editor = keyMapTabsLiveRef.current.find((t) => t.map.id === session.targetMapId);
                            return {
                              owner: JSON.stringify([current.project_uid, current.root_path, current.last_dbt_export_path, current.connections, current.pg_import]),
                              map: current.workspace.key_maps?.find((m) => m.id === session.targetMapId),
                              externalSeed: !!current.last_dbt_export_path,
                              refusal: (session.targetMapId ? importWriteRefusal(current.pg_import, session.targetMapId) : null) ??
                                (editor?.localDraft || dirtyDeltaHasChanges(editor?.dirtyDelta) || (editor?.saveInFlight && !ownWriteStarted) || editor?.saveApi?.isSaving()
                                  ? "Save or discard the Mapping editor draft first." : null),
                            };
                          },
                          readSource: async (map, keys) => {
                            const current = projectRef.current;
                            const resolved = resolveKeyMapConnection(current, map, current.connections, true);
                            if (!resolved.ok) throw new Error(resolved.error);
                            return (await readKeyMap(map, resolved.dsn, { fromExact: keys })).entries;
                          },
                          saveMap: (map, dirtyDelta) => {
                            ownWriteStarted = true;
                            return saveKeyMapToProject(map, { dirtyDelta, preserveEditorDraft: true });
                          },
                        });
                      } finally {
                        mapWritesInFlight.current -= 1;
                      }
                    }}
                  />
                </div>
              );
            })}
            {keyMapTabs.map((keyMapEditor) => (
              <div
                key={tabKey(mappingTab(keyMapEditor.map.id))}
                className={
                  sameTab(centerTab, mappingTab(keyMapEditor.map.id))
                    ? "flex min-h-0 flex-1 flex-col p-3"
                    : "hidden"
                }
                aria-hidden={!sameTab(centerTab, mappingTab(keyMapEditor.map.id))}
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
                    openMatchingSession(session);
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

</>}
            pipeline={{ queries: queries,
                activeQueryId: activeQueryId,
                focusQueryId: focusQueryId,
                positions: project.canvas?.positions,
                onPositionsChange: persistCanvasPositions,
                onSelect: selectQuery,
                onSetFocus: setFocusQueryId,
                onConnectJoin: connectJoinOnCanvas,
                onSelectEdge: selectEdgeOnCanvas,
                onRemoveEdge: removeEdgeOnCanvas,
                onRemoveQuery: removeQueryOnCanvas,
                onDeriveQuery: deriveQueryFrom,
                externalBoundaries: externalBoundaries,
                selectedExternalKey: selectedExternalKey,
                onSelectExternal: selectExternalBoundary,
                onDeriveExternal: deriveFromExternalKey, }}
            dock={{ stackRef: canvasDockStackRef, height: bottomDockHeight, splitter: {
              orientation: "horizontal",
              "aria-label": "Resize data panel",
              title: "Drag to resize · double-click to maximize Join Lens / Data (collapse graph)",
              onDelta: (dy) => {
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
              },
              onDoubleClick: () => {
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
              },
              onDragEnd: () => {
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
              },
             },
              result: {
                tab: bottomTab, selectTab: setBottomTab,
                contextLabel: previewScopeLabel(dataWorkspace, activeQueryId || focusQueryId, selectedStepIndex),
                modelContextLabel: `${activeQuery?.name ?? "Select a query"} · final model`,
                preview: { result: preview, phase: previewPhase, mode: previewMode, loading,
                  available: !!dataWorkspace, heavy: isHeavyPreviewFocus(project.workspace, dataWorkspace?.focus_query_id || activeQueryId || focusQueryId),
                  refresh: recomputeCurrentPreview, run: mode => { if (dataWorkspace) void previewController.run(mode); } },
                join: { sample: diagView, prepareLoading: joinPrepareLoading, diagnosticsLoading: joinDiagLoading,
                  lensBusy: lensPrepareBusy, available: !!joinLensTarget, lensOn: joinLensOn,
                  toggleLens: () => setJoinLensOn(v => !v), clearSample: joinController.clearSample,
                  openNoMatch: () => { joinController.clearSample(); setJoinLensOn(true); setForceProbeNonce(n => n + 1); } },
                model: { result: modelPreview, error: modelError, copied: sqlCopied, copy: () => { void copySql(); } },
                cancel: cancelHeavyQuery,
                lensHint: showLensToggleHint ? <LabHint onDismiss={dismissLabHints}>Open Join Lens</LabHint> : undefined,
                lens: preview && joinLensTarget ? (
                      <JoinLens
                        onModeChange={activeLabTask ? observeLabLensMode : undefined}
                        noMatchAccessory={showNoMatchHint ? <LabHint onDismiss={dismissLabHints}>Open No match</LabHint> : undefined}
                        enabled={
                          joinLensOn &&
                          !overlayOpen &&
                          centerTab.kind === "query"
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
                        onPrepareBusy={(busy) => {
                          joinSession.onPrepareBusy(busy);
                          if (busy && contextIsCurrent(queryContext)) setOpProgress((cur) => cur?.kind === "quality" ? null : cur);
                        }}
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
                          openMatchingSession(session);
                        }}
                      />
                ) : null,
              } }}
            inspector={{ hidden: inspectorCollapsed, available: centerTab.kind !== "quality", resize: <>          <PanelResizeHandle
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
          /></>,
              props: { project: project,
session: querySessionGenerationRef.current,
query: activeQuery ?? null,
index: selectedStepIndex,
width: inspectorWidth,
externalKey: selectedExternalKey,
boundaries: externalBoundaries,
columns: columnChoices,
availableSteps: availableSteps,
source: { selected: selectedSource ?? null, columns: sourceColumns, loading: sourceSchemaLoading, error: sourceSchemaError },
historyAccessory: showJoinHint && labStartTarget ? { index: labStartTarget.stepIndex,
              content: <LabHint onDismiss={dismissLabHints}>Inspect this Join — the SKU codes use different identifiers</LabHint> } : undefined,
editor: { schemaEnabled: !overlayOpen && centerTab.kind !== "quality" && centerTab.kind !== "help_lab" && !isFullQualityJoin(activeQueryId), diagnostics: <>
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
</>, project, columns: columnChoices, refCatalogs, commit: replaceStepAt,
              changeLoadFile: changeSelectedLoadFile, openMap: openKeyMapEditor, openCheck: openMappingCheckSetup,
              loadJoinColumns: fetchJoinSideColumns, joinDraftReader,
              loadUpstreamColumns: async () => {
                if (!activeQuery || selectedStepIndex === null) return [];
                const steps = activeQuery.steps.slice(0, selectedStepIndex);
                if (!steps.length) return [];
                const ws = { ...project.workspace, focus_query_id: activeQuery.id,
                  queries: queries.map(q => q.id === activeQuery.id ? { ...q, steps } : q) };
                return (await previewWorkspace(ws, connections, sources, projectRefContext(project))).columns.map(c => c.name);
              } },
commands: { focus: setFocusQueryId, togglePublished: id => setProject(p => togglePublishedOutput(p, id)),
              execution: (id, execution) => setQueries(prev => prev.map(q => q.id === id ? { ...q, execution } : q)),
              select: selectStepAt, remove: removeStepAt, move: moveStepAt, add: addAvailableStep,
              deriveExternal: deriveFromExternalKey, copyExternal: createLocalCopyOfExternal }, } }} />
        </div>
      )}
    </div>
  );
}

export default App;
