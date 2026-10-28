# Demo workspaces — dbt practice coverage

Canon: visual IR → DuckDB preview → dbt export. Bundled demos use CSV fixtures only (Postgres = Connect Postgres in UI, not a offline demo).

Related: [ADR-0001](adr/0001-product-positioning.md), [SPEC.md](SPEC.md).

---

## Naming rule

| Layer | Where | Example |
|-------|--------|---------|
| **Source** | Explorer Sources | `sample.csv`, `public.orders` |
| **Query** | Explorer Queries / canvas | `sales`, `fact_sales` — **no** `stg_`/`int_`/`mart_` |
| **dbt model** | Export only | `stg_sales`, `int_fact_sales`, `mart_top_by_region` |

Prefixes are applied by the exporter (`Load*`-only → `stg_`, focus query → `mart_`, else → `int_`). They are not part of the query name in the UI.

---

## Coverage map

### A — Covered (shown in demos)

| ID | Practice | Mechanism | Demo |
|----|----------|-----------|------|
| A1 | Staging from file | LoadCsv | all |
| A2 | Shared staging → many marts | FromQuery fan-out | sales, sql |
| A3 | Dim join / enrich | FromQuery + Join | sales |
| A4 | Business filter | Filter | sales |
| A5 | Rollup / KPI by dim | GroupBy + Sort + Limit | sales, union |
| A6 | Global top-N | Sort + Limit | sales |
| A7 | Column contract | SelectColumns + Rename | sales (`sales_clean`) |
| A8 | Calculated metric | DeriveColumn | sales |
| A9 | Union same-grain feeds | Append | union |
| A10 | Hand-written model node | SqlModel | sql |
| A11 | Mid-pipeline SQL escape | CustomSql + `{{prev_step}}` | sql |
| A12 | Multi-hop int→mart | FromQuery chain | sales, union, sql |
| A13 | Postgres source | LoadPostgres | UI only (needs DSN) |
| A14 | Chained RIGHT OUTER (multi-join) | Two Join steps, different rights | right |
| A15 | Join-key From→To map + dbt seed | KeyMap + ApplyKeyMap → `seeds/map_*.csv` | keymap (+ EmptyHero playground) |

### B — Partial

| ID | Practice | Gap |
|----|----------|-----|
| B1 | Multi-key Join | UI: dual column pickers + multi-key pairs (schema from preview) |
| B2 | Top-N per group / window | CustomSql only (see `sql` demo) |
| B3 | Anti-join | CustomSql |
| B4 | Seeds (general) | KeyMap seeds shipped (A15); other seed use-cases still LoadCsv proxy |

### C — Not covered (do not claim)

Incremental / snapshot / SCD2, full tests & docs as first-class, macros/packages, exposures/metrics, unit tests, ephemeral config UI, Jinja control flow, cross-db.

**Next release** may emit a **narrow** slice of dbt tests from Join expectations ([DESIGN.md](DESIGN.md) §9 · [ADR-0018](adr/0018-return-and-edit.md)) — still not “tests/docs as a product surface”.

---

## Workspaces

Load via EmptyHero **Load demo**, or later **Help → Load demo**. Command: `load_demo_workspace(name)`. Not on the canvas chrome.

### 1. `sales` — Medallion + fan-out

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `dim_region` | `stg_dim_region` | LoadCsv dim |
| `sales` | `stg_sales` | LoadCsv fact |
| `sales_clean` | `int_sales_clean` | From(sales) → Rename → Select → Derive |
| `fact_sales` | `int_fact_sales` | From(sales) → Join(dim) → Filter |
| `top_sales` | `int_top_sales` | From(sales) → Sort → Limit |
| `top_by_region` ★focus | `mart_top_by_region` | From(fact_sales) → GroupBy → Sort → Limit |

Categories: A1–A8, A12.

### 2. `union` — Multi-feed Append

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `sales_eu` | `stg_sales_eu` | LoadCsv EU |
| `sales_us` | `stg_sales_us` | LoadCsv US |
| `sales_all` | `int_sales_all` | From(eu) → Append(us) |
| `by_region` ★focus | `mart_by_region` | From(sales_all) → GroupBy → Sort |

Categories: A1, A5, A9, A12.

### 3. `sql` — SqlModel + CustomSql + ref

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `calendar` | `int_calendar` | SqlModel |
| `sales` | `stg_sales` | LoadCsv |
| `sales_enriched` ★focus | `mart_sales_enriched` | From(sales) → CustomSql window |
| `sales_top3` | `int_sales_top3` | From(enriched) → Filter |

Categories: A2, A10, A11, A12; B2 via CustomSql.

### 4. `right` — Two RIGHT OUTER joins (coverage)

Sparse fact has only `EU/web` and `US/store`. Dims also have `APAC` and `partner` with no facts.

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `dim_region` | `stg_dim_region` | LoadCsv |
| `dim_channel` | `stg_dim_channel` | LoadCsv |
| `sparse_sales` | `stg_sparse_sales` | LoadCsv (2 rows) |
| `coverage` ★focus | `mart_coverage` | From(sparse) → **RIGHT** Join(dim_region) → **RIGHT** Join(dim_channel) |

How to read it:

1. Select the **first** Join step in History (region) — Data previews **through that Join only** (APAC appears). Join Lens **Linked**: left/right = parents of the center row; **Probe**: unmatched diag samples → ask if linked.
2. Select the **second** Join (channel) — Data/Lens switch to that join’s output (all channels, incl. `partner`). Unmatched lefts from the first join can disappear — RIGHT privileges the new right side.
3. Canvas shows **two** join edges; a third drag appends another Join (does not wipe prior ones).

Categories: A1, A3, A14.

### 5. `keymap` — From→To join-key aliases (ADR-0020)

Dirty fact channels (`www`, `shop`, `prt`, `Web `) vs clean `dim_channel`. EmptyHero shows the same map as an interactive playground before loading the canvas.

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `dim_channel` | `stg_dim_channel` | LoadCsv |
| `alias_sales` | `stg_alias_sales` | LoadCsv → **ApplyKeyMap**(channel) |
| `enriched` ★focus | `mart_enriched` | From(alias_sales) → LEFT Join(dim_channel) |

`Workspace.key_maps` holds `map_channel_alias`. Export writes `seeds/map_channel_alias.csv` and models `ref` it. After first export, edit the seed — reopen syncs into the KeyMap editor.

Categories: A1, A3, A15.
