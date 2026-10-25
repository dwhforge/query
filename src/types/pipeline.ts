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
export type ConnectionKind = "postgres" | "s3";

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

export interface ConnectionDef {
  id: string;
  name: string;
  kind: ConnectionKind;
  postgres?: PostgresParams;
  s3?: S3Params;
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
  | { type: "DeriveColumn"; payload: { name: string; expression: string } }
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
  | { type: "CustomSql"; payload: { raw_sql: string } };

/** Preview engine for this Query node only (ADR-0014). */
export type QueryExecution = "local" | "target";

/** Warehouse dialect for dbt export + `execution=target` preview. */
export type WarehouseDialect = "duckdb" | "postgres";

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
}

/** Object catalog entry — may reference a Connection. */
export type SourceKind = "csv" | "parquet" | "postgres";

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
}

/** Saved React Flow positions (query id → coords). */
export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>;
}

/**
 * IDE / dbt project container (ADR-0009 + ADR-0012).
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
  /** Export emit + target preview dialect (ADR-0014). */
  target_dialect?: WarehouseDialect;
  /** Postgres connection when `target_dialect=postgres`. */
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

export function emptyProject(name = "Untitled"): Project {
  return {
    id: newProjectId(name),
    name,
    connections: [],
    sources: [],
    workspace: { queries: [], focus_query_id: "" },
    dbt_target: "v1",
    target_dialect: "duckdb",
  };
}

export function queryExecution(q: QueryDef): QueryExecution {
  return q.execution ?? "local";
}

export function projectDialect(p: Project): WarehouseDialect {
  return p.target_dialect ?? "duckdb";
}

export function connectionById(
  project: Project,
  id: string | undefined,
): ConnectionDef | undefined {
  if (!id) return undefined;
  return project.connections.find((c) => c.id === id);
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
      const fileName = step.payload.path.split(/[/\\]/).pop() ?? q.name;
      next.push({
        id: newSourceId(fileName, next.map((s) => s.id)),
        name: fileName,
        kind: "parquet",
        path: step.payload.path,
        connection_id: step.payload.connection_id,
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
