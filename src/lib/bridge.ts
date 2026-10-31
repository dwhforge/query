import type {
  ConnectionDef,
  PreviewResult,
  Project,
  SourceDef,
  TransformationStep,
  WarehouseDialect,
  Workspace,
} from "../types/pipeline";

export type DbtTarget = "v1" | "v2";

function bridge() {
  const dwh = window.dwh;
  if (!dwh?.invoke) {
    throw new Error(
      "DWH bridge missing — run under Electron (npm run electron:dev)",
    );
  }
  return dwh;
}

/** IPC → dwh-host JSON-RPC. */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return bridge().invoke<T>(cmd, args);
}

export function previewWorkspace(
  workspace: Workspace,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_workspace", {
    workspace,
    connections,
    sources,
  });
}

/** Schema only (`LIMIT 0`) — no sample rows. */
export function describeWorkspace(
  workspace: Workspace,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("describe_workspace", {
    workspace,
    connections,
    sources,
  });
}

/** Interrupt the DuckDB query currently running on the host. */
export function cancelRunningQuery(): Promise<boolean> {
  return invoke<boolean>("cancel_running_query", {});
}

export type JoinPrepareResult = {
  fingerprint: string;
  host_query_id: string;
  join_step_index: number;
  right_query_id: string;
  left_on: string[];
  right_on: string[];
  left_rows: number;
  right_rows: number;
  reused: boolean;
  left_expensive: boolean;
  right_expensive: boolean;
  left_materialized: boolean;
  right_materialized: boolean;
};

export type JoinPrepareStatus = {
  prepared: boolean;
  fingerprint?: string | null;
  host_query_id?: string | null;
  join_step_index?: number | null;
  left_rows?: number | null;
  right_rows?: number | null;
  left_expensive?: boolean | null;
  right_expensive?: boolean | null;
  left_materialized?: boolean | null;
  right_materialized?: boolean | null;
  stale: boolean;
};

export type JoinPrepareProgress = {
  active: boolean;
  fraction: number;
  stage: string;
  message: string;
  leftExpensive?: boolean | null;
  rightExpensive?: boolean | null;
};

export function formatJoinPrepareHint(
  r: Pick<
    JoinPrepareResult,
    | "reused"
    | "left_expensive"
    | "right_expensive"
    | "left_materialized"
    | "right_materialized"
    | "left_rows"
    | "right_rows"
  >,
): string {
  const side = (expensive: boolean, mat: boolean, rows: number) =>
    mat
      ? `${rows.toLocaleString()} rows`
      : expensive
        ? "built on the fly"
        : "direct read";
  return `${r.reused ? "Ready" : "Loaded"} · ${side(r.left_expensive, r.left_materialized, r.left_rows)} / ${side(r.right_expensive, r.right_materialized, r.right_rows)}`;
}

export function formatJoinPrepareStatusHint(s: JoinPrepareStatus): string {
  const side = (
    expensive: boolean | null | undefined,
    mat: boolean | null | undefined,
    rows: number | null | undefined,
  ) => {
    if (mat) return `${Number(rows ?? 0).toLocaleString()} rows`;
    if (expensive === false) return "direct read";
    if (expensive) return "built on the fly";
    return Number(rows ?? 0).toLocaleString();
  };
  return `Ready · ${side(s.left_expensive, s.left_materialized, s.left_rows)} / ${side(s.right_expensive, s.right_materialized, s.right_rows)}`;
}

export function prepareJoinInputs(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
  force = false,
): Promise<JoinPrepareResult> {
  return invoke<JoinPrepareResult>("prepare_join_inputs", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
    force,
  });
}

export function joinPrepareStatus(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  sources: SourceDef[] = [],
  connections: ConnectionDef[] = [],
): Promise<JoinPrepareStatus> {
  return invoke<JoinPrepareStatus>("join_prepare_status", {
    workspace,
    hostQueryId,
    joinStepIndex,
    sources,
    connections,
  });
}

export function clearJoinPrepare(): Promise<boolean> {
  return invoke<boolean>("clear_join_prepare", {});
}

export function joinPrepareProgress(): Promise<JoinPrepareProgress> {
  return invoke<JoinPrepareProgress>("join_prepare_progress", {});
}

