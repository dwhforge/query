import type {
  ConnectionBinding,
  ConnectionDef,
  KeyMapDef,
  ObjectKind,
  PreviewResult,
  Project,
  ProjectReference,
  QueryDef,
  SourceDef,
  TransformationStep,
  WarehouseDialect,
  Workspace,
} from "../types/pipeline";
import {
  normalizeHostReject,
  unpackInvokeReply,
  type InvokeReply,
} from "./hostRpc";
import type { KeyMapWhArgs } from "../types/generated/KeyMapWhArgs";
import type { LoadProjectArgs } from "../types/generated/LoadProjectArgs";
import type { SaveProjectArgs } from "../types/generated/SaveProjectArgs";

export type { InvokeReply };

export type DbtTarget = "v1" | "v2";

/** Root project identity for ADR-0025 reference lowering. */
export type ProjectRefContext = {
  projectFile?: string;
  projectUid?: string;
  references?: ProjectReference[];
  connectionBindings?: ConnectionBinding[];
  executionEngine?: WarehouseDialect;
};

export function projectRefContext(project: Project): ProjectRefContext {
  return {
    projectFile: project.root_path,
    projectUid: project.project_uid,
    references: project.references ?? [],
    connectionBindings: project.connection_bindings ?? [],
    executionEngine: project.execution_engine ?? project.target_dialect,
  };
}

function bridge() {
  const dwh = window.dwh;
  if (!dwh?.invoke) {
    throw new Error(
      "DWH bridge missing — run under Electron (npm run electron:dev)",
    );
  }
  return dwh;
}

/** IPC → dwh-host JSON-RPC (ADR-0029: structured HostError via ok:false envelope). */
async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const e2e = String(import.meta.env.DWH_E2E ?? "") === "1";
  let e2eBridge: typeof import("./e2eBridge") | null = null;
  if (e2e) {
    e2eBridge = await import("./e2eBridge");
    await e2eBridge.e2eMaybeHoldDescribe(cmd);
  }
  try {
    return await bridge()
      .invoke<InvokeReply<T> | T>(cmd, args)
      .then((reply) => unpackInvokeReply(reply));
  } catch (e: unknown) {
    throw normalizeHostReject(e);
  } finally {
    e2eBridge?.e2eNotifyDescribeSettled(cmd);
  }
}

export type PreviewWorkspaceOpts = {
  /** Output row LIMIT. Default sample = 50. Ignored when `fullPreview`. */
  rowLimit?: number;
  /** No output row LIMIT (ADR-0041 Load full). */
  fullPreview?: boolean;
};

export function previewWorkspace(
  workspace: Workspace,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
  projectRef?: ProjectRefContext,
  opts?: PreviewWorkspaceOpts,
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_workspace", {
    workspace,
    connections,
    sources,
    projectFile: projectRef?.projectFile,
    projectUid: projectRef?.projectUid,
    references: projectRef?.references ?? [],
    connectionBindings: projectRef?.connectionBindings ?? [],
    executionEngine: projectRef?.executionEngine,
    rowLimit: opts?.rowLimit,
    fullPreview: opts?.fullPreview === true,
  });
}

