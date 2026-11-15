# KeyMap workflows

Canon: [ADR-0020](adr/0020-join-key-mapping.md) · [ADR-0022](adr/0022-keymap-postgres-live-bind.md) · [ADR-0024](adr/0024-keymap-composite.md) · fixtures: [`scripts/examples/`](../scripts/examples/)

---

## Patterns (routes × storage × topology)

### Routes (where data lives / where dbt writes)

| Id | Sources | Engine → destination | Notes |
|----|---------|----------------------|--------|
| **R1** | Postgres tables | postgres → postgres | WH-native; no Parquet without landing |
| **R2** | Postgres + Parquet | duckdb → postgres | Mixed lake/WH; map often still a PG table |
| **R3** | Parquet/CSV | duckdb → duckdb | Offline / local; map usually **seed** |

Local preview always federates through DuckDB (+ ATTACH). That is the UI engine, not a fourth KeyMap storage.

### Map storage (SoT for `from→to`)

| Kind | When | Write-back |
|------|------|------------|
| **seed** | Slow-changing aliases, git/PR review | Export CSV / push to export tree |
| **source** | Live ops dictionary in **Postgres** | Save upserts by From **tuple** ([ADR-0022](adr/0022-keymap-postgres-live-bind.md), [ADR-0024](adr/0024-keymap-composite.md)) |
| **ref** | Map produced by a dbt model | None from the app |

`source` is unavailable on pure R3 (no Postgres). R1/R2 support all three.

### Topology (how streams relate)

| Id | Pattern | One-liner |
|----|---------|-----------|
| **B1** | Canonical hub | Dirty keys → **one** shared map → master id → dim |
| **B2** | Crosswalk | System A id ↔ system B id (bridge; master optional) |
| **B3** | Dual maps + master | **Two** maps (separate From spaces) → one dim; **edit dim as well as maps** |
| **B4** | Code synonyms | Flat code→code (channel/region), not an entity hub |
| **B5** | Multi-hop | Two ApplyKeyMap steps (e.g. store → region → country) |

**Collision warning (B1 shared map):** `from` is unique in one KeyMap. Short codes from different sources can collide (`ABC` ≠ same entity). Use **B3** (two maps) when From domains can overlap.

**B3 master edit:** adding a new party means insert into `dim_party` first, then alias rows in the sales and/or spend map. The map is not the roster of entities.

---

## Labs in Help → Help Lab

Catalog: [`fixtures/labs/catalog.json`](../fixtures/labs/catalog.json) ([ADR-0039](adr/0039-help-lab-catalog.md)). Featured offline recon: **Shipments ↔ sales** (`recon_ship_sales`).

| Demo | Route | Storage | Topology | Needs PG? |
|------|-------|---------|----------|-----------|
| Shipments ↔ sales | R3 lab CSV | seed | B2-ish recon | no |
| Key mapping (F&B) | R3-like CSV | seed | B1 hub | no |
| Crosswalk POS↔WMS | files | seed | B2 | no |
| Dual maps parties | files | seed ×2 | B3 | no |
| Channel codes | files | seed | B4 | no |
| Multi-hop stores | files | seed ×2 | B5 | no |
| Composite offer id+day | files | seed arity-2 | composite From | no |
| Ref map | files | **ref** | B4 | no |
| Parquet lab | R3 | seed | B2 | no |
| PG crosswalk | R1 | **source** | B2 | **yes** |
| PG dual + master | R1 | **source** ×2 | B3 | **yes** |
| PG facts + seed map | R1 sources / seed map | seed | B4 | **yes** |
| Mixed parquet+PG | R2 | source | B2 | **yes** |

Postgres lab: `postgresql://postgres:postgres@localhost:5432/dwh_tests`, schema `keymap_demo`, connection id `conn_postgres`.

```bash
python scripts/examples/generate_all.py
python scripts/examples/load_postgres.py
```

### Record-first full-tuple Matching (ADR-0051 / ADR-0052)

Join Lens **Find Matches** opens the existing Matching tab. Run **Find matches**
explicitly; each LEFT key and RIGHT output has its own readable field label.
Select a candidate for inspection, then **Confirm selected candidate** separately.
**Previous/Next unresolved** changes focus only; **Advance after confirm** is opt-in.
Filters and per-source picks survive navigation. A filtered-out source stays visibly
pinned rather than silently becoming another actionable source.

