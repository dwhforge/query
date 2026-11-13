# Demo workspaces — dbt practice coverage

Canon: visual IR → DuckDB preview → dbt export. **Discovery:** Help → **Help Lab** ([ADR-0039](adr/0039-help-lab-catalog.md)) — catalog SoT `fixtures/labs/catalog.json`. Classic demos use CSV under `fixtures/`. KeyMap labs also use `fixtures/examples/` ([scripts/examples/](../scripts/examples/)); PG labs need `dwh_tests` + `load_postgres.py` and connection `conn_postgres`.

Related: [ADR-0001](adr/0001-product-positioning.md), [ADR-0039](adr/0039-help-lab-catalog.md), [SPEC.md](SPEC.md), [keymap-workflows.md](keymap-workflows.md).

---

## Start here: the offline reconciliation journey

**Help → Help Lab… → Shipments ↔ sales → Open lab** is the first-user path.
No PostgreSQL, LLM, dbt build or fixture generation is needed. In the reviewed
development checkout, a dismissible task card explains the mismatch and **Show
me where to start** selects the existing dirty Join. Opt-in inline hints stop
when **No match** is reached; no mapping success is inferred. Older packages can
follow the same query/Join/Lens path manually.

Use **Inspect original join → Inspect mapped example → Inspect monthly
reconciliation**. The mapped example is already present and only partially
prepared. After editing a map, recompute the relevant preview before comparing
rows. Sample previews are not full-input proof.

Concrete exercise: in the existing **Commercial SKU → plant product** mapping,
add **COM-AMM → AMM-A**, Save map, then Recompute the mapped example and inspect
the monthly gap. Leave NEW-BLEND unresolved without valid product evidence.
Save as creates your own project; opening labs does not silently reuse a previous
working project's save/export target ([ADR-0045](adr/0045-safe-help-lab-switch.md)).

