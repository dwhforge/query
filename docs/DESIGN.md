# DWH-RS-QUERY — Product Design

## 1. Product

**DWH-RS-QUERY** is a local desktop workbench: build a transform graph from one or many sources, preview in DuckDB, and **export a real dbt project**.

- Stack: Tauri + React/TS/Tailwind + Rust + DuckDB  
- Repo: `dwh-rs-query` · App id: `com.dwhrsquery.app`  
- Raw data never leaves the machine (AI receives only schema / steps / prompt)

Positioning: [ADR-0001](adr/0001-product-positioning.md).

**Licensing:** Open-source release is **under consideration and not decided**. Specs and code should stay OSS-friendly (English docs, no proprietary assumptions).

## 2. Horizons

| Horizon | Priority | Focus |
|---------|----------|--------|
| **v1 (now)** | dbt help tool | multi-source, Join/Append, preview, `dbt run`-ready export |
| **Path** | Power Query coverage | multi-query workspace = Applied Steps / Merge mental model |
| **H1→H2** | Two-way editors | visual ↔ dbt/SQL like Delphi ([ADR-0004](adr/0004-two-way-visual-text.md)) |
| **Later** | PQ closeness wins | richer UI transforms, profiling; dbt stays a strong exporter |

Long-term UX reference — **Power Query**, not Power BI.  
Long-term tooling reference — **two-way visual + text** (dbt and/or pure SQL), not one-shot export.

**Now:** AST is canonical; SQL/dbt are projections (read-only SQL is fine).  
**Later:** parse-back for a step whitelist → full round-trip with reconcile.

## 2.1 UX north star & killer feature

As a **visual** tool the bar is to **blow everyone away on usability** (not “reach PQ”, but beat it on speed-of-thought and delight).  
Conflict rule: flow UX > feature completeness. Canon: [ADR-0005](adr/0005-ux-blow-away.md).

**Ultimate UI killer feature:** the **visual pipeline / workspace editor** (multi-source graph, direct Join/Append, instant preview, one-gesture export) — [ADR-0007](adr/0007-visual-pipeline-editor-killer.md).  
Destination UX is a **graph canvas**, not a permanent list-of-forms. List+detail may be an early slice only.

Gates: &lt;2 minutes to Join+preview; Join in ≤3 actions; snappy preview; empty state teaches; keyboard first-class.

## 2.2 dbt version support

Export must support **dbt v1 and dbt v2** ([ADR-0006](adr/0006-dbt-version-matrix.md)).  
v1 implementation may ship first; v2 is a hard follow-up, not optional. Do not confuse YAML `config-version: 2` with dbt v2.

## 3. Persona & problem

Analytics engineer: several CSV/Parquet/**Postgres** inputs → join/transform → needs reproducible dbt without spaghetti SQL, with local preview.

**PostgreSQL is a mandatory first-class source** (not optional / not “CSV-only MVP”) — [ADR-0008](adr/0008-postgres-required.md).

## 4. Core loop (v1)

1. Create a query and load a source (Load*) — repeat for N sources  
2. Build a consumer query: Join / Append / Filter / GroupBy / …  
3. Preview the focus query (≤50 rows)  
4. Export dbt → `dbt run` with no hand-edits to generated `.sql`

## 5. MVP surfaces

| Surface | Role |
|---------|------|
| **Explorer (left tree)** | Project → Sources / Queries / Export ([ADR-0009](adr/0009-project-explorer.md)) |
| **Pipeline canvas** | visual graph of queries + join edges (killer feature) |
| **Inspector** | Applied steps of active query + Filter/Join |
| **Preview** | virtualized table for focus query |
| **Export dbt** | from Explorer or toolbar |
| **AI Chat** | NL → steps (after AST stabilizes) |

**Entities (reuse, don’t invent):** Project · Source · Query · Workspace — see ADR-0009.

## 6. UX rules

- Debounce 150ms on Filter / CustomSql / Join key edits → preview  
- AI: schema + workspace JSON only, no row data  
- Product name **DWH-RS-QUERY** is the primary UI brand signal  

## 7. Out of scope (v1)

- Fuzzy merge, anti-join UI, M language  
- Full PQ transform catalog (pivot/unpivot/fill/…) — path item, not a dbt v1 blocker  
- Spatial UI (spatial extension may stay best-effort), cloud sync, auth  
- Postgres is **in scope** (required) 

## 8. Success (v1)

User loads 2 CSVs, Joins on a key, Filter/GroupBy, Export dbt, `dbt run` is green.

See [SPEC.md](SPEC.md), [ADR-0002](adr/0002-multi-query-workspace.md), [ADR-0003](adr/0003-join-append-steps.md).
