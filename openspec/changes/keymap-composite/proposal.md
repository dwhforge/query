# Proposal: Composite KeyMap + multi-key Join Auto

## Why

Single-column KeyMaps ([ADR-0020](../../../docs/adr/0020-join-key-mapping.md)) miss two everyday cases:

1. Join ON multiple columns where **one** needs remapping (sku + day) — Auto currently hard-disables.
2. Alias uniqueness is a **From tuple** (recycled ext id + as-of day → surrogate) — cannot fit in one `from` without collisions.

## What changes

| In scope | Out of scope |
|----------|--------------|
| IR: `from_columns` / `from_parts`, ApplyKeyMap `columns` (+ soft migrate) | Multi-To maps |
| Seed/source/ref for arity N→1 | Silent fuzzy Join ON |
| Auto: per-column **or** composite-map mode on multi-key Join | Auto inventing which mode without ask |
| Editor + Suggest UX for both modes | File KeyMap bind |
| Demo: offer id+day composite; keep POS+day as per-column lab | |
| [ADR-0024](../../../docs/adr/0024-keymap-composite.md) | |

## Capabilities

1. **keymap-composite-ir** — arity N From, validate tuple uniqueness, emit Apply join ON all Froms
2. **keymap-composite-export** — seed headers, source upsert-by-tuple, sync
3. **keymap-composite-auto** — Suggest modes on composite Join
4. **keymap-composite-ui** — editor columns, Apply, mode picker

## Success

- Arity-1 projects/seeds behave as today.
- Composite seed `(ext_id, day)→offer_sk` Applies and exports; duplicate tuples rejected.
- Multi-key Join Auto offers per-column remap **and** composite-map path; neither blocked with a dead-end only message.
- POS↔WMS demo still teaches per-column; new demo teaches composite From.

## References

- [ADR-0024](../../../docs/adr/0024-keymap-composite.md), [ADR-0020](../../../docs/adr/0020-join-key-mapping.md), [ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)
