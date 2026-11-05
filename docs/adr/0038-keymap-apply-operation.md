# ADR-0038 — KeyMap Apply operation boundaries

## Status

**Accepted** (2026-11-05). OpenSpec: [`openspec/changes/keymap-apply-operation/`](../../openspec/changes/keymap-apply-operation/).

Builds on [ADR-0037](0037-keymap-multi-output.md) multi-output IR and [ADR-0036](0036-query-backed-keymap.md) full-set validation. Complements [ADR-0031](0031-execution-lifecycle.md) (session/cancel) without a job registry.

## Context

After ADR-0037, Apply correctness was restored with many corrective patches. Domain model (map vs Apply vs Join, query relation vs entries) is sound. Orchestration was not: bindings defaults, Join rewrite, and validation were decided again in Editor, `App.tsx`, helpers, emitter, and compile wrappers.

`compile_*` also grew a hidden full-set data scan. That mixes SQL generation with execution-time validation and makes cost/cancel hard to reason about.

## Decision

1. **ApplyPlan is the SoT after user confirm.**  
   Review / Lens emit an `ApplyUserChoice` (side, included bindings, optional Join equalities / kept ON). Application code resolves that into a fully checked **ApplyPlan** (per-side bindings, frozen Join identity, optional rewrite, map id/revision). The project fold and reducer accept only that plan (or an intent built solely from it). `App.tsx` does not invent bindings or Join ON defaults.

2. **Prepare → validate → execute are explicit.**  
   - `prepare_operation` — schemas, seeds, SqlModel probes, listed query maps (once).  
   - `validate_prepared` — full-set query-map checks (ADR-0036), explicit.  
   - `compile_*` — SQL generation only; no data scans.  
   Preview = prepare → validate → compile → run. Describe / column pickers may prepare without validate.

3. **Emitter consumes a narrow ApplyEmitSpec.**  
   Fact keys, map from/outputs, bindings, temporal predicate, dialect-neutral flags. Alias allocation and string SQL stay inside emit; they do not choose which outputs apply.

4. **Legacy scalar fields stop at decode/migration.**  
   Wire may still carry `to` / `to_column` / `output_column`. After load/`canonicalize_*`, runtime (emit, seed headers, ApplyPlan) uses `output_columns` / `output_values` / `output_bindings` only.

5. **Snapshot / cancel.**  
   Prepare results are scoped to one preview/analysis request (ADR-0031 lanes). Cancel aborts the in-flight DuckDB work for that operation; it does not partially apply an ApplyPlan to the project.

## Consequences

- Thin UI: show plan, confirm choice; no second semantic assembly in App.
- OpenSpec change `keymap-apply-operation` tracks deltas until merged into `openspec/specs/`.
- Further KeyMap features extend ApplyPlan / ApplyEmitSpec rather than new App callbacks.

## Out of scope

- Full SQL AST for the product.
- Multi-session DuckDB / durable job store.
- New multi-output product features (typed outputs, per-binding miss policy).

## References

- [ADR-0031](0031-execution-lifecycle.md), [ADR-0036](0036-query-backed-keymap.md), [ADR-0037](0037-keymap-multi-output.md)
