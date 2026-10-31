export type ColumnType = "INTEGER" | "VARCHAR" | "FLOAT" | "TIMESTAMP" | "BOOLEAN";

export interface ColumnMetadata {
  name: string;
  type: ColumnType | string;
}

export interface TableSchema {
  columns: ColumnMetadata[];
}

export type JoinType = "inner" | "left" | "right" | "full";

/** ADR-0012 — how to reach a system (creds / endpoint). Not a Source. */
export type ConnectionKind = "postgres" | "s3" | "duckdb";

export interface PostgresParams {
  connection_string: string;
}

export interface S3Params {
  /** `config` | `credential_chain` */
  provider: string;
  region?: string;
  endpoint?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  /** `path` | `vhost` */
  url_style?: string;
  use_ssl: boolean;
  verify_ssl: boolean;
}

export interface DuckdbParams {
  path: string;
  /** Default true — source ATTACH is read-only. */
  read_only?: boolean;
}

export interface ConnectionDef {
  id: string;
  name: string;
  kind: ConnectionKind;
  postgres?: PostgresParams;
  s3?: S3Params;
  duckdb?: DuckdbParams;
}

export type TransformationStep =
  | { type: "LoadCsv"; payload: { path: string } }
  | {
      type: "LoadParquet";
      payload: { path: string; connection_id?: string };
    }
  | {
      type: "LoadPostgres";
      payload: {
        connection_id?: string;
        connection_string?: string;
        schema: string;
        table_name: string;
      };
    }
  | { type: "FromQuery"; payload: { query_id: string } }
  | { type: "SqlModel"; payload: { raw_sql: string } }
  | { type: "Filter"; payload: { condition: string } }
  | { type: "SelectColumns"; payload: { columns: string[] } }
  | { type: "RenameColumn"; payload: { from: string; to: string } }
  | {
      type: "LoadDuckdb";
      payload: {
        connection_id?: string;
        path?: string;
        schema: string;
        table_name: string;
      };
    }
  | {
      type: "DeriveColumn";
      payload: {
        name: string;
        expression?: string;
        mode?: DeriveMode;
        op?: DeriveOp;
        sql_dialect?: SqlDialectTag;
      };
    }
  | {
      type: "GroupBy";
      payload: { dimensions: string[]; aggregates: string[] };
    }
  | { type: "SortBy"; payload: { column: string; descending: boolean } }
  | { type: "Limit"; payload: { n: number } }
  | {
      type: "Join";
      payload: {
        right_query_id: string;
        join_type: JoinType;
        left_on: string[];
        right_on: string[];
      };
    }
  | { type: "Append"; payload: { other_query_ids: string[] } }
  | { type: "CustomSql"; payload: { raw_sql: string } }
  | {
      type: "NormalizeKey";
      payload: { columns: string[]; ops: NormalizeOp[] };
    }
  | {
      type: "ApplyKeyMap";
      payload: {
        column?: string;
        columns?: string[];
        output_column?: string;
        map_id: string;
        entries?: KeyMapEntry[];
      };
    };

/** Deterministic key cleanup ops (near-miss Apply). */
export type NormalizeOp =
  | "trim"
  | "lower"
  | "upper"
  | "collapse_space"
  | "ltrim_zeros";

export interface KeyMapEntry {
  from: string;
  /** Composite From tuple ([ADR-0024]); soft-migrate: omit → [from]. */
  from_parts?: string[];
  to: string;
  /** Extra editable WH columns (ADR-0022); keys ⊆ KeyMapDef.editable_columns. */
  attrs?: Record<string, string>;
}

/** Where the From→To table lives (ADR-0020). */
export type KeyMapStorage =
  | { kind: "seed" }
  | { kind: "ref"; model: string }
  | {
      kind: "source";
      source: string;
      table: string;
      /** Postgres connection for read / write-back. */
      connection_id?: string;
    };