export function previewPreparedJoinSide(
  side: "left" | "right",
  limit = 50,
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_prepared_join_side", { side, limit });
}

export type PreviewDbtModel = {
  query_id: string;
  model_name: string;
  sql: string;
};

export function previewDbtModel(
  workspace: Workspace,
  queryId: string,
  targetDialect: WarehouseDialect = "duckdb",
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<PreviewDbtModel> {
  return invoke<PreviewDbtModel>("preview_dbt_model", {
    workspace,
    queryId,
    targetDialect,
    connections,
    sources,
  });
}

export function previewPipeline(
  steps: TransformationStep[],
  connections: ConnectionDef[] = [],
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_pipeline", { steps, connections });
}

export type JoinDiagSample = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  sample_rows: number;
  total_count: number;
};

export type JoinDiagnostics = {
  host_query_id: string;
  join_step_index: number;
  right_query_id: string;
  left_on: string[];
  right_on: string[];
  sample_limit: number;
  left_count: number;
  right_count: number;
  output_count: number;
  unmatched_left_count: number;
  unmatched_right_count: number;
  fanout_left_count: number;
  right_dup_key_group_count: number;
  unmatched_left: JoinDiagSample;
  unmatched_right: JoinDiagSample;
  fanout_pairs: JoinDiagSample;
  right_dup_keys: JoinDiagSample;
  sql_counts: string;
};

export function joinDiagnostics(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<JoinDiagnostics> {
  return invoke<JoinDiagnostics>("join_diagnostics", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
  });
}

export type JoinKeyTuple = { values: unknown[] };

export type JoinRowExplanation = {
  fingerprint: string;
  key_values: unknown[];
  left_match_count: number;
  right_match_count: number;
  left_rows: unknown[][];
  right_rows: unknown[][];
};

export type ExplainJoinRowsResult = {
  host_query_id: string;
  join_step_index: number;
  right_query_id: string;
  left_on: string[];
  right_on: string[];
  left_columns: { name: string; type: string }[];
  right_columns: { name: string; type: string }[];
  max_matches: number;
  explanations: JoinRowExplanation[];
};

