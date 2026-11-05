# ADR-0038 — KeyMap Apply operation boundaries

## Status

**Accepted** (2026-11-05). Hardening patch (revision commit check, strict choice vs defaults, execution gates) 2026-11-05.

OpenSpec: [`openspec/specs/keymap-apply-*`](../../openspec/specs/) (merged from [`openspec/changes/keymap-apply-operation/`](../../openspec/changes/keymap-apply-operation/)).

Builds on [ADR-0037](0037-keymap-multi-output.md) multi-output IR and [ADR-0036](0036-query-backed-keymap.md) full-set validation. Complements [ADR-0031](0031-execution-lifecycle.md) (session/cancel) without a job registry.

## Context

After ADR-0037, Apply correctness was restored with many corrective patches. Domain model (map vs Apply vs Join, query relation vs entries) is sound. Orchestration was not: bindings defaults, Join rewrite, and validation were decided again in Editor, `App.tsx`, helpers, emitter, and compile wrappers.

`compile_*` also grew a hidden full-set data scan. That mixes SQL generation with execution-time validation and makes cost/cancel hard to reason about.

## Decision

1. **ApplyPlan is the SoT after user confirm.**  
   Review / Lens emit an `ApplyUserChoice` (side, included bindings, optional Join equalities / kept ON). Application code resolves that into an **ApplyPlan** with side-specific bindings, optional Join rewrite, frozen Join identity, and a **map revision fingerprint**. The fold accepts only that intent and **checks `expectedMapRevision` against the live Project map before any mutation**. A matching revision uses the live map for Apply — it does **not** upsert the plan's map snapshot over a newer R2.

   - `choice` omitted → defaults allowed (scalar / no-review path).
   - `choice` present with empty or invalid bindings → **error** (not silent defaults).
   - Resolver refuses elementary binding ambiguity (unknown `map_column`, empty/duplicate destinations, From arity vs Apply keys, invalid map basics). Column existence against a fact schema remains a prepare/describe concern.

2. **Prepare → validate → execute are explicit.**  
   - `prepare_operation` — schemas, seeds, SqlModel probes, listed query maps (once).  
   - `validate_prepared` — full-set query-map checks (ADR-0036), explicit.  
   - `compile_*` — SQL generation only; no data scans.  
   Preview = prepare → validate → compile → run. Describe / column pickers may prepare without validate.

3. **Emitter consumes a narrow ApplyEmitSpec.**  
   Fact keys, map from/outputs, bindings, temporal predicate, dialect-neutral flags. Alias allocation and string SQL stay inside emit; they do not choose which outputs apply. Binding defaults may still be normalized once when building the spec from a step (planning vs rendering split is incremental).

4. **Legacy scalar fields — normalize at the edge (in progress).**  
   Target path: decode / legacy constructors → **strict normalization** → canonical runtime values (`output_columns` / `output_values` / `output_bindings`).  
   Today `canonicalize_outputs` still mirrors scalar ↔ first vector element for wire compatibility, and `output_columns_eff` may prefer a legacy `to_column` when the list is only the default `["to"]`. That compatibility rule is **documented at the decode/`*_eff` edge**, not a finished “scalars never appear mid-pipeline” boundary. Conflicting scalar/list values must not be re-decided ad hoc inside the emitter hot path beyond that documented rule.

5. **Snapshot / cancel.**  
   Prepare results are scoped to one preview/analysis request (ADR-0031 lanes). Cancel aborts the in-flight DuckDB work for that operation; it does not partially apply an ApplyPlan to the project.

6. **Revision fingerprint semantics.**  
   - **seed** — definition + entry content (value changes at the same row count invalidate).  
   - **query** — binding + relevant query definition (not result rows).  
   - **source/ref** — definition/binding only; not a claim about warehouse content.

## Consequences

- Thin UI: show plan, confirm choice; no second semantic assembly in App.
- Stale Apply after map edit fails closed without replacing R2.
- Further KeyMap features extend ApplyPlan / ApplyEmitSpec rather than new App callbacks.
- Legacy edge cleanup remains an incremental follow-up; do not treat it as fully closed.

## Out of scope

- Full SQL AST for the product.
- Multi-session DuckDB / durable job store.
- New multi-output product features (typed outputs, per-binding miss policy).
- Immediate removal of all scalar wire fields / `*_eff` helpers.

## References

- [ADR-0031](0031-execution-lifecycle.md), [ADR-0036](0036-query-backed-keymap.md), [ADR-0037](0037-keymap-multi-output.md)
