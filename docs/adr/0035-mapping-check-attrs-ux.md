# ADR-0035 — MappingCheck attrs UX (Join-inferred overview)

## Status

**Accepted** (2026-11-05) — implements user KeyMap overview beyond the Help lab.

## Context

[ADR-0026](0026-mapping-quality-overview.md) shipped a Help-lab overview. [ADR-0027](0027-mapping-quality-checks.md) requires overview on the user’s KeyMap with **user-selected** grouping attributes. The first UI path auto-bound Join ON×ON, producing a tautological diagonal (same axis values, 100% “coverage”). Create lived under Help — wrong for a project action.

Users need overview inferred from **Join + ApplyKeyMap + side schemas** (lab *spirit*), including composite From with a date part ([ADR-0024](0024-keymap-composite.md) recycled id + `as_of_day`). Axes must not depend on whatever columns survived the final host SELECT.

## Decision

1. **Entry points:** KeyMap editor and Join inspector (and overview empty-state). Not Help. Lab demo stays under Help → Mapping labs.
2. **Side-anchored projection:** Attrs summary rebuilds the Join and selects left attrs from the left input and right attrs from the right input. Downstream drops do not erase axes.
3. **Inference + override:** Suggest attrs from side schemas (name-like, avoid ON×ON). Dialog confirms/overrides; happy path can accept suggestions.
4. **Grain vs axes:** UI shows Join ON as grain; matrix axes are side labels (or From-tuple), not bare ON×ON by default.
5. **Composite / date:** Row-axis identity is the full From/ON tuple when arity > 1 — **date stays in the key**. Samples and Inspect use all parts. Top-N group budget + truncation note. No day-bucket UI in v1.
6. **Not claimed yet:** Lab-identical family/grade/basis/concentration auto-profiler on arbitrary schemas; SCD range (`valid_from`/`valid_to`) overview ([ADR-0028](0028-keymap-stewardship-shapes.md)); composite batch remap.

## Consequences

- `MappingCheckProjection::Attrs` carries `left_attrs[]`, `right_attrs[]`, `sample_columns[]` (singular fields soft-migrated on load).
- OpenSpec: amend `mapping-quality-checks` when merging; this ADR is the product lock.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0024](0024-keymap-composite.md), [ADR-0026](0026-mapping-quality-overview.md), [ADR-0027](0027-mapping-quality-checks.md), [ADR-0028](0028-keymap-stewardship-shapes.md)
- Spec: [`openspec/specs/mapping-quality-checks/`](../../openspec/specs/mapping-quality-checks/)
