# Tasks: return-and-edit-foundation

Implement only after proposal / specs / design review. Stop before Join diagnostics (DESIGN §9).

## 1. Step schema seeds

- [x] 1.1 Add `collect_load_seeds(workspace, connections, db)` in engine (or host glue): PG describe + DuckDB file describe → `HashMap<query_id, Vec<String>>`
- [x] 1.2 Extend `DbtProducer` with `produce_with_seeds` (CLI keeps empty seeds or same helper)
- [x] 1.3 Wire `export_dbt` (and optionally `preview_dbt_model`) to collect seeds then produce/compile
- [x] 1.4 Fail clearly when Postgres Rename→Append cannot emit (no seeds / unknown schema / no left_dbt)
- [x] 1.5 Unit/integration tests: seeds from describe mocked or fixture files; Rename→Append portable SQL in export tree

## 2. Safe re-export

- [x] 2.1 Define `.dwhforge-export.json` (or agreed name) schema: version, owned paths, hashes, metadata
- [x] 2.2 Plan full export in memory/temp; conflict-check against prior manifest **before** any write
- [x] 2.3 On success: write files, delete stale owned paths, write new manifest
- [x] 2.4 Leave unowned files untouched; surface conflict paths in `ExportResult` / error
- [x] 2.5 Tests: hand-edit refuse; no-op re-export hash-stable; focus change / unrelated query name stability; stale model removal

## 3. e2e

- [x] 3.1 Add fixture workspace (CSV pair + Rename/Append or Join) under `tests/` or `fixtures/`
- [x] 3.2 Script or `cargo test` / CI job: export → `dbt run` (DuckDB target) → compare to preview
- [x] 3.3 Document optional Postgres e2e; do not claim coverage without automation
- [x] 3.4 Keep `dbt parse` assertions separate from run+data assertions

## 4. Docs

- [x] 4.1 Tick DESIGN §10 A–C items that this change closes; leave D–E (Join / demand) open
- [x] 4.2 Point ADR-0018 / README only if paths or manifest filename need a one-line mention (avoid new planning docs)

## Done when

- [x] All ADDED requirements in `specs/*/spec.md` have a matching automated or documented manual check
- [x] Join diagnostics / expectations **not** started in this change
