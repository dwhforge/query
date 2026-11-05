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
- [x] 1.5 External Apply `map_id` scope-aware: refuse inventing `map_column` from a local twin id

## 2. Apply emit + uniqueness
- [x] 2.1 Shared emitter: multi-destination SELECT; DuckDB EXCLUDE / Postgres column list
- [x] 2.2 Miss: COALESCE vs new-col NULL; found NULL/blank aborts both dialects
- [x] 2.3 Execution-path uniqueness / SCD match-count guard; `_dwh_apply_guard` + WHERE (no silent first-row)
- [x] 2.4 Collision-safe map aliases (`_dwh_mf_*` / `_dwh_mo_*`); same-named fact/map overwrite + miss
- [x] 2.5 Postgres abort: `1/(SELECT 0 WHERE cond)` — not constant `1/0`
- [x] 2.6 Preview ↔ dbt fixture parity (single + multi output) — SQL shape + export tests

## 3. Adapters
- [x] 3.1 Seed CSV header + sync/push by name (`key_map_seed_csv_outputs` / `parse_key_map_seed_csv_outputs`)
- [x] 3.2 Source baselines `outputs` map; Save compares all; content hash; Save locks binding
- [x] 3.3 Output-set change: re-read if clean; refuse/confirm discard if dirty (Cancel restores)
- [x] 3.4 Query: multi output binding, RO grid, Refresh, live Apply, no entries copy
- [x] 3.5 Ref: multi-col export Apply; no seed copy; no Lens write; unvalidated preview path
- [x] 3.6 Export YAML tests additional (`not_null` on all outputs, `unique_combination_of_columns`)

## 4. Editor + create + Lens
- [x] 4.1 Editor output list (add/remove/reorder/rename); Apply consumers warning
- [x] 4.2 Create wizard multi target; plan physical names; stale on any missing selected field
- [x] 4.3 Lens: named `cells` from right row → filtered merge; Apply inserts `output_bindings`; `joinRewrite` supported on ctx
- [ ] 4.4 UI review surface for Apply+Join destination↔right equals (optional; ctx.joinRewrite works when set)

## 5. MappingCheck + temporal
- [x] 5.1 Fingerprint / Inspect / Lens jump include outputs + bindings
- [x] 5.2 Coverage per key; distinct outcomes (ambiguous vs Join miss vs multiply)
- [x] 5.3 Multi-output range SCD seed/source; query SCD still refused

## 6. Labs + done
- [x] 6.1 Keep existing scalar labs; multi-output helpers/tests cover product+variant paths
- [x] 6.2 Negative: external migrate invent; collision emit; PG constant abort refused; dirty Cancel (unit)
- [x] 6.3 Merge deltas → `openspec/specs/keymap-multi-output-*`; update README / AGENTS

## Verified (review patch, SHA `94e180f` workspace; uncommitted)
```
cargo test -p dwh-pipeline --lib   # 142 ok
npx tsc --noEmit
npm run test:unit                  # ok
```
Not yet: live Postgres matrix (valid/miss/dup/NULL/overlap) against a real server; DuckDB `SELECT COUNT(*)` prune execution harness.
