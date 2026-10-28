/**
 * In-app user guide. Keep this file honest and short — it is the product
 * capability surface users see from Help. Prefer updating here when features
 * ship or are deferred (mirror docs/DEMOS.md coverage).
 */

export type HelpSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export const HELP_TITLE = "DWHForge Query — Guide";

export const HELP_INTRO =
  "Local workbench: connect sources, build a transform graph, preview in DuckDB, export a real dbt project you own in Git.";

/** Single source for Help → User guide. */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "loop",
    title: "Core loop",
    bullets: [
      "Add Connections (Postgres, S3) and Sources / Queries in the Explorer.",
      "Build steps on the canvas (Join, Append, Filter, GroupBy, …).",
      "Preview the focus query (up to 50 rows) in DuckDB.",
      "Export dbt → project folder with staging / intermediate / marts.",
      "Run `dbt run` yourself (or in CI) with the generated profiles — Export only runs offline `dbt parse`.",
    ],
  },
  {
    id: "sources",
    title: "Sources",
    bullets: [
      "CSV and Parquet files (local paths; S3 with a connection).",
      "PostgreSQL — first-class: connection + catalog object picker.",
      "Warehouse dialect (menu Project → Export warehouse): DuckDB or Postgres for dbt emit.",
      "Preview defaults to local DuckDB. Per-query execution=target is for warehouse-native checks (advanced).",
    ],
  },
  {
    id: "transforms",
    title: "Transforms (supported)",
    bullets: [
      "LoadCsv, LoadParquet, LoadPostgres",
      "FromQuery (reuse another query’s output)",
      "Filter, SelectColumns, RenameColumn, DeriveColumn",
      "GroupBy, SortBy, Limit",
      "Join (inner / left / right / full; multi-key in the UI)",
      "Append (union by column name)",
      "SqlModel (root SQL) and CustomSql (`{{prev_step}}`, `{{query:id}}`)",
    ],
  },
  {
    id: "partial",
    title: "Partial / escape hatches",
    bullets: [
      "Window functions, anti-join, complex SQL → CustomSql or SqlModel.",
      "dbt seeds/ folder is not generated; use LoadCsv as a staging stand-in.",
      "Postgres export with live file/S3 sources needs landing first (or use DuckDB target).",
    ],
  },
  {
    id: "not-yet",
    title: "Not in the product yet",
    paragraphs: [
      "Do not expect these as first-class UI features:",
    ],
    bullets: [
      "Incremental models, snapshots / SCD2",
      "Full dbt tests & docs UI (narrow Join expectations are planned, not shipped)",
      "Macros / packages browser",
      "Two-way edit of arbitrary hand-written dbt back into the canvas",
      "Join investigation panels (row counts / unmatched → grid) — planned next",
    ],
  },
  {
    id: "naming",
    title: "Naming",
    bullets: [
      "In the UI, query names stay plain (e.g. sales, fact_sales) — no stg_/int_/mart_ prefixes.",
      "On Export, models get stg_ (load-only), mart_ (focus query), or int_ (everything else).",
      "Focus query decides which model is the mart.",
    ],
  },
  {
    id: "export",
    title: "Export & Git",
    bullets: [
      "Export writes dbt_project.yml, profiles, sources.yml, and model SQL.",
      "Offline `dbt parse` runs after Export in the UI (no warehouse). Green parse ≠ correct data.",
      "Re-export may refuse if you hand-edited generated files (safe re-export / manifest) — revert edits or export to a new folder.",
      "Secrets live in ~/.dwhforge-query/, not inside the project file.",
    ],
  },
  {
    id: "demos",
    title: "Demos (Help → Load demo)",
    bullets: [
      "Sales — medallion, join, rollups, top-N",
      "Union — Append of same-grain feeds",
      "SQL hybrid — SqlModel + CustomSql window",
      "Postgres is not in offline demos — use Connect Postgres in the UI.",
    ],
  },
  {
    id: "tips",
    title: "Tips",
    bullets: [
      "Start with two CSV sources and a Join; Export to DuckDB; open the folder and run dbt locally.",
      "Keep CustomSql for exceptions; prefer Join / Append / Filter so the graph stays reviewable.",
      "If Model tab or Export fails after an update, fully restart the desktop app (HMR won’t reload Rust commands).",
    ],
  },
];
