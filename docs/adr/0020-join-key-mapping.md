# ADR-0020 — Join Key Mapping Tool

## Status

**Accepted** (MVP). Fuzzy suggestions → Accept into KeyMap are opt-in later; automatic fuzzy merge remains forbidden.

## Context

Join Lens / diagnostics show unmatched keys and near-miss patterns (trim/case/spaces/zeros), but industry tools treat **diagnosis ≠ action**. Tableau Prep cleans before Join; Power Query uses a From/To transformation table; Alteryx Find Replace; dbt ships infrequently changing aliases as **seeds** (which become warehouse **tables**). We already rejected automatic fuzzy join ON ([ADR-0019](0019-join-lens-ai-narrator.md)).

Data engineers edit mappings as a **table** (`from`, `to`) — in git as `seeds/*.csv` (loaded by `dbt seed`) or as an existing WH / Postgres reference table. A GUI From→To grid is the same table, not a different concept. Treating project JSON as sole SoT with seeds as throwaway export is **not** acceptable for DE: they expect to edit the seed/table in the dbt project and have that stick.

## Decision

1. **Near-miss → explicit `NormalizeKey` step** before Join on Left / Right / Both. API `join_key_near_miss` scores deterministic ops by distinct key-overlap delta; Apply inserts the step — never mutates Join ON silently.
2. **Alias map = table** with unique `from` → `to`. In the product: `KeyMap` resource + From→To editor (many entry points). In dbt: the same rows as a relation — default ship path is `seeds/map_*.csv` → table via `dbt seed`; models `left join {{ ref('map_*') }}`.
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
- OpenSpec change: `openspec/changes/join-key-mapping/`.
