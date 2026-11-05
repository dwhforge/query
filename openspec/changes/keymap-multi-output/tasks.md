# Tasks — keymap-multi-output

## 0. Spec gate
- [x] 0.1 ADR-0037 Accepted (+ amendments)
- [x] 0.2 OpenSpec proposal / design / delta specs
- [x] 0.3 Review: proposal → specs → design → tasks (closed 2026-11-05; implement)

## 1. IR + migration
- [x] 1.1 `output_columns` / `output_values` / `output_bindings` (+ `*_eff` / legacy soft-read); migrate strips scalars
- [x] 1.2 `PROJECT_FORMAT_VERSION = 3` + `migrate_v2_to_v3` + fixtures (incl. Apply snapshots, missing-map refuse)
- [x] 1.3 Validate name uniqueness, arity, ready NULL/`""`, static dup From, SCD overlap
- [x] 1.4 ts-rs regenerate (`KeyMapAuthoringContext`, `ApplyKeyMapOutputBinding`); pipeline.ts fields; v2→v3 unit tests

## 2. Apply emit + uniqueness
- [x] 2.1 Shared emitter: multi-destination SELECT; DuckDB EXCLUDE / Postgres column list
- [x] 2.2 Miss: COALESCE vs new-col NULL; found NULL/blank aborts both dialects
- [x] 2.3 Execution-path uniqueness / SCD match-count guard (design.md); no silent DISTINCT
- [x] 2.4 Preview ↔ dbt fixture parity (single + multi output)

## 3. Adapters
- [x] 3.1 Seed CSV header + sync/push by name
- [x] 3.2 Source baselines `outputs` map; Save compares all; content hash; Save locks binding
- [x] 3.3 Output-set change: re-read if clean; refuse/confirm discard if dirty (Cancel restores)
- [x] 3.4 Query: multi output binding, RO grid, Refresh, live Apply, no entries copy
- [x] 3.5 Ref: multi-col export Apply; no seed copy; no Lens write; unvalidated preview path
- [x] 3.6 Export YAML tests additional (`not_null`, `unique_combination_of_columns`)

## 4. Editor + create + Lens
- [x] 4.1 Editor output list (add/remove/reorder/rename); Apply consumers warning
- [x] 4.2 Create wizard multi target; plan physical names; stale on any missing selected field
- [x] 4.3 Lens: Apply vs Apply+Join; named `cells` patches; conflict non-overwrite; `toValues[]` stays scalar list

## 5. MappingCheck + temporal
- [x] 5.1 Fingerprint / Inspect / Lens jump include outputs + bindings
- [x] 5.2 Coverage per key; distinct outcomes (ambiguous vs Join miss vs multiply)
- [x] 5.3 Multi-output range SCD seed/source; query SCD still refused

## 6. Labs + done
- [x] 6.1 Keep existing scalar labs; multi-output helpers/tests cover product+variant paths
- [x] 6.2 Negative acceptance: dirty Cancel; create stale; partial Lens; missing-map migrate; NULL output (unit coverage)
- [x] 6.3 Merge deltas → `openspec/specs/keymap-multi-output-*`; update README / AGENTS
