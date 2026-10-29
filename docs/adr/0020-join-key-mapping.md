# ADR-0020 — Join Key Mapping Tool

## Status

**Accepted** (MVP). Fuzzy suggestions → Accept into KeyMap are opt-in later; automatic fuzzy merge remains forbidden.

## Business north star (two product directions)

DWHForge Query wins if the user **keeps working here** instead of bouncing to IDE / Excel / ad-hoc SQL. Key mapping sits on that same bet — not as a side feature, but as the everyday dirty work of joins.

### 1) Build & evolve dbt projects (stay in the app)

- **Job:** assemble multi-source transforms → preview on real data → export a **real** dbt tree → change something → re-export a reviewable diff ([ADR-0018](0018-return-and-edit.md)).
- **Business goal:** close the “create once, then live in VS Code / dbt Cloud” leak. If Export is a one-shot dump, we lose the user. Safe re-export, Join Lens, and canvas tabs exist so the **loop returns to DWHForge**.
- **Success signal:** same person who exported last week opens the project again here to fix a join / filter / map — not only to re-generate from scratch.

### 2) Edit join-key mappings (operational SoT, not a throwaway grid)

Industry trend (Tableau Prep cleaners, Power Query From/To / merge columns, Alteryx Find Replace, dbt **seeds** as git-backed lookup tables):

| Trend | What users actually do | What we refuse |
|-------|------------------------|----------------|
| Diagnosis ≠ silent fix | See unmatched keys, then **choose** Normalize or alias | Auto fuzzy Join ON ([ADR-0019](0019-join-lens-ai-narrator.md)) |
| Mapping = a **table** | Maintain `from → to` like any dimension | One-off UI state that dies at Export |
| Two SoT styles | (A) **Git/seed** for slow-changing aliases in CI; (B) **Warehouse table** for live ops edits | Project JSON as fake SoT with disposable CSV |
| Stay in flow | Edit map in the same tool that shows Join failures | Export → open CSV in Excel → hope models still match |

**Where we are going (mapping):**

1. **Discover** mismatch in Join Lens / near-miss → one click into a KeyMap tab (first-class surface next to Pipeline canvas).
2. **Edit** From→To in-app (grid feels like the table it is).
3. **Persist** in the form DE already trust:
   - **seed** → `seeds/map_*.csv` in the exported dbt project (git + `dbt seed` in CI);
   - **source** → live Postgres table with write-back;
   - **ref** → bind existing model (no inventing a second copy).
4. **Apply** via explicit `ApplyKeyMap` / `NormalizeKey` steps — inspectable in the graph and in generated SQL.
5. **Return:** after first export, seed/table is SoT; sync back into the editor so Git or WH edits are not lost, and re-export does not clobber them.

Mapping is therefore both a **join-fixing tool** and a **reason to reopen the app** when aliases change — same “return and edit” economy as (1).

## Context (technical)

Join Lens / diagnostics show unmatched keys and near-miss patterns (trim/case/spaces/zeros), but industry tools treat **diagnosis ≠ action**. Tableau Prep cleans before Join; Power Query uses a From/To transformation table; Alteryx Find Replace; dbt ships infrequently changing aliases as **seeds** (which become warehouse **tables**). We already rejected automatic fuzzy join ON ([ADR-0019](0019-join-lens-ai-narrator.md)).

Data engineers edit mappings as a **table** (`from`, `to`) — in git as `seeds/*.csv` (loaded by `dbt seed`) or as an existing WH / Postgres reference table. A GUI From→To grid is the same table, not a different concept. Treating project JSON as sole SoT with seeds as throwaway export is **not** acceptable for DE: they expect to edit the seed/table in the dbt project and have that stick.

## Decision

1. **Near-miss → explicit `NormalizeKey` step** before Join on Left / Right / Both. API `join_key_near_miss` scores deterministic ops by distinct key-overlap delta; Apply inserts the step — never mutates Join ON silently.
2. **Alias map = table** with unique `from` → `to`. In the product: `KeyMap` resource + From→To editor (many entry points; workspace tabs). In dbt: the same rows as a relation — default ship path is `seeds/map_*.csv` → table via `dbt seed`; models `left join {{ ref('map_*') }}`.
3. **`ApplyKeyMap { column, map_id, … }`** remaps via LEFT JOIN to that map relation (preview may use VALUES/temp; export always joins the seed/table). Apply side = Left / Right / Both. Re-apply updates `(query, column, map_id)`.
4. **Source of truth (DE-aligned):**
   - **Before first export:** KeyMap in the project (editor) is SoT; export writes `seeds/map_*.csv`.
   - **After first export** (project has `last_dbt_export_path` / linked export tree): the seed file (and thus the warehouse table after `dbt seed`) is SoT. Opening the project or refreshing maps **SHALL sync seed → KeyMap** (and refresh ApplyKeyMap snapshots). Re-export must not clobber hand-edited seeds without the safe-re-export conflict rules (hash / refuse).
   - **Bind:** KeyMap storage may be generated **seed** (default), existing dbt **`ref(model)`**, or **`source(name, table)`**. Explorer lists KeyMaps; editor sets storage + from/to column names. CSV seed is the default portable form, not the only backend.
   - **Write-back (source):** editing From→To and Save does a **full replace** (`DELETE` + `INSERT`) into the Postgres `source.table` via DuckDB ATTACH (writable). Open reloads live rows from WH. **ref** has no write-back (dbt run owns the model). **seed** write-back is the export CSV / push to export tree.
5. **Out of scope:** automatic fuzzy merge; AI inventing aliases; universal column schema mapper.

## Consequences

- New IR steps: `NormalizeKey`, `ApplyKeyMap`; `Workspace.key_maps`.
- Export: `seed-paths` + `seeds/map_<id>.csv`; models join `ref('map_*')`.
- Seed↔KeyMap sync is **in MVP**, not deferred — required for DE acceptance.
- Safe re-export treats map seeds as owned files with hashes; external edits are detected.
- Product narrative: mapping is part of *return and edit*, not a one-off export helper.
- OpenSpec change: `openspec/changes/join-key-mapping/`.
