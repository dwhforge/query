# KeyMap workflows — F&B company names lab

Canon: [ADR-0020](adr/0020-join-key-mapping.md) · demo: Help → **Load demo → Key mapping**.

**Story:** food & beverage brands appear under different spellings in POS/sales (`sales_daily`) vs cost feed (`res_consumption`). `dim_company` is the canonical roster. One KeyMap remaps every alias → `company_id`, then you build **daily** PnL and a **monthly** rollup.

Scale: **15 companies × 60 days ≈ 900 rows** per fact (preview still shows a sample; scroll / filter in Data).

**Non-lexical leftovers** (Join Lens **Auto** → LLM chat — fuzzy will not invent these):

| `sales_daily.company` | → `company_id` | Why not fuzzy |
|-----------------------|----------------|---------------|
| `DEO` | `UBL` | NYSE ticker for Diageo; dim id is legacy `UBL`, not the ticker |
| `The South African Breweries` | `ABEV` | Historical predecessor of AB InBev — name never appears in `dim_company` |

Near-lexical leftovers still open for Probe / fuzzy: `SBUX`→`STBUX`, `McDonalds`, `Costa`, `RedBull GmbH`.

---

## Cases

| Case | Query | What you see |
|------|-------|--------------|
| Sources | `sales_daily`, `res_consumption`, `dim_company` | e.g. `SBUX` / `DEO` vs `STARBUCKS CORP` vs id `STBUX` |
| A — Diagnose ★focus | `dirty_join` | From `sales_daily` ⋈ dim **without** map → Lens Probe / **Auto** → Add to map… |
| B — Canon sales | `sales_canon` | ApplyKeyMap (DEO / SAB / McDonalds / Costa / RedBull still blank) → join dim |
| B′ — Canon spend | `spend_canon` | same map on `org_name` |
| C — Daily PnL | `daily_pnl` | company · category · day · units · revenue · spend · **net_revenue** |
| D — Monthly | `monthly_pnl` | company × category × month sums |

---

## UI path (Add to map)

1. Lens **Probe** → unmatched → **Add to map…**
2. If several maps: dialog → pick target → **OK — open map**
3. KeyMap **tab** (next to Pipeline) → fill **To** → footer **Apply left** (inserts `ApplyKeyMap` before the Join)

---

## SoT strip

seed: project → after Export: `seeds/map_company_alias.csv` · source: warehouse write-back · ref: project cache only.
