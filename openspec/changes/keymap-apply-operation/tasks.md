# Tasks — keymap-apply-operation

## 0. Spec gate
- [x] 0.1 ADR-0038 Accepted
- [x] 0.2 proposal / design / delta specs
- [x] 0.3 Review closed with implementation (same change)

## 1. Execution evidence (shared with ADR-0037 closeout)
- [x] 1.1 DuckDB multi-output COUNT(*) / miss cardinality harness
- [x] 1.2 export_e2e seed/Apply column agreement (`canonical_id` not stale `to`)
- [x] 1.3 PG abort shape (shape-only test) + live ATTACH evaluation when `DWH_PG_DSN` set
- [x] 1.4 Negative COUNT(*) SQL uniqueness guard (compile without full-set)
- [x] 1.5 Full-set ambiguous refusal tested separately from SQL guard

## 2. ApplyPlan
- [x] 2.1 Types + `resolveApplyPlan`
- [x] 2.2 Thin App.tsx — dispatch plan only
- [x] 2.3 Plan → payload unit tests (right dest, subset+keep day)
- [x] 2.4 Working `expectedMapRevision` at commit; no snapshot upsert over R2
- [x] 2.5 Strict choice vs defaults; binding elementary checks

## 3. Engine boundaries
- [x] 3.1 Remove validate from `compile_*`
- [x] 3.2 `prepare_operation` / `validate_prepared`; preview / `compile_*_for_execution`

## 4. ApplyEmitSpec
- [x] 4.1 Spec struct + emit consumes it
- [x] 4.2 Compiler builds spec from step + opts

## 5. Legacy edge
- [x] 5.1 `canonicalize_outputs` on Project::from_json; entry mirrors at decode
- [x] 5.2 ADR honesty: legacy normalization still in progress (not a closed boundary)