export function explainJoinRows(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  opts: {
    keys?: JoinKeyTuple[];
    previewOffsets?: number[];
  },
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<ExplainJoinRowsResult> {
  return invoke<ExplainJoinRowsResult>("explain_join_rows", {
    workspace,
    hostQueryId,
    joinStepIndex,
    keys: opts.keys ?? [],
    previewOffsets: opts.previewOffsets ?? null,
    connections,
    sources,
  });
}

export type JoinKeySide = "left" | "right";

export type ExplainJoinKeyResult = {
  host_query_id: string;
  join_step_index: number;
  right_query_id: string;
  left_on: string[];
  right_on: string[];
  side: string;
  key_values: unknown[];
  left_match_count: number;
  right_match_count: number;
  result_match_count: number;
  expansion: number;
  left_columns: { name: string; type: string }[];
  right_columns: { name: string; type: string }[];
  result_columns: { name: string; type: string }[];
  left_rows: unknown[][];
  right_rows: unknown[][];
  result_rows: unknown[][];
  sample_limit: number;
};

export type BlameUnmatchedKeyResult = {
  host_query_id: string;
  join_step_index: number;
  side: string;
  key_values: unknown[];
  at_source: boolean;
  at_source_count: number;
  at_join_input: boolean;
  at_join_input_count: number;
  partner_at_join: boolean;
  partner_count: number;
  dropped_at_step: number | null;
  dropped_at_step_kind: string | null;
  verdict: "absent_at_source" | "filtered_upstream" | "no_partner" | "present_on_both" | string;
};

export function explainJoinKey(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  side: JoinKeySide,
  keyValues: unknown[],
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<ExplainJoinKeyResult> {
  return invoke<ExplainJoinKeyResult>("explain_join_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
    sources,
  });
}

export function blameUnmatchedKey(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  side: JoinKeySide,
  keyValues: unknown[],
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<BlameUnmatchedKeyResult> {
  return invoke<BlameUnmatchedKeyResult>("blame_unmatched_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
    sources,
  });
}

export type NearMissSide = "left" | "right" | "both";

export type NearMissHypothesis = {
  ops: string[];
  apply_on: NearMissSide;
  baseline_matches: number;
  after_matches: number;
  delta_matches: number;
  sample_pairs: string[];
};

export type JoinKeyNearMiss = {
  host_query_id: string;
  join_step_index: number;
  left_on: string[];
  right_on: string[];
  baseline_matches: number;
  hypotheses: NearMissHypothesis[];
};

export function joinKeyNearMiss(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<JoinKeyNearMiss> {
  return invoke<JoinKeyNearMiss>("join_key_near_miss", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
  });
}

export type FuzzyPair = {
  from_key: string;
  to_key: string;
  score: number;
  edits: number;
  ambiguous: boolean;
  alt_to_key?: string | null;
  alt_score?: number | null;
};

export type FuzzyFieldSample = {
  name: string;
  value: string;
};

export type FuzzyKeySample = {
  key: string;
  fields: FuzzyFieldSample[];
};

export type FuzzyAliasExample = {
  map_id: string;
  map_name: string;
  from: string;
  to: string;
};

export type FuzzyChatContext = {
  left_query_id: string;
  left_query_name: string;
  right_query_id: string;
  right_query_name: string;
  left_lineage: string;
  right_lineage: string;
  left_columns: { name: string; type: string }[];
  right_columns: { name: string; type: string }[];
  leftover_left_samples: FuzzyKeySample[];
  leftover_right_samples: FuzzyKeySample[];
  existing_aliases: FuzzyAliasExample[];
  right_to_universe?: string[];
  context_truncated?: boolean;
};

export type JoinKeyFuzzySuggest = {
  host_query_id: string;
  join_step_index: number;
  left_on: string[];
  right_on: string[];
  metric: string;
  score_cutoff: number;
  suggestions: FuzzyPair[];
  leftover_left: string[];
  leftover_right: string[];
  scanned_left: number;
  scanned_right: number;
  unmatched_left_total: number;
  unmatched_right_total: number;
  truncated: boolean;
  disabled_reason?: string | null;
  chat_context: FuzzyChatContext;
};

export function joinKeyFuzzySuggest(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
): Promise<JoinKeyFuzzySuggest> {
  return invoke<JoinKeyFuzzySuggest>("join_key_fuzzy_suggest", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
  });
}

export type LlmConfig = {
  base_url: string;
  model: string;
  api_key_set: boolean;
};

export type LlmChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function getLlmConfig(): Promise<LlmConfig> {
  return invoke<LlmConfig>("get_llm_config");
}

export function setLlmConfig(input: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
}): Promise<LlmConfig> {
  return invoke<LlmConfig>("set_llm_config", {
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    clearApiKey: input.clearApiKey ?? false,
  });
}

export function llmChat(
  messages: LlmChatMessage[],
): Promise<{ content: string }> {
  return invoke<{ content: string }>("llm_chat", { messages });
}

export type KeyMapSyncResult = {
  updated_maps: number;
  created_maps: number;
  seed_files: string[];
};

export function syncKeyMapsFromExport(
  workspace: Workspace,
  exportPath: string,
): Promise<{ workspace: Workspace; result: KeyMapSyncResult }> {
  return invoke("sync_key_maps_from_export", { workspace, exportPath });
}

export function pushKeyMapToExport(
  exportPath: string,
  keyMap: import("../types/pipeline").KeyMapDef,
): Promise<{ path: string }> {
  return invoke("push_key_map_to_export", { exportPath, keyMap });
}

/** Delete seeds/map_*.csv (+ manifest entry) so seed→KeyMap sync does not recreate the map. */
export function removeKeyMapFromExport(
  exportPath: string,
  mapId: string,
): Promise<{ path: string | null }> {
  return invoke("remove_key_map_from_export", { exportPath, mapId });
}

export type KeyMapWriteResult = {
  schema: string;
  table: string;
  rows_written: number;
  created_table: boolean;
  content_hash: string;
};

export type KeyMapReadResult = {
  entries: import("../types/pipeline").KeyMapEntry[];
  content_hash: string;
};

