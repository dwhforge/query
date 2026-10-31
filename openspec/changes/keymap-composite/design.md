# Design: Composite KeyMap

## IR

```text
KeyMapDef {
  from_columns: [String; N≥1]   // soft: from_column → [from_column]
  to_column: String
  entries: [{ from_parts: [String; N], to, attrs }]  // soft: from → [from]
}

ApplyKeyMap {
  columns: [String; N]          // soft: column → [column]
  output_column?: String        // default columns[0]
  map_id, entries snapshot
}
```

Helpers on load: normalize legacy fields into vectors; validate `from_parts.len() == from_columns.len()`.

## Emit (preview + dbt)

```sql
LEFT JOIN map m
  ON CAST(t.c1 AS VARCHAR) = CAST(m.f1 AS VARCHAR)
 AND CAST(t.c2 AS VARCHAR) = CAST(m.f2 AS VARCHAR)
-- SELECT … COALESCE(m.to, t.out) AS out
```

VALUES path for seed cache: `VALUES (f1,f2,to), … AS m(f1,f2,to_val)`.

## Seed CSV

- N=1: `from,to` (unchanged)
- N>1: header = from_columns names + to_column, e.g. `ext_offer_id,as_of_day,offer_sk`

## Source write-back

Upsert / delete key = equality on all From columns (tuple), not From alone.

## Auto / Suggest

On `left_on.len() > 1`:

1. Dialog: **Per-column** (pick index i → fuzzy on left_on[i]/right_on[i]) | **Composite map** (pick subset size≥2 of join keys, ordered).
2. Per-column Accept → arity-1 KeyMap + ApplyKeyMap on that column.
3. Composite Accept → arity-N KeyMap; proposals keyed by tuple (exact day match + fuzzy on id part, or joint scoring — start with exact match on non-fuzzy cols + fuzzy on primary id col).

## Migration

Read path always expands legacy. Write path: arity 1 may keep `from`/`column` for smaller diffs; arity N writes vectors only.
