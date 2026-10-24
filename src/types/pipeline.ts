export type ColumnType = "INTEGER" | "VARCHAR" | "FLOAT" | "TIMESTAMP" | "BOOLEAN";

export interface ColumnMetadata {
  name: string;
  type: ColumnType | string;
}

export interface TableSchema {
  columns: ColumnMetadata[];
}

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
  | { type: "CustomSql"; payload: { raw_sql: string } };

export interface PreviewResult {
  columns: ColumnMetadata[];
  rows: unknown[][];
  sql: string;
}
