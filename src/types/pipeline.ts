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

export interface QueryDef {
  id: string;
  name: string;
  steps: TransformationStep[];
  source_id?: string;
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
  dbt_target: "v1" | "v2";
  last_dbt_export_path?: string;
  canvas?: CanvasLayout;
}

export interface PreviewResult {
  columns: ColumnMetadata[];
  rows: unknown[][];
  sql: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newQueryId(): string {
  return newId("q");
}

export function newSourceId(): string {
  return newId("src");
}

export function newConnectionId(): string {
  return newId("conn");
}

export function newProjectId(): string {
  return newId("proj");
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
    id: newProjectId(),
    name,
    connections: [],
    sources: [],
    workspace: { queries: [], focus_query_id: "" },
    dbt_target: "v1",
  };
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
      next.push({
        id: newSourceId(),
        name: step.payload.path.split(/[/\\]/).pop() ?? q.name,
        kind: "csv",
        path: step.payload.path,
      });
    } else if (step.type === "LoadParquet") {
      const key = `parquet:${step.payload.connection_id ?? ""}:${step.payload.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        id: newSourceId(),
        name: step.payload.path.split(/[/\\]/).pop() ?? q.name,
        kind: "parquet",
        path: step.payload.path,
        connection_id: step.payload.connection_id,
      });
    } else if (step.type === "LoadPostgres") {
      const schema = step.payload.schema || "public";
      const key = `pg:${step.payload.connection_id ?? step.payload.connection_string}|${schema}.${step.payload.table_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        id: newSourceId(),
        name: `${schema}.${step.payload.table_name}`,
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