/** Named From→To join-key alias table (ADR-0020 / ADR-0022 / ADR-0024). */
export interface KeyMapDef {
  id: string;
  name: string;
  entries: KeyMapEntry[];
  /** Default seed; or bind to existing dbt ref / source. */
  storage?: KeyMapStorage;
  from_column?: string;
  /** Composite From columns on the map relation; soft-migrate: omit → [from_column]. */
  from_columns?: string[];
  to_column?: string;
  /** Extra WH columns editable in the UI (not From/To). */
  editable_columns?: string[];
}

/** Preview engine for this Query node only (ADR-0014). */
export type QueryExecution = "local" | "target";

/** Warehouse dialect for SQL emit (= execution_engine). */
export type WarehouseDialect = "duckdb" | "postgres";

/** Where transform SQL is authored / which dbt adapter runs. */
export type ExecutionEngine = "duckdb" | "postgres";

/** Where published outputs materialize. */
export type DestinationKind = "duckdb" | "postgres";

export interface Destination {
  kind: DestinationKind;
  connection_id?: string;
  duckdb_path?: string;
  /** Postgres schema for published marts (default `public`). */
  schema?: string;
}

export type Materialization = "view" | "table";

export type DeriveMode = "op" | "sql";
export type SqlDialectTag = "duckdb" | "postgres" | "unknown";
export type DeriveOpId =
  | "month_start"
  | "year_month"
  | "coalesce_null"
  | "cast"
  | "col_diff"
  | "trim_case";
export type TrimCaseMode =
  | "trim"
  | "lower"
  | "upper"
  | "trim_lower"
  | "trim_upper";

export interface DeriveOp {
  id: DeriveOpId;
  column: string;
  column_b?: string;
  value?: string;
  case_mode?: TrimCaseMode;
}

export interface QueryDef {
  id: string;
  name: string;
  steps: TransformationStep[];
  source_id?: string;
  /** Default `local` (DuckDB). */
  execution?: QueryExecution;
}

export interface Workspace {
  queries: QueryDef[];
  focus_query_id: string;
  /** Join-key alias maps (ADR-0020). */
  key_maps?: KeyMapDef[];
}

/** Object catalog entry — may reference a Connection. */
export type SourceKind = "csv" | "parquet" | "postgres" | "duckdb";

export interface SourceDef {
  id: string;
  name: string;
  kind: SourceKind;
  path?: string;
  connection_id?: string;
  /** Legacy mirror; prefer connection_id. */
  connection_string?: string;
  schema?: string;
  table_name?: string;
  /** Parquet Hive partitions (explicit opt-in). */
  hive_partitioning?: boolean;
}

/** Saved React Flow positions (query id → coords). */
export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>;
}

/**
 * IDE / dbt project container (ADR-0009 + ADR-0012).
 * Engine ≠ destination (four routes).
 */
export interface Project {
  id: string;
  name: string;
  root_path?: string;
  connections: ConnectionDef[];
  sources: SourceDef[];
  workspace: Workspace;
  /** dbt Core line (v1/v2) — not warehouse dialect. */
  dbt_target: "v1" | "v2";
  /** SQL emit / free-SQL dialect owner. */
  execution_engine?: ExecutionEngine;
  /** Where published outputs materialize. */
  destination?: Destination;
  /** Query ids published as marts (empty → focus only). */
  outputs?: string[];
  materialization?: Materialization;
  /** Legacy mirror of execution_engine — kept for older files. */
  target_dialect?: WarehouseDialect;
  /** Legacy postgres dest connection — folded into destination. */
  target_connection_id?: string;
  last_dbt_export_path?: string;
  canvas?: CanvasLayout;
}

export interface PreviewResult {
  columns: ColumnMetadata[];
  rows: unknown[][];
  sql: string;
}

/** Slug fragment from a human name / filename (stable, readable ids). */
export function slugify(name: string, maxLen = 40): string {
  const base = name
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLen);
  return base || "item";
}