Search acquired RIGHT records or choose **Inspect RIGHT relationships**. One related
LEFT list carries **Suggested**, **Confirmed draft**, **Existing Mapping** and
**Actual JOIN** badges/filters. The authority summaries have separate coverage and
units: never add suggestion keys, Mapping aliases and executed row counts together.
Saved-only aliases and executed-only input records outside the run are read-only.

**Inspect actual JOIN counts and examples** explicitly reads the original current
JOIN through Host. Counts cover LEFT/RIGHT/result rows for the output-key group;
examples are limited to 50 rows. NULL uses SQL equality, outer-JOIN result rows
alone do not prove a partner, and transformed input keys do not recover original
aliases. Cached query-time evidence is timestamped, not a historical preview or an
external snapshot guarantee. Complete arbitrary-large reverse enumeration is not
supported; future paginated executed reverse is not required to use this workbench.

**Edit plan** retains contextual hard/soft/reference rules, using real Host fields.
Basic searches its acquired RIGHT universe; Advanced **Find right records** performs
source-scoped Host lookup beyond the shortlist, preserving hard constraints and
final lookup-page replay. Browsing another source's target never authorizes a pair.
Assistant, technical evidence and explicit counted bulk actions remain secondary.

**Write Mapping** verifies the same ledger and atomically prepares Mapping + Apply
before the original JOIN, with every ordered LEFT key mapped to its corresponding
RIGHT output. Review the full-tuple consequences, execute, and Save the project
separately. Refresh remaining review after Write to compare existing aliases with
new drafts. First Save can change project-relative execution context: reopen Find
Matches if the old review becomes stale; never bypass that guard. Cold reopen
restores project Mappings, not unwritten Matching drafts.

Compatible seed baselines come from the current project definition, not unsaved
editor overlays or empty session arrays. Source/query/ref/range baseline inspection
is explicitly unavailable here; unsupported writes are unchanged. The existing
vendor Help Lab demonstrates the workflow without changing its vendor-ID seed.
See [ADR-0052](adr/0052-matching-relationship-workbench.md) and the
[runtime evidence](../openspec/changes/unified-matching-workbench/runtime-report.md).

Crosswalk POS↔WMS (`sku` + `day`) and offer id+day (`keymap_offer`) remain useful
composite examples. Existing manual scalar/composite Mapping tools remain valid.
Never invent a glued `" · "` From string; structured exact parts preserve context.

---

## Classic F&B hub (seed B1)

Help → **Load demo → F&B hub**. Story: POS/sales vs cost feed spell brands differently. `dim_company` is the canonical roster. One KeyMap remaps aliases → `company_id`, then daily PnL and monthly rollup.

Scale: **15 companies × 60 days ≈ 900 rows** per fact.

**Non-lexical leftovers** (Join Lens **Auto** → LLM — fuzzy will not invent these):

| `sales_daily.company` | → `company_id` | Why not fuzzy |
|-----------------------|----------------|---------------|
| `DEO` | `UBL` | NYSE ticker for Diageo; dim id is legacy `UBL` |
| `The South African Breweries` | `ABEV` | Historical predecessor of AB InBev |

Near-lexical leftovers: `SBUX`→`STBUX`, `McDonalds`, `Costa`, `RedBull GmbH`.

### Cases

| Case | Query | What you see |
|------|-------|--------------|
| Sources | `sales_daily`, `res_consumption`, `dim_company` | e.g. `SBUX` / `DEO` vs `STARBUCKS CORP` |
| A — Diagnose ★focus | `dirty_join` | sales ⋈ dim **without** map → Lens Probe / **Auto** |
| B — Canon sales | `sales_canon` | ApplyKeyMap → join dim |
| B′ — Canon spend | `spend_canon` | same map on `org_name` |
| C — Daily PnL | `daily_pnl` | units · revenue · spend · **net_revenue** |
| D — Monthly | `monthly_pnl` | company × category × month |

### UI path (Add to map)

1. Lens **Probe** → unmatched → **Add to map…**
2. Several maps → pick target → **OK — open map**
3. KeyMap tab → fill **To** → **Apply left**

### SoT strip

seed: project → after Export: `seeds/map_*.csv` · source: warehouse write-back · ref: project cache / model.