[First-launch walkthrough](GETTING_STARTED.md#2-first-launch--offline-lab) ·
[Actual Join Lens screenshot](stabilization/flagship-join-lens.png) ·
[Development/release boundary](RELEASE_NOTES.md)

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
| A15 | Join-key From→To map + dbt seed | KeyMap + ApplyKeyMap → `seeds/map_*.csv` | keymap (+ EmptyHero) |
| A16 | Dual-feed name aliases → dim | same map on sales + spend spellings | keymap (`sales_canon` / `spend_canon`) |
| A17 | Daily combine + cleaned metric | multi-key Join + Derive net | keymap (`daily_pnl`) |
| A18 | Monthly rollup after clean | GroupBy month | keymap (`monthly_pnl`) |
| A19 | Unmatched → Add to map (Lens) | dirty join without map | keymap (`dirty_join`) |
| A20 | Crosswalk A↔B (POS↔WMS) | seed ApplyKeyMap | keymap_crosswalk |
| A21 | Dual maps + editable master | two KeyMaps → dim_party | keymap_dual / keymap_pg_dual |
| A22 | Code synonyms | channel map | keymap_codes / keymap_pg_seed |
| A23 | Multi-hop ApplyKeyMap | store→region→country | keymap_hop |
| A24 | KeyMap storage=ref | ref model + ApplyKeyMap | keymap_ref |
| A25 | KeyMap storage=source (PG) | live map table | keymap_pg / keymap_pg_dual |
| A26 | Mixed Parquet + Postgres | R2 route | keymap_mixed |
| A27 | Parquet + seed (R3) | LoadParquet | keymap_parquet |
| A28 | Shipments ↔ sales recon | KeyMap + FULL OUTER gap | recon_ship_sales (Help Lab featured) |

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

Load via **Help → Help Lab…**, EmptyHero **Open Help Lab**, or quick-load items in Help. Command: `load_demo_workspace(name)`; catalog: `list_help_labs`.

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

### 5b. `name_id_match` — Two catalogs, match by name → id seed

Committed under `fixtures/labs/name_id_match/`. CRM `crm_id`/`name` vs ERP `erp_id`/`name`. Focus `dirty_by_id` (ids never collide). Join Lens Auto scores sibling **name** labels and proposes **id→id**. Partial seed `map_crm_to_erp` keeps `from_name`/`to_name` attrs for later edits (ADR-0028). `crm_mapped` Applies the map then joins ERP on id.

### 5c. `name_region_match` — Name + region soft match (two example families)

Committed under `fixtures/labs/name_region_match/`. POS `vendor_label`/`region`/`qty` vs vendor master `vendor_name`/`region`/`category`/`vendor_id`.

**Family A — exact same name, different country = different company**

| Canonical | Regions (distinct vendors) | Invoice variants |
|-----------|----------------------------|------------------|
| ComputerParts LLC | US = V10, DE = V11 | KomputerParts LLC, Computer Parts LLC, CPC LLC + United States / USA / Germany / Federal Republic of Germany |
| Office Supply Co | US = V20, UK = V21 | Office Supplies Company + United Kingdom |

**Family B — brand names, LLM synonyms on name and region**

| Canonical | Regions | Invoice variants |
|-----------|---------|------------------|
| Nestlé Waters | Europe = V30, RUS = V31 | Nestle Waters International, NW bottled water, Nestlé Water Div. + EU / EEA / Russian Federation / Russia |
| Danone Waters | Europe = V40, RUS = V41 | Danone Water Division, Danone Eau + Western Europe / RF |
| Global Widgets Inc | APAC = V50 | Global Widgets + Asia Pacific |

| Query (UI) | Role |
|------------|------|
| `pos_invoices`, `dim_vendor` | sources |
| `dirty_exact_pair` ★focus | LEFT Join on label=name **and** region=region — synonym rows unmatched |
| `dirty_name_only` | Join on name only — ComputerParts / Nestlé / Danone fan across regions |
| `invoices_mapped` | Apply composite KeyMap → join vendor; keeps `qty` + `category` |
| `by_vendor_region` | **mart:** `vendor_name`, `region`, `SUM(qty)` — same name stays split by region |

Seed `map_pos_to_vendor` covers clean exact pairs only; synonym rows are for Matching (ADR-0044).

### 5. `recon_ship_sales` — Plant shipments ↔ commercial sales (ADR-0039)

Committed under `fixtures/labs/recon_ship_sales/`. Commercial codes (`COM-UREA`, …) ≠ plant `product_id`. Partial KeyMap (`COM-UREA`, `COM-NPK16`); leave `COM-AMM` / `NEW-BLEND` for Join Lens.

| Query (UI) | Role |
|------------|------|
| `shipments`, `sales`, `dim_product` | sources |
| `dirty_recon` ★focus | sales ⋈ dim **without** map |
| `sales_mapped` | Pre-existing partial example: ApplyKeyMap → join dim, not user-achieved success |
| `recon_by_month` | ship ⋈ sales on product+month → `qty_gap_t` |

Categories: A1, A3, A8, A15, A28.

### 6. `keymap` — F&B company aliases (ADR-0020)

Food & beverage brands: POS/sales vs cost feed spell names differently. Fixtures: 15 companies × 60 days (~900 rows/fact). Walkthrough: [keymap-workflows.md](keymap-workflows.md).

| Query (UI) | dbt model (export) | Steps |
|------------|-------------------|--------|
| `dim_company` | `stg_dim_company` | LoadCsv (canonical id + name + category) |
| `sales_daily` | `stg_sales_daily` | LoadCsv — e.g. `SBUX`, `DEO`, `The South African Breweries` |
| `res_consumption` | `stg_res_consumption` | LoadCsv — e.g. `STARBUCKS CORP`, `DIAGEO PLC` |
| `dirty_join` | `int_dirty_join` | From(sales_daily) → LEFT Join(dim) **no map** — Lens |
| `sales_canon` | `int_sales_canon` | From(sales_daily) → ApplyKeyMap → rename → Join dim |
| `spend_canon` | `int_spend_canon` | From(res_consumption) → ApplyKeyMap → rename |
| `daily_pnl` | `mart_daily_pnl` | Join sales⋈spend on id+day → net_revenue |
| `monthly_pnl` | `int_monthly_pnl` | GroupBy company × category × month |

★focus: `dirty_join` (Probe / Auto: sales keys unmatched vs `company_id`).

`Workspace.key_maps`: `map_company_alias` (spelling aliases filled; **non-lexical blanks** `DEO`→`UBL`, `The South African Breweries`→`ABEV`; also `SBUX` / McDonalds / Costa / RedBull). Export → `seeds/map_company_alias.csv`.

Categories: A1, A3, A5, A8, A15–A19.

### 7. KeyMap labs (`fixtures/examples/`)

Full pattern matrix: [keymap-workflows.md](keymap-workflows.md). Regenerate: `python scripts/examples/generate_all.py`. PG: `python scripts/examples/load_postgres.py` → schema `keymap_demo`.

| DemoId | Story | Storage | PG? |
|--------|-------|---------|-----|
| `keymap_crosswalk` | Grocery POS sku ↔ WMS item | seed | no |
| `keymap_dual` | Restaurant brands vs AP vendors → `dim_party` | seed ×2 | no |
| `keymap_codes` | eCom channel synonyms | seed | no |
| `keymap_hop` | Café store → region → country | seed ×2 | no |
| `keymap_offer` | Recycled offer id + day → `offer_sk` (composite From) | seed arity-2 | no |
| `keymap_ref` | Channel map as `ref('map_channel')` | ref | no |
| `keymap_parquet` | Same crosswalk on Parquet, duckdb dest | seed | no |
| `keymap_pg` | Crosswalk facts+map in Postgres | source | yes |
| `keymap_pg_dual` | Dual maps + `dim_party` in Postgres | source ×2 | yes |
| `keymap_pg_seed` | PG sales + seed channel map | seed | yes |
| `keymap_mixed` | POS Parquet + WMS/map Postgres | source | yes |

Categories: A13, A15, A20–A27.
