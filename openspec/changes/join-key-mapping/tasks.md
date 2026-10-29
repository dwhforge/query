# Tasks: Join Key Mapping

## 1. IR / emit

- [x] `KeyMapDef` / `KeyMapEntry` / `NormalizeOp` on Workspace
- [x] `NormalizeKey` + `ApplyKeyMap` steps; schema pass-through
- [x] DuckDB preview emit + postgres overwrite with `prev_columns`
- [x] dbt seed CSV helpers + `key_map_relations` on emit

## 2. Near-miss

- [x] `join_key_near_miss` engine API
- [x] Host command + bridge
- [x] Join Lens strip + Apply → insert NormalizeKey

## 3. KeyMap UI

- [x] From→To editor (edit, paste, unique-from, Pick To)
- [x] Entry points: Lens blame, Hero playground, keymap demo, Apply L/R/Both
- [x] EmptyHero virtual project playground + `keymap` demo workspace
- [ ] Explorer KeyMaps list / History click-to-edit (follow-up polish)

## 4. Export + SoT

- [x] `seeds/map_*.csv` + seed-paths in export plan
- [x] Seed → KeyMap sync after first export (open/refresh)
- [x] Push KeyMap → seed + manifest hash update
- [x] Re-export stability test with a KeyMap
- [ ] (Optional UI) bind KeyMap to existing WH table / source

## 5. Docs

- [x] ADR-0020 (seed/table SoT after first export)
- [x] OpenSpec change `join-key-mapping`
- [x] DESIGN §9 link + userGuide + DEMOS