/** `prefix_slug`, uniquified against `existing` (e.g. `src_sample`, `src_sample_2`). */
export function newId(
  prefix: string,
  nameHint = "item",
  existing: Iterable<string> = [],
): string {
  const taken = new Set(existing);
  const slug = slugify(nameHint);
  let id = `${prefix}_${slug}`;
  let n = 2;
  while (taken.has(id)) {
    id = `${prefix}_${slug}_${n}`;
    n += 1;
  }
  return id;
}

export function newQueryId(nameHint = "query", existing: Iterable<string> = []): string {
  return newId("q", nameHint, existing);
}

export function newSourceId(nameHint = "source", existing: Iterable<string> = []): string {
  return newId("src", nameHint, existing);
}

export function newConnectionId(
  nameHint = "connection",
  existing: Iterable<string> = [],
): string {
  return newId("conn", nameHint, existing);
}

export function newProjectId(nameHint = "project"): string {
  return newId("proj", nameHint);
}

export function emptyS3Params(): S3Params {
  return {
    provider: "config",
    region: "us-east-1",
    url_style: "path",
    use_ssl: true,
    verify_ssl: true,
  };
}

/** Optional seed from `~/.dwhforge-query/settings.json` (app defaults). */
export type ProjectDefaults = {
  default_target_dialect?: WarehouseDialect;
  default_dbt_target?: "v1" | "v2";
  default_execution_engine?: ExecutionEngine;
  default_destination_kind?: DestinationKind;
};

export function emptyProject(
  name = "Untitled",
  defaults?: ProjectDefaults,
): Project {
  const engine =
    defaults?.default_execution_engine ??
    defaults?.default_target_dialect ??
    "duckdb";
  const destKind = defaults?.default_destination_kind ?? engine;
  return {
    id: newProjectId(name),
    name,
    connections: [],
    sources: [],
    workspace: { queries: [], focus_query_id: "" },
    dbt_target: defaults?.default_dbt_target ?? "v1",
    execution_engine: engine,
    destination:
      destKind === "postgres"
        ? { kind: "postgres" }
        : { kind: "duckdb", duckdb_path: "local.duckdb" },
    outputs: [],
    materialization: "table",
    target_dialect: engine,
  };
}

/** Normalize legacy projects that only have `target_dialect`. */
export function migrateProject(p: Project): Project {
  const engine: ExecutionEngine =
    p.execution_engine ?? p.target_dialect ?? "duckdb";
  let destination = p.destination;
  if (!destination) {
    if (engine === "postgres" || p.target_dialect === "postgres") {
      destination = {
        kind: "postgres",
        connection_id: p.target_connection_id,
      };
    } else {
      destination = { kind: "duckdb", duckdb_path: "local.duckdb" };
    }
  } else if (
    destination.kind === "postgres" &&
    !destination.connection_id &&
    p.target_connection_id
  ) {
    destination = {
      ...destination,
      connection_id: p.target_connection_id,
    };
  }
  return {
    ...p,
    execution_engine: engine,
    destination,
    outputs: p.outputs ?? [],
    materialization: p.materialization ?? "table",
    target_dialect: engine,
    target_connection_id:
      destination.kind === "postgres"
        ? destination.connection_id
        : p.target_connection_id,
  };
}

export function queryExecution(q: QueryDef): QueryExecution {
  return q.execution ?? "local";
}

/** SQL emit dialect = execution engine. */
export function projectDialect(p: Project): WarehouseDialect {
  return p.execution_engine ?? p.target_dialect ?? "duckdb";
}

export function projectEngine(p: Project): ExecutionEngine {
  return p.execution_engine ?? p.target_dialect ?? "duckdb";
}

export function projectDestination(p: Project): Destination {
  return (
    migrateProject(p).destination ?? {
      kind: "duckdb",
      duckdb_path: "local.duckdb",
    }
  );
}

