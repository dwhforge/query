# Design — keymap-stewardship-shapes

## Locked policies (Accepted ADR-0028)

- Range SCD predicate: `event_time >= valid_from AND (valid_to IS NULL OR event_time < valid_to)`.
- Point-in-time = composite From ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)); no separate Apply path.
- Attrs never enter Join ON.

## Slice A (attrs)

Reuse `editable_columns` + `KeyMapEntry.attrs`. Seed CSV header = `from_columns…, to_column, editable_columns…`. Sync/push parse and write attrs. Editor: add/remove attr columns for seed/ref/source.

## Slice B (range SCD)

- IR: `time_mode: none | range_scd`; `valid_from_column` / `valid_to_column` (defaults `valid_from` / `valid_to`).
- Values stored in `entry.attrs` under those column names (same as seed columns).
- ApplyKeyMap: `as_of_column` required when map is `range_scd`.
- Validate: per From tuple, ranges must not overlap; `valid_from` required; empty `valid_to` = open.
- Emit: equality on From **and** half-open time predicate.
