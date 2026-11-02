# ADR-0024 — Composite KeyMap From + multi-key Join Auto

## Status

**Accepted** — OpenSpec merged under `openspec/specs/keymap-composite-*`

## Context

[ADR-0020](0020-join-key-mapping.md) KeyMaps are single-column `from → to`. That covers the common case (alias one entity key; other Join ON columns already align).

Real pipelines also need:

1. **Composite Join Auto** — Join ON `(sku, day)` where only `sku` (or only `country`) needs remapping; Auto must not hard-fail on `left_on.len() != 1`.
2. **Composite From map** — uniqueness of the alias is the **tuple**, e.g. recycled `ext_offer_id` + `as_of_day` → `offer_sk`. A single-column From collides.

Silent fuzzy Join ON remains forbidden ([ADR-0019](0019-join-lens-ai-narrator.md)).

## Decision

### 1. KeyMap arity

- `KeyMapDef.from_columns: string[]` (len ≥ 1). Soft-migrate: legacy `from_column` → `from_columns: [from_column]`.
- `KeyMapEntry.from_parts: string[]` aligned to `from_columns`. Soft-migrate: legacy `from` → `from_parts: [from]`. Writers may still emit `from` when arity=1 for backcompat.
- Uniqueness rule: trimmed **tuple** `from_parts` unique within the map (not each part alone).
- `to_column` / `to` remain single for v1 (N→1). Multi-To deferred.

### 2. ApplyKeyMap

- `columns: string[]` on the fact (len = map arity). Soft-migrate: `column` → `columns: [column]`.
- Emit: `LEFT JOIN` map `ON` all From equalities; overwrite **one** output column with `COALESCE(map.to, …)` (default: first of `columns`). Optional `output_column` when the canonical id should land elsewhere.
- Other From columns (e.g. `day`) unchanged unless listed as output.

### 3. Seed / source / ref

- Seed CSV header = `from_columns…,to_column` (arity 1: `from,to` unchanged).
- Source bind: wizard picks **N From columns** + To (+ attrs). Write-back upsert key = From tuple.
- Ref: model must expose the same column names.

### 4. Join Lens Auto / Suggest on composite Join

Without compromise, both workflows are first-class:

| Mode | When | Behavior |
|------|------|----------|
| **Per-column** | Other ON cols already align (POS sku + day) | User picks which Join key column to score/remap; existing single-column fuzzy + ApplyKeyMap |
| **Composite map** | From uniqueness needs the tuple (offer id + day) | User selects 2+ Join key columns as one From tuple → suggest/edit composite KeyMap → ApplyKeyMap with those columns |

No glued `" · "` strings as fake single From (cannot Apply).

### 5. Out of scope (v1)

- Multi-To (`from* → (to_a, to_b)`).
- Automatic choice of mode without user confirmation when both are plausible (default UI: ask).
- Changing Join ON silently.

## Consequences

- Soft migration for project JSON, seeds, ApplyKeyMap snapshots.
- OpenSpec: [`openspec/changes/keymap-composite/`](../../openspec/changes/keymap-composite/).
- Amends [ADR-0020](0020-join-key-mapping.md) arity; write-back uniqueness for source maps becomes From-tuple ([ADR-0022](0022-keymap-postgres-live-bind.md) note).
- Demo: recycled ext offer id + day → offer_sk under `scripts/examples/`.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0019](0019-join-lens-ai-narrator.md)
