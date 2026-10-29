import type {
  ConnectionDef,
  PreviewResult,
  Project,
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
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_workspace", { workspace, connections });
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
): Promise<PreviewDbtModel> {
  return invoke<PreviewDbtModel>("preview_dbt_model", {
    workspace,
    queryId,
    targetDialect,
    connections,
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
): Promise<JoinDiagnostics> {
  return invoke<JoinDiagnostics>("join_diagnostics", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
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
): Promise<ExplainJoinRowsResult> {
  return invoke<ExplainJoinRowsResult>("explain_join_rows", {
    workspace,
    hostQueryId,
    joinStepIndex,
    keys: opts.keys ?? [],
    previewOffsets: opts.previewOffsets ?? null,
    connections,
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
): Promise<ExplainJoinKeyResult> {
  return invoke<ExplainJoinKeyResult>("explain_join_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
  });
}

export function blameUnmatchedKey(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  side: JoinKeySide,
  keyValues: unknown[],
  connections: ConnectionDef[] = [],
): Promise<BlameUnmatchedKeyResult> {
  return invoke<BlameUnmatchedKeyResult>("blame_unmatched_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
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
): Promise<JoinKeyNearMiss> {
  return invoke<JoinKeyNearMiss>("join_key_near_miss", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
  });
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
): Promise<ExportResult> {
  return invoke<ExportResult>("export_dbt", {
    pipelineName,
    workspace,
    outputDir,
    dbtTarget,
    targetDialect,
    connections,
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

export interface AppSettings {
  default_target_dialect: WarehouseDialect;
  default_dbt_target: DbtTarget;
  explorer_width_px?: number;
  inspector_width_px?: number;
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
