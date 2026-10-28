# Spec Delta: key-map-export

## Purpose

dbt export ships KeyMaps as seeds and models that join them; re-export stays stable when maps are unchanged.

## ADDED Requirements

### Requirement: Seeds written for used maps

When the workspace has KeyMaps (catalog or ApplyKeyMap snapshots), export SHALL write `seeds/map_<sanitized_id>.csv` with header `from,to` and set `seed-paths` in `dbt_project.yml`.

#### Scenario: One map seed
- **GIVEN** a KeyMap `id=channel_alias` with entries
- **WHEN** the user exports dbt
- **THEN** the plan includes `seeds/map_channel_alias.csv` (or sanitized equivalent)
- **AND** `dbt_project.yml` lists `seed-paths: ["seeds"]`

### Requirement: Model SQL refs seed

ApplyKeyMap in exported models SHALL join `{{ ref('map_<id>') }}` (not only CASE), preserving COALESCE semantics.

#### Scenario: Export contains ref
- **GIVEN** a query with ApplyKeyMap before Join
- **WHEN** that query’s model SQL is compiled for export
- **THEN** the SQL contains `ref('map_` … `')` for that map id

### Requirement: Seed is SoT after first export

After the project has a linked export path with map seeds, those seed files SHALL be the source of truth for KeyMap rows. The system SHALL sync seed → KeyMap (and ApplyKeyMap entry snapshots) on project open / explicit refresh.

#### Scenario: Hand-edited seed reloads into editor
- **GIVEN** a project previously exported with `seeds/map_channel.csv`
- **WHEN** a DE edits that CSV and the project is opened or maps are refreshed
- **THEN** the KeyMap editor shows the edited From→To rows
- **AND** ApplyKeyMap steps using that `map_id` carry the updated entries for preview

#### Scenario: Re-export refuses clobber of divergent seed
- **GIVEN** the seed file on disk differs from what the last export wrote (content hash)
- **WHEN** the user exports again without adopting the disk seed into KeyMap first
- **THEN** safe re-export refuses or requires adopt — it SHALL NOT silently overwrite the DE’s seed

### Requirement: Stable re-export

Unchanged KeyMaps and ApplyKeyMap steps SHALL produce identical seed file content hashes across noop re-exports (safe re-export contract).

#### Scenario: Noop re-export
- **GIVEN** an exported project with seeds from KeyMaps and no disk edits
- **WHEN** export runs again without IR changes
- **THEN** seed file bodies match the previous export (no spurious diff)

### Requirement: Map is a table, seed is one backend

ApplyKeyMap SHALL join a relation with `from`/`to` columns. The default backend is a generated seed; binding to an existing warehouse table or dbt source/ref SHALL be representable without changing Join ON semantics.

#### Scenario: Default seed backend
- **WHEN** a KeyMap has no external relation bind
- **THEN** export materializes `seeds/map_*.csv` and models `ref` that seed