/** Structured outcome of Save (local AST always written; external sync varies). */
export type KeyMapSaveResult = {
  local: "saved";
  external: "synced" | "skipped" | "conflict" | "error" | "none";
  message: string;
  contentHash?: string;
};

export function writeKeyMap(
  keyMap: import("../types/pipeline").KeyMapDef,
  connectionString: string,
  expectedContentHash?: string | null,
): Promise<KeyMapWriteResult> {
  return invoke("write_key_map", {
    keyMap,
    connectionString,
    expectedContentHash: expectedContentHash ?? null,
  });
}

export function readKeyMap(
  keyMap: import("../types/pipeline").KeyMapDef,
  connectionString: string,
): Promise<KeyMapReadResult> {
  return invoke("read_key_map", { keyMap, connectionString });
}

export interface ExportResult {
  path: string;
  files: string[];
  dbt_parse_ok: boolean;
  dbt_parse_log: string;
}

export function exportDbt(
  pipelineName: string,
  workspace: Workspace,
  outputDir: string,
  dbtTarget: DbtTarget = "v1",
  targetDialect: WarehouseDialect = "duckdb",
  connections: ConnectionDef[] = [],
  executionEngine?: WarehouseDialect,
  destinationKind?: WarehouseDialect,
  destinationConnectionId?: string,
  destinationSchema?: string,
  outputs?: string[],
  /** UI progress: write files only; call `parseExport` as a second phase. */
  skipParse?: boolean,
  sources: SourceDef[] = [],
): Promise<ExportResult> {
  return invoke<ExportResult>("export_dbt", {
    pipelineName,
    workspace,
    outputDir,
    dbtTarget,
    targetDialect,
    connections,
    sources,
    executionEngine: executionEngine ?? targetDialect,
    destinationKind: destinationKind ?? targetDialect,
    destinationConnectionId,
    destinationSchema: destinationSchema?.trim() || "public",
    outputs: outputs ?? [],
    skipParse: skipParse ?? false,
  });
}

/** Env for generated profiles (`DWH_PG_DSN` / `DWH_PG_PASSWORD`) from destination PG connection. */
export function dbtEnvFromConnections(
  connections: ConnectionDef[],
  destinationConnectionId?: string,
): Record<string, string> {
  const preferred = destinationConnectionId?.trim();
  const conn =
    (preferred
      ? connections.find((c) => c.id === preferred)
      : undefined) ??
    connections.find((c) => c.kind === "postgres");
  const dsn = conn?.postgres?.connection_string?.trim();
  if (!dsn) return {};
  const env: Record<string, string> = { DWH_PG_DSN: dsn };
  const m = dsn.match(/^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/i);
  if (m?.[1]) env.DWH_PG_PASSWORD = m[1];
  return env;
}

export function parseExport(
  exportPath: string,
  connections: ConnectionDef[] = [],
  destinationConnectionId?: string,
): Promise<{
  ok: boolean;
  log: string;
}> {
  return invoke("parse_export", {
    path: exportPath,
    env: dbtEnvFromConnections(connections, destinationConnectionId),
    connections,
    destinationConnectionId,
  });
}

export function buildExport(
  exportPath: string,
  connections: ConnectionDef[] = [],
  destinationConnectionId?: string,
): Promise<{
  ok: boolean;
  log: string;
}> {
  return invoke("build_export", {
    path: exportPath,
    env: dbtEnvFromConnections(connections, destinationConnectionId),
    connections,
    destinationConnectionId,
  });
}

export function listExportTree(path: string): Promise<string[]> {
  return invoke<string[]>("list_export_tree", { path });
}

export type DemoWorkspaceName = "sales" | "union" | "sql" | "right" | "keymap";

export function loadDemoWorkspace(
  name: DemoWorkspaceName | string,
): Promise<Workspace> {
  return invoke<Workspace>("load_demo_workspace", { name });
}

export function loadSampleWorkspace(): Promise<Workspace> {
  return loadDemoWorkspace("sales");
}

export interface PostgresObject {
  schema: string;
  name: string;
  kind: string;
}

export interface PostgresColumn {
  name: string;
  data_type: string;
  is_nullable: boolean;
  ordinal_position: number;
}

