# KeyMap Apply operation boundaries

## Why

ADR-0037 multi-output is domain-correct but orchestration is patch-driven: Editor, App, service, emit, and compile wrappers each decide Apply semantics. `compile_*` also hides full-set data validation. Before more KeyMap features, tighten the operation boundary ([ADR-0038](../../../docs/adr/0038-keymap-apply-operation.md)).

## In scope

- Canonical **ApplyPlan** / `ApplyUserChoice`; App does not default bindings or Join ON
- Explicit prepare → validate → execute in `dwh-engine`; `compile_*` = SQL only
- Narrow **ApplyEmitSpec** for `emit_apply_key_map`
- Legacy `to` / `*_eff` normalization at decode/migration edges only
- Execution gates already started under multi-output (DuckDB cardinality, export_e2e, PG abort shape)

## Out of scope

- Full SQL AST rewrite
- Job registry / multi-session DuckDB
- New multi-output product capabilities

## Capabilities

1. **keymap-apply-plan** — ApplyUserChoice → ApplyPlan → project fold
2. **keymap-apply-prepare** — prepare / validate / compile separation
3. **keymap-apply-emit-spec** — ApplyEmitSpec into dialect SQL

## ADR

[ADR-0038](../../../docs/adr/0038-keymap-apply-operation.md)