/** Schema only (`LIMIT 0`) — no sample rows. */
export function describeWorkspace(
  workspace: Workspace,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
  projectRef?: ProjectRefContext,
): Promise<PreviewResult> {
  return invoke<PreviewResult>("describe_workspace", {
    workspace,
    connections,
    sources,
    projectFile: projectRef?.projectFile,
    projectUid: projectRef?.projectUid,
    references: projectRef?.references ?? [],
    connectionBindings: projectRef?.connectionBindings ?? [],
    executionEngine: projectRef?.executionEngine,
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

function refArgs(projectRef?: ProjectRefContext) {
  return {
    projectFile: projectRef?.projectFile,
    projectUid: projectRef?.projectUid,
    references: projectRef?.references ?? [],
    connectionBindings: projectRef?.connectionBindings ?? [],
    executionEngine: projectRef?.executionEngine,
  };
}

export function prepareJoinInputs(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  connections: ConnectionDef[] = [],
  sources: SourceDef[] = [],
  force = false,
  projectRef?: ProjectRefContext,
): Promise<JoinPrepareResult> {
  return invoke<JoinPrepareResult>("prepare_join_inputs", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
    force,
    ...refArgs(projectRef),
  });
}

export function joinPrepareStatus(
  workspace: Workspace,
  hostQueryId: string,
  joinStepIndex: number,
  sources: SourceDef[] = [],
  connections: ConnectionDef[] = [],
  projectRef?: ProjectRefContext,
): Promise<JoinPrepareStatus> {
  return invoke<JoinPrepareStatus>("join_prepare_status", {
    workspace,
    hostQueryId,
    joinStepIndex,
    sources,
    connections,
    ...refArgs(projectRef),
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
  keyFilter?: {
    keyColumns: string[];
    /** Distinct join-key tuples (JSON-serializable cell values). */
    keyTuples: unknown[][];
  },
): Promise<PreviewResult> {
  return invoke<PreviewResult>("preview_prepared_join_side", {
    side,
    limit,
    keyColumns: keyFilter?.keyColumns,
    keyTuples: keyFilter?.keyTuples,
  });
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
  projectRef?: ProjectRefContext,
): Promise<PreviewDbtModel> {
  return invoke<PreviewDbtModel>("preview_dbt_model", {
    workspace,
    queryId,
    targetDialect,
    connections,
    sources,
    ...refArgs(projectRef),
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
  projectRef?: ProjectRefContext,
): Promise<JoinDiagnostics> {
  return invoke<JoinDiagnostics>("join_diagnostics", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
    ...refArgs(projectRef),
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
  projectRef?: ProjectRefContext,
): Promise<ExplainJoinRowsResult> {
  return invoke<ExplainJoinRowsResult>("explain_join_rows", {
    workspace,
    hostQueryId,
    joinStepIndex,
    keys: opts.keys ?? [],
    previewOffsets: opts.previewOffsets ?? null,
    connections,
    sources,
    ...refArgs(projectRef),
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
  projectRef?: ProjectRefContext,
): Promise<ExplainJoinKeyResult> {
  return invoke<ExplainJoinKeyResult>("explain_join_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
    sources,
    ...refArgs(projectRef),
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
  projectRef?: ProjectRefContext,
): Promise<BlameUnmatchedKeyResult> {
  return invoke<BlameUnmatchedKeyResult>("blame_unmatched_key", {
    workspace,
    hostQueryId,
    joinStepIndex,
    side,
    keyValues,
    connections,
    sources,
    ...refArgs(projectRef),
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
  projectRef?: ProjectRefContext,
): Promise<JoinKeyNearMiss> {
  return invoke<JoinKeyNearMiss>("join_key_near_miss", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
    ...refArgs(projectRef),
  });
}

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
  /** Sibling name labels for Join keys — used when queueing LLM pairs into Auto. */
  left_key_labels?: Record<string, string>;
  right_key_labels?: Record<string, string>;
};

export type FuzzyPair = {
  from_key: string;
  to_key: string;
  score: number;
  edits: number;
  ambiguous: boolean;
  alt_to_key?: string | null;
  alt_score?: number | null;
  /** Sibling name/label when Join ON was an id (name_id_match lab / ADR-0028). */
  from_label?: string | null;
  to_label?: string | null;
  /** Composite From tuple when Suggest ran in composite-map mode (ADR-0024). */
  from_parts?: string[];
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
  /** Per-column Suggest when Join has multiple ON keys (ADR-0024). */
  keyIndex?: number | null,
  /** Composite-map mode: Join key indices forming From + which slot is fuzzy. */
  composite?: { indices: number[]; fuzzySlot: number } | null,
  projectRef?: ProjectRefContext,
): Promise<JoinKeyFuzzySuggest> {
  return invoke<JoinKeyFuzzySuggest>("join_key_fuzzy_suggest", {
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    sources,
    ...(keyIndex != null ? { keyIndex } : {}),
    ...(composite
      ? {
          compositeIndices: composite.indices,
          compositeFuzzySlot: composite.fuzzySlot,
        }
      : {}),
    ...refArgs(projectRef),
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

/** @deprecated Prefer generated KeyMapWriteResultDto — alias kept for call sites. */
export type KeyMapWriteResult = import("../types/generated").KeyMapWriteResultDto;

/** Warehouse snapshot at first local edit of a From key (ADR-0022 row-level concurrency). */
export type KeyMapDirtyBaseline = {
  fromParts: string[];
  /** false = row must be absent (insert). */
  existed: boolean;
  /** First output value (legacy single-To; ADR-0037 keeps for back-compat). */
  to: string;
  /** Output column name → value at baseline (ADR-0037). */
  outputs?: Record<string, string>;
  /**
   * Editable attrs at baseline. `null` ≡ SQL NULL; `""` ≡ empty string.
   * All editable columns should be present when known.
   */
  attrs?: Record<string, string | null>;
};

export type KeyMapDirtyDelta = {
  upserts: import("../types/pipeline").KeyMapEntry[];
  /** Arity-1 deletes (back-compat). Prefer `deletedFromParts`. */
  deletedFroms: string[];
  /** From-tuple deletes (ADR-0024). */
  deletedFromParts?: string[][];
  /** Per-From baselines frozen until Save (page navigation must not refresh). */
  baselines?: KeyMapDirtyBaseline[];
};

export type KeyMapReadResult = {
  entries: import("../types/pipeline").KeyMapEntry[];
  content_hash: string;
  total_count?: number | null;
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
  delta?: KeyMapDirtyDelta | null,
  importRegistry?: import("./pgImport").PgImportRegistry | null,
): Promise<KeyMapWriteResult> {
  const args = {
    keyMap,
    connectionString,
    expectedContentHash: expectedContentHash ?? undefined,
    delta: delta
      ? {
          upserts: delta.upserts,
          deletedFroms: delta.deletedFroms,
          deletedFromParts: delta.deletedFromParts ?? [],
          baselines: delta.baselines ?? [],
        }
      : undefined,
    importRegistry: importRegistry ?? undefined,
  } satisfies KeyMapWhArgs;
  return invoke("write_key_map", args as Record<string, unknown>);
}

export function readKeyMap(
  keyMap: import("../types/pipeline").KeyMapDef,
  connectionString: string,
  opts?: {
    limit?: number;
    offset?: number;
    fromPrefix?: string;
    /**
     * Exact From-tuple equality (Confirm baselines). Not a prefix page —
     * absence in the result means the key is absent in WH for that batch.
     */
    fromExact?: string[][];
  },
): Promise<KeyMapReadResult> {
  const args = {
    keyMap,
    connectionString,
    limit: opts?.limit,
    offset: opts?.offset,
    fromPrefix: opts?.fromPrefix,
    fromExact: opts?.fromExact,
  } satisfies KeyMapWhArgs;
  return invoke("read_key_map", args as Record<string, unknown>);
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
  projectRef?: ProjectRefContext,
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
    projectFile: projectRef?.projectFile,
    projectUid: projectRef?.projectUid,
    references: projectRef?.references ?? [],
    connectionBindings: projectRef?.connectionBindings ?? [],
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

export type DemoWorkspaceName =
  | "sales"
  | "union"
  | "sql"
  | "right"
  | "keymap"
  | "keymap_crosswalk"
  | "keymap_dual"
  | "keymap_codes"
  | "keymap_hop"
  | "keymap_offer"
  | "keymap_pg"
  | "keymap_pg_dual"
  | "keymap_pg_seed"
  | "keymap_ref"
  | "keymap_mixed"
  | "keymap_parquet"
  | "recon_ship_sales";

export function loadDemoWorkspace(
  name: DemoWorkspaceName | string,
): Promise<Workspace> {
  return invoke<Workspace>("load_demo_workspace", { name });
}

export function listHelpLabs(): Promise<
  import("../help/labCatalog").HelpLabCard[]
> {
  return invoke("list_help_labs", {});
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
  /** IDENTITY / serial-like — wizard excludes by default (ADR-0022). */
  is_autogenerated?: boolean;
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

export function pgImportFingerprint(project: Project): Promise<{ fingerprint: string }> {
  return invoke("pg_import_fingerprint", { project });
}

export function scanPostgresImport(args: {
  connectionString: string;
  relations: { schema: string; name: string }[];
  prefixes: string[];
  ruleSchemas: string[];
}): Promise<import("./pgImport").PgScanHit[]> {
  return invoke("scan_postgres_import", args);
}

export function diagnosePostgresMapping(args: {
  connectionString: string;
  schema: string;
  table: string;
  fromColumns: string[];
  outputColumns: string[];
  validFrom?: string;
  validTo?: string;
}): Promise<import("./pgImport").MappingKeyDiagnosis> {
  return invoke("diagnose_postgres_mapping", args);
}

export function commitPgImport(args: {
  project: Project;
  plan: import("./pgImport").PgImportPlan;
  connectionString: string;
}): Promise<import("./pgImport").PgImportOutcome<Project>> {
  return invoke("commit_pg_import", args);
}

export function saveProject(path: string, project: Project): Promise<Project> {
  const args = { path, project } satisfies SaveProjectArgs;
  return invoke<Project>("save_project", args as Record<string, unknown>);
}

export type ReferenceState =
  | "ready"
  | "update_available"
  | "missing"
  | "identity_mismatch"
  | "incompatible_format"
  | "invalid_dependency_graph";

export type ReferenceStatus = {
  reference_id: string;
  state: ReferenceState;
  message: string;
};

export function referenceStatuses(
  projectFile: string,
  references: ProjectReference[],
): Promise<ReferenceStatus[]> {
  return invoke<ReferenceStatus[]>("reference_statuses", {
    projectFile,
    references,
  });
}

export function makeProjectReference(
  projectFile: string,
  ownerFile: string,
  alias: string,
): Promise<ProjectReference> {
  return invoke<ProjectReference>("make_project_reference", {
    projectFile,
    ownerFile,
    alias,
  });
}

export function relinkReference(
  projectFile: string,
  reference: ProjectReference,
  ownerFile: string,
): Promise<ProjectReference> {
  return invoke<ProjectReference>("relink_reference", {
    projectFile,
    reference,
    ownerFile,
  });
}

export function refreshReference(
  project: Project,
  referenceId: string,
): Promise<ProjectReference> {
  return invoke<ProjectReference>("refresh_reference", {
    projectFile: project.root_path,
    projectUid: project.project_uid,
    referenceId,
    references: project.references ?? [],
    connectionBindings: project.connection_bindings ?? [],
    workspace: project.workspace,
    sources: project.sources,
    connections: project.connections,
    executionEngine: project.execution_engine ?? project.target_dialect,
  });
}

export function referenceConsumers(
  workspace: Workspace,
  referenceId: string,
): Promise<string[]> {
  return invoke<string[]>("reference_consumers", { workspace, referenceId });
}

export type CopiedObject =
  | { kind: "query"; query: QueryDef }
  | { kind: "mapping"; key_map: KeyMapDef };

/** Absolutize paths, bind connections, rewrite deps (ADR-0025). */
export function copyReferencedObject(
  projectFile: string,
  references: ProjectReference[],
  referenceId: string,
  kind: ObjectKind,
  objectId: string,
  newLocalId: string,
  newName: string,
  opts?: {
    connectionBindings?: ConnectionBinding[];
    connections?: ConnectionDef[];
    executionEngine?: WarehouseDialect;
  },
): Promise<CopiedObject> {
  return invoke<CopiedObject>("copy_referenced_object", {
    projectFile,
    references,
    connectionBindings: opts?.connectionBindings ?? [],
    connections: opts?.connections ?? [],
    executionEngine: opts?.executionEngine,
    referenceId,
    kind,
    objectId,
    newLocalId,
    newName,
  });
}

/** Load a project file. Pass `remember: true` for Open / Restore (session MRU). */
export function loadProject(
  path: string,
  opts?: { remember?: boolean },
): Promise<Project> {
  const args = {
    path,
    remember: opts?.remember ?? false,
  } satisfies LoadProjectArgs;
  return invoke<Project>("load_project", args as Record<string, unknown>);
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
  /** First-run dbt setup dismissed (ADR-0023). */
  dbt_setup_dismissed?: boolean;
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

export type DbtSetupStatus = {
  found: boolean;
  dbtPath?: string | null;
  pythonOk: boolean;
  pythonPath?: string | null;
  suggestedVenv: string;
  dismissed: boolean;
};

export type DbtInstallResult = {
  venvPath: string;
  dbtPath: string;
  versionLine: string;
};

export type DbtInstallScript = {
  shell: string;
  script: string;
  suggestedVenv: string;
};

export function dbtSetupStatus(): Promise<DbtSetupStatus> {
  return invoke<DbtSetupStatus>("dbt_setup_status");
}

export function dbtInstallScript(): Promise<DbtInstallScript> {
  return invoke<DbtInstallScript>("dbt_install_script");
}

/** Create ~/.dwhforge-query/dbt-venv and pip-install dbt (may take minutes). */
export function installDbtVenv(): Promise<DbtInstallResult> {
  return invoke<DbtInstallResult>("install_dbt_venv");
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

/** ADR-0044 Matching caps — prefer over hardcoding; SoT in dwh-engine matching/caps.rs */
export type MatchingCaps = {
  trialUniqueKeys: number;
  massRunUniqueKeys: number;
  retrievalShortlistPerKey: number;
  llmCandidatesPerKey: number;
  localTargetUniverseRows: number;
  parallelLlmRequests: number;
  llmRetriesPerRequest: number;
  maxLlmCallsPerRun: number;
};

export function matchingCaps(): Promise<MatchingCaps> {
  return invoke<MatchingCaps>("matching_caps", {});
}

export type MatchingRetrieveResult = {
  candidates: {
    candidateId: string;
    sessionId: string;
    targetId: string;
    outputValues: string[];
    evidenceRevision: number;
  }[];
  proposals: {
    proposalId: string;
    sessionId: string;
    mapKey: string[];
    affectedSourceRows: number;
    proposedCandidateId?: string | null;
    alternativeCandidateIds: string[];
    state: string;
    provenance: string;
    semanticPlanRevision: number;
    evidenceRevision: number;
    searchIncomplete?: boolean;
  }[];
  metrics: {
    mode: string;
    keysRequested: number;
    keysProcessed: number;
    keysUnprocessed: number;
    candidatesScored: number;
    llmCalls: number;
    llmRetries: number;
    durationMs: number;
    stopReason?: string | null;
    keyCap: number;
    shortlistPerKey: number;
    llmPerKey: number;
    maxLlmCalls: number;
    localUniverse: number;
  };
  llmCandidateIdsByProposal: Record<string, string[]>;
};

export function matchingRetrieve(
  args: Record<string, unknown>,
): Promise<MatchingRetrieveResult> {
  return invoke<MatchingRetrieveResult>("matching_retrieve", args);
}

export function matchingValidateLlmIntake(args: Record<string, unknown>): Promise<unknown> {
  return invoke("matching_validate_llm_intake", args);
}

export function matchingAcceptDraft(args: Record<string, unknown>): Promise<{
  accepted: boolean;
  materialized?: {
    mapKey: string[];
    candidateId: string;
    targetId: string;
    outputValues: string[];
    proposalId: string;
    affectedSourceRows: number;
  } | null;
}> {
  return invoke("matching_accept_draft", args);
}

export function matchingPlanCommit(args: Record<string, unknown>): Promise<{
  ok: boolean;
  blockedReason?: string | null;
  items: {
    mapKey: string[];
    outcome: string;
    affectedSourceRows: number;
    proposedOutputs?: string[] | null;
    liveOutputs?: string[] | null;
  }[];
}> {
  return invoke("matching_plan_commit", args);
}
