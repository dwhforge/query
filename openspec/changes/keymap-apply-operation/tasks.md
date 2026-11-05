# Tasks — keymap-apply-operation

## 0. Spec gate
- [x] 0.1 ADR-0038 Accepted
- [x] 0.2 proposal / design / delta specs
- [x] 0.3 Review closed with implementation (same change)

## 1. Execution evidence (shared with ADR-0037 closeout)
- [x] 1.1 DuckDB multi-output COUNT(*) / miss cardinality harness
- [x] 1.2 export_e2e seed/Apply column agreement (`canonical_id` not stale `to`)
- [x] 1.3 PG abort shape (+ optional `DWH_PG_DSN` live note)

## 2. ApplyPlan
- [x] 2.1 Types + `resolveApplyPlan`
- [x] 2.2 Thin App.tsx — dispatch plan only
- [x] 2.3 Plan → payload unit tests (right dest, subset+keep day)

## 3. Engine boundaries
- [x] 3.1 Remove validate from `compile_*`
- [x] 3.2 `prepare_operation` / `validate_prepared`; preview / `compile_*_for_execution`

## 4. ApplyEmitSpec
- [x] 4.1 Spec struct + emit consumes it
- [x] 4.2 Compiler builds spec from step + opts

## 5. Legacy edge
- [x] 5.1 `canonicalize_outputs` on Project::from_json; entry mirrors at decode
