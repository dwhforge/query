export type ColumnType = "INTEGER" | "VARCHAR" | "FLOAT" | "TIMESTAMP" | "BOOLEAN";

export interface ColumnMetadata {
  name: string;
  type: ColumnType | string;
}

export interface TableSchema {
  columns: ColumnMetadata[];
}

export type JoinType = "inner" | "left" | "right" | "full";

export type TransformationStep =
  | { type: "LoadCsv"; payload: { path: string } }
  | { type: "LoadParquet"; payload: { path: string } }
  | {
      type: "LoadPostgres";
      payload: { connection_string: string; table_name: string };
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
  /** Optional bind to a Project Source (dbt source / PQ connection). */
  source_id?: string;
}

export interface Workspace {
  queries: QueryDef[];
  focus_query_id: string;
}

/** dbt sources + PQ “Get Data” — registered inputs in the Project. */
export type SourceKind = "csv" | "parquet" | "postgres";

export interface SourceDef {
  id: string;
  name: string;
  kind: SourceKind;
  path?: string;
  connection_string?: string;
  table_name?: string;
}

/**
 * IDE / dbt project container (ADR-0009).
 * Owns Sources + Workspace; Explorer tree navigates this.
 */
export interface Project {
  id: string;
  name: string;
  root_path?: string;
  sources: SourceDef[];
  workspace: Workspace;
  dbt_target: "v1" | "v2";
  last_dbt_export_path?: string;
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

export function newProjectId(): string {
  return newId("proj");
}

export function emptyProject(name = "Untitled"): Project {
  return {
    id: newProjectId(),
    name,
    sources: [],
    workspace: { queries: [], focus_query_id: "" },
    dbt_target: "v1",
  };
}

/** Mirror Load* steps into Sources catalog (idempotent by path/table). */
export function syncSourcesFromQueries(
  sources: SourceDef[],
  queries: QueryDef[],
): SourceDef[] {
  const next = [...sources];
  const keyOf = (s: SourceDef) =>
    s.kind === "postgres"
      ? `pg:${s.connection_string}|${s.table_name}`
      : `${s.kind}:${s.path}`;

  const seen = new Set(next.map(keyOf));

  for (const q of queries) {
    const step = q.steps[0];
    if (!step) continue;
    if (step.type === "LoadCsv") {
      const key = `csv:${step.payload.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        id: newSourceId(),
        name: step.payload.path.split(/[/\\]/).pop() ?? q.name,
        kind: "csv",
        path: step.payload.path,
      });
    } else if (step.type === "LoadParquet") {
      const key = `parquet:${step.payload.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        id: newSourceId(),
        name: step.payload.path.split(/[/\\]/).pop() ?? q.name,
        kind: "parquet",
        path: step.payload.path,
      });
    } else if (step.type === "LoadPostgres") {
      const key = `pg:${step.payload.connection_string}|${step.payload.table_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({
        id: newSourceId(),
        name: step.payload.table_name,
        kind: "postgres",
        connection_string: step.payload.connection_string,
        table_name: step.payload.table_name,
      });
    }
  }
  return next;
}
