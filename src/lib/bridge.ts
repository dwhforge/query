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
): Promise<ExportResult> {
  return invoke<ExportResult>("export_dbt", {
    pipelineName,
    workspace,
    outputDir,
    dbtTarget,
    targetDialect,
    connections,
  });
}

export function listExportTree(path: string): Promise<string[]> {
  return invoke<string[]>("list_export_tree", { path });
}

export type DemoWorkspaceName = "sales" | "union" | "sql";

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