/** True when query exports as `mart_*` (destination publish). Empty outputs → focus only. */
export function isPublishedOutput(p: Project, queryId: string): boolean {
  const outs = p.outputs ?? [];
  if (outs.length === 0) {
    return queryId === p.workspace.focus_query_id;
  }
  return outs.includes(queryId);
}

/** Toggle query in `Project.outputs`. Empty list restores focus-only legacy. */
export function togglePublishedOutput(p: Project, queryId: string): Project {
  const m = migrateProject(p);
  const focus = m.workspace.focus_query_id;
  const outs = m.outputs ?? [];
  let next: string[];
  if (outs.length === 0) {
    if (queryId === focus) return m;
    next = [focus, queryId].filter(Boolean);
  } else if (outs.includes(queryId)) {
    next = outs.filter((id) => id !== queryId);
  } else {
    next = [...outs, queryId];
  }
  return { ...m, outputs: next };
}

/** Short label for menubar badge. */
export function routeLabel(p: Project): string {
  const eng = projectEngine(p);
  const dest = projectDestination(p).kind;
  if (eng === dest) return eng;
  return `${eng}→${dest}`;
}

export function connectionById(
  project: Project,
  id: string | undefined,
): ConnectionDef | undefined {
  if (!id) return undefined;
  return project.connections.find((c) => c.id === id);
}

/** Last concrete path segment. Skips globs; strips a trailing `.parquet`. */
export function parquetSourceName(path: string, fallback = "parquet"): string {
  const parts = path
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[/\\]/)
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.includes("*") || part.includes("?")) continue;
    if (part.toLowerCase().endsWith(".parquet")) {
      return part.replace(/\.parquet$/i, "") || fallback;
    }
    return part;
  }
  return fallback;
}

/** Mirror Load* steps into Sources catalog (idempotent). */
export function syncSourcesFromQueries(
  sources: SourceDef[],
  queries: QueryDef[],
): SourceDef[] {
  const next = [...sources];
  const keyOf = (s: SourceDef) =>
    s.kind === "postgres"
      ? `pg:${s.connection_id ?? s.connection_string}|${s.schema ?? "public"}.${s.table_name}`
      : `${s.kind}:${s.connection_id ?? ""}:${s.path}`;

  const seen = new Set(next.map(keyOf));
  const existingByKey = new Map(sources.map((s) => [keyOf(s), s] as const));

  for (const q of queries) {
    const step = q.steps[0];
    if (!step) continue;
    if (step.type === "LoadCsv") {
      const key = `csv::${step.payload.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fileName = step.payload.path.split(/[/\\]/).pop() ?? q.name;
      next.push({
        id: newSourceId(fileName, next.map((s) => s.id)),
        name: fileName,
        kind: "csv",
        path: step.payload.path,
      });
    } else if (step.type === "LoadParquet") {
      const key = `parquet:${step.payload.connection_id ?? ""}:${step.payload.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fileName = parquetSourceName(step.payload.path, q.name);
      const existing = existingByKey.get(key);
      next.push({
        id: newSourceId(fileName, next.map((s) => s.id)),
        name: fileName,
        kind: "parquet",
        path: step.payload.path,
        connection_id: step.payload.connection_id,
        // Hive is source-specific — preserve when re-syncing from queries.
        hive_partitioning: existing?.hive_partitioning || undefined,
      });
    } else if (step.type === "LoadPostgres") {
      const schema = step.payload.schema || "public";
      const key = `pg:${step.payload.connection_id ?? step.payload.connection_string}|${schema}.${step.payload.table_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tableLabel = `${schema}.${step.payload.table_name}`;
      next.push({
        id: newSourceId(tableLabel, next.map((s) => s.id)),
        name: tableLabel,
        kind: "postgres",
        connection_id: step.payload.connection_id,
        connection_string: step.payload.connection_string,
        schema,
        table_name: step.payload.table_name,
      });
    }
  }
  return next;
}
