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
      "Export dbt → project folder with staging / intermediate / marts (progress: write → parse).",
      "File → Build export runs `dbt build` (seeds + models); DSN comes from destination Postgres connection when needed.",
      "Publish to destination (inspector) marks marts; see docs/GETTING_STARTED.md.",
      "File → Open Recent reopens recent .dwhproj.json paths; File → Options… sets dbt venv path and defaults for new projects.",
    ],
  },
  {
    id: "options",
    title: "Options & recent projects",
    bullets: [
      "File → Options… writes ~/.dwhforge-query/settings.json (app-global, not the open project).",
      "dbt virtualenv: absolute path to a venv root with bin/dbt; empty = auto-discovery (ADR-0021).",
      "Default execution engine + destination seed Untitled / new projects only; Project menu edits the current project.",
      "File → Open Recent: last 10 paths; Clear recently opened empties the list.",
    ],
  },
  {
    id: "sources",
    title: "Sources",
    bullets: [
      "CSV and Parquet files (local paths; S3 with a connection).",
      "PostgreSQL — first-class: connection + catalog object picker.",
      "Execution engine / destination: Project menu (current project) or File → Options… (defaults for new projects).",
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
      "NormalizeKey / ApplyKeyMap (join-key cleanup & From→To aliases)",
      "SqlModel (root SQL) and CustomSql (`{{prev_step}}`, `{{query:id}}`)",
    ],
  },
  {
    id: "partial",
    title: "Partial / escape hatches",
    bullets: [
      "Window functions, anti-join, complex SQL → CustomSql or SqlModel.",
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
      "Full dbt tests & docs UI (narrow Join expectations → dbt tests are planned, not shipped)",
      "Macros / packages browser",
      "Two-way edit of arbitrary hand-written dbt back into the canvas",
    ],
  },
  {
    id: "join-diag",
    title: "Join diagnostics & Join Lens",
    paragraphs: [
      "Select a Join step. Join Lens modes: This row (source rows for the selected result), No match (values without a partner), Suggest all (rename ideas for every unmatched key). Click a left or right value to see how often it appears in the result.",
    ],
    bullets: [
      "This row: sides show only rows that built the selected result (not the full left/right tables)",
      "No match: values that didn’t join — click one to inspect; Find gaps loads the list",
      "Explain key: full-input result count + sample rows (not only preview LIMIT 50)",
      "Blame: absent at source 0vs filtered upstream (which step) vs no partner at Join",
      "NormalizeKey… in Join Lens: near-miss trim/case/zeros → Apply NormalizeKey before Join",
      "Suggest all: similar-name proposals for unmatched keys → Accept into the key map. Leftovers can use the LLM chat (lineage, schemas, neighbor fields). Connection: llm.base_url / llm.model / llm.api_key in ~/.dwhforge-query/settings.json",
      "Collapse the graph for Join Lens: drag the horizontal splitter up (canvas shrinks to a thin strip) or double-click the splitter to maximize the dock / restore",
      "Save mapping…: from the Inspector unmatched banner, or Join Lens → No match → left/right. Several key maps → pick target; one map → opens it",
      "Data preview while a Join is selected is truncated through that Join",
      "Inspector: unmatched / fan-out samples still available",
      "Persisted Join expectations → dbt tests: not shipped yet",
    ],
  },
  {
    id: "keymaps",
    title: "KeyMaps (From→To aliases)",
    paragraphs: [
      "A KeyMap is a small alias table: unique From → To. Use it when join keys need business remapping (channel codes, region synonyms). ApplyKeyMap remaps a column via that table. Open maps from Explorer → KeyMaps — they open as tabs next to Pipeline canvas.",
    ],
    bullets: [
      "Storage = seed (default): portable CSV in the dbt export. Display Name is for you; the internal id (shown under the title) becomes seeds/map_<id>.csv and {{ ref('map_<id>') }}. Delete removes the KeyMap from the project and, after Export, also deletes that seed CSV — otherwise reopen/sync would recreate the map from the file.",
      "Storage = source: pick Connection + schema + table. Save does a full replace write-back to Postgres; Reload / open loads live rows.",
      "Storage = ref: existing dbt model. Rows stay in the project only — no warehouse write-back (dbt run owns the model).",
      "SoT strip on the KeyMap tab: project (pre-export) → export seed (after Export) → warehouse / ref depending on Storage.",
      "Before first Export: Save map stores rows in the project (key_maps). There is no CSV on disk yet.",
      "Export (menu / Explorer / key e) is separate from Save: it writes the dbt folder, creates seeds/map_*.csv for every seed-backed KeyMap if missing, and remembers that folder.",
      "After first Export: the seed CSV is the source of truth. Opening the project syncs seed → KeyMap (and ApplyKeyMap snapshots).",
      "Save map after Export (seed storage): updates project key_maps and pushes the same rows into that export’s seeds/map_<id>.csv.",
      "If you hand-edit the CSV in Git: reopen/sync to pull rows into the editor. Re-Export refuses when the CSV hash diverged (safe re-export) so DE edits are not clobbered — sync first, or export to a new folder.",
      "CI/CD: commit the export tree; run dbt seed (CSV → warehouse table) then dbt run. Models join {{ ref('map_…') }}, not a file path.",
      "Patterns (routes R1–R3, storage seed/source/ref, topologies hub/crosswalk/dual/codes/hop): docs/keymap-workflows.md. Shared one-map hub risks From collisions across sources — prefer dual maps when code spaces overlap. Dual lab: edit dim_party (master) as well as the two alias maps.",
      "Demos: Help → KeyMap labs — F&B hub (seed); crosswalk / dual / codes / hop / composite offer id+day / ref / parquet (offline); PG crosswalk, PG dual, PG+seed, mixed parquet+PG (need dwh_tests + scripts/examples/load_postgres.py, connection conn_postgres). Multi-key Join Auto: per-column or composite-map (ADR-0024).",
      "Classic F&B: dirty_join / daily_pnl / monthly_pnl (~900 rows×2). Non-lexical Auto/LLM leftovers: DEO→UBL, The South African Breweries→ABEV.",
    ],
  },
  {
    id: "naming",
    title: "Naming",
    bullets: [
      "In the UI, query names stay plain (e.g. sales, fact_sales) — no stg_/int_/mart_ prefixes.",
      "On Export: stg_ (load-only), mart_ (Publish to destination), int_ (rest).",
      "Inspector → Publish to destination marks queries as marts (Postgres when duckdb→postgres). Empty publish list falls back to focus ★ only.",
    ],
  },
  {
    id: "export",
    title: "Export & Git",
    bullets: [
      "Export is manual (not Save map). Pick a folder → dbt_project.yml, profiles, sources.yml, model SQL, and KeyMap seeds when present.",
      "Offline `dbt parse` after Export is an author gate only. Green parse ≠ correct data — use Build for materialization.",
      "Re-export uses a content-hash manifest: hand-edited generator-owned files (including seeds/map_*.csv) → refuse before overwrite. Revert, sync into the app, or export to a new folder.",
      "After Export, seed-backed KeyMap Save pushes CSV into that same folder; Build runs dbt seed as part of dbt build.",
      "Secrets live in ~/.dwhforge-query/, not inside the project file. Full setup: docs/GETTING_STARTED.md.",
    ],
  },
  {
    id: "demos",
    title: "Demos (Help → Load demo)",
    bullets: [
      "Sales — medallion, join, rollups, top-N",
      "Union — Append of same-grain feeds",
      "SQL hybrid — SqlModel + CustomSql window",
      "Key mapping — F&B company aliases · daily PnL → monthly (EmptyHero + canvas)",
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
      "KeyMap seed flow: edit in UI → Export once → later Save updates CSV; or edit CSV in Git → reopen to sync.",
    ],
  },
];