export function listPostgresObjects(
  connectionString: string,
): Promise<PostgresObject[]> {
  return invoke<PostgresObject[]>("list_postgres_objects", {
    connectionString,
  });
}

export function describePostgresObject(
  connectionString: string,
  schema: string,
  tableName: string,
): Promise<PostgresColumn[]> {
  return invoke<PostgresColumn[]>("describe_postgres_object", {
    connectionString,
    schema,
    tableName,
  });
}

export function testPostgresConnection(
  connectionString: string,
): Promise<void> {
  return invoke<void>("test_postgres_connection", { connectionString });
}

export function saveProject(path: string, project: Project): Promise<void> {
  return invoke<void>("save_project", { path, project });
}

export function loadProject(path: string): Promise<Project> {
  return invoke<Project>("load_project", { path });
}

export function getLastProjectPath(): Promise<string | null> {
  return invoke<string | null>("get_last_project_path");
}

export interface LlmSettings {
  base_url: string;
  model: string;
  /** Always empty from get_app_settings. The key stays in settings.json. */
  api_key?: string;
}

export interface AppSettings {
  default_target_dialect: WarehouseDialect;
  default_dbt_target: DbtTarget;
  /** New-project seed (ADR-0021). Absent → fall back to default_target_dialect. */
  default_execution_engine?: WarehouseDialect;
  default_destination_kind?: WarehouseDialect;
  /** Absolute path to a Python venv root (`bin/dbt`). Empty = auto-discovery. */
  dbt_venv_path?: string;
  /** MRU absolute project paths, max 10. */
  recent_projects?: string[];
  explorer_width_px?: number;
  inspector_width_px?: number;
  llm?: LlmSettings;
}

export const RECENT_PROJECTS_MAX = 10;

/** Move `path` to front of MRU (deduped, capped). */
export function pushRecentProject(
  recent: string[] | undefined,
  path: string,
): string[] {
  const abs = path.trim();
  if (!abs) return recent ?? [];
  const rest = (recent ?? []).filter((p) => p !== abs);
  return [abs, ...rest].slice(0, RECENT_PROJECTS_MAX);
}

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setAppSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("set_app_settings", { settings });
}

/** App-global Connections (shells + secrets under ~/.dwhforge-query/). */
export function getGlobalConnections(): Promise<ConnectionDef[]> {
  return invoke<ConnectionDef[]>("get_global_connections");
}

export function setGlobalConnections(
  connections: ConnectionDef[],
): Promise<void> {
  return invoke<void>("set_global_connections", { connections });
}

/** Electron dialog helpers. */
export function openDialog(opts?: {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | string[] | null> {
  return bridge().open(opts);
}

export function saveDialog(opts?: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  return bridge().save(opts);
}

export function revealItemInDir(path: string): Promise<void> {
  return bridge().revealItemInDir(path);
}

export type WindowAction =
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-fullscreen"
  | "close";

/** Electron window chrome (zoom / fullscreen / close). No-op if bridge lacks API. */
export function windowAction(action: WindowAction): Promise<void> {
  const dwh = window.dwh;
  if (!dwh?.windowAction) return Promise.resolve();
  return dwh.windowAction(action).then(() => undefined);
}

export type KeyMapMatchSource = {
  query_id: string;
  key_column: string;
  label_column?: string | null;
};

export type KeyMatchOptions = { score_cutoff: number; ambiguity_gap: number };
export type KeyMapFuzzySuggest = {
  left_rows: number;
  right_rows: number;
  unmatched: number;
  ambiguous: number;
  seconds: number;
  options: KeyMatchOptions;
  candidate_limited: boolean;
  suggestions: FuzzyPair[];
};

export function keyMapFuzzySuggest(
  workspace: Workspace,
  connections: ConnectionDef[],
  left: KeyMapMatchSource,
  right: KeyMapMatchSource,
  options: KeyMatchOptions,
): Promise<KeyMapFuzzySuggest> {
  const source = (value: KeyMapMatchSource) => ({
    ...value, label_column: value.label_column?.trim() || null,
  });
  return invoke<KeyMapFuzzySuggest>("key_map_fuzzy_suggest", {
    workspace, connections, left: source(left), right: source(right), options,
  });
}
