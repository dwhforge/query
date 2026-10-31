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

## Labs in Help → Load demo

| Demo | Route | Storage | Topology | Needs PG? |
|------|-------|---------|----------|-----------|
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

### Multi-key Join Auto (ADR-0024)

| Mode | Lab | When |
|------|-----|------|
| **Per-column** | Crosswalk POS↔WMS (`sku` + `day`) | Other ON cols already align; remap only the dirty key |
| **Composite map** | Offer id+day (`keymap_offer`) | From uniqueness needs the **tuple** (recycled ext id) |

Never invent a glued `" · "` From string — Accept uses `from_parts`.

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
