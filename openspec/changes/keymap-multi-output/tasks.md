# Tasks — keymap-multi-output

## 0. Spec gate
- [x] 0.1 ADR-0037 Accepted (+ amendments)
- [x] 0.2 OpenSpec proposal / design / delta specs
- [x] 0.3 Review: proposal → specs → design → tasks (closed 2026-11-05; implement)

## 1. IR + migration
- [x] 1.1–1.5 IR, format 3, validation, ts-rs, external map_id scope-aware refuse

## 2. Apply emit + uniqueness
- [x] 2.1–2.6 Multi-dest emit, miss/NULL abort, guard WHERE, collision-safe map aliases vs fact names
- [x] 2.7 Internal alias **allocator** vs prev/fact/dest (`_dwh_rid` → `_dwh_rid_1` …)
- [x] 2.8 Postgres abort = row-dependent subquery (not constant `1/0`)

## 3. Adapters
- [x] 3.1 Seed CSV + push/sync by **all** header names (From, outputs, attrs, SCD bounds); reject dup headers
- [x] 3.2–3.6 Source baselines, query, ref, YAML not_null on outputs

## 4. Editor + create + Lens
- [x] 4.1 Editor output list
- [x] 4.2 Create wizard multi target
- [x] 4.3 Lens named cells + Apply `output_bindings`
- [x] 4.4 **Required** UI review: destinations + Join ON preview → Apply only / Apply+Join
- [x] 4.5 Apply+Join preserves **exact Join identity** after insert (no right-query-only fallback)

## 5–6. Checks / merge
- [x] MappingCheck fingerprint; specs merged into `openspec/specs/keymap-multi-output-*`

## Verified
```
cargo test -p dwh-pipeline --lib
npx tsc --noEmit
npm run test:unit
```
Still open as acceptance gates (not claimed done): live Postgres matrix; DuckDB `COUNT(*)` prune harness; preview↔dbt **result** parity (SQL-shape only today).
