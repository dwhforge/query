# KeyMap multi-output

## Why

Composite From ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)) still returns one To. Real correspondences often need several values from the same map row, for example `external_sku → (product_id, variant_code)`. Putting those values in attrs or MappingCheck axes would mix four different jobs.

## In scope

- Canonical `output_columns` / `output_values` / `output_bindings` ([ADR-0037](../../../docs/adr/0037-keymap-multi-output.md))
- `format_version` 3 + `migrate_v2_to_v3` (named rules for missing maps / Apply snapshots)
- Seed, source, query, and ref adapters; source dirty baselines cover every output
- One Apply LEFT JOIN; execution-path uniqueness guard; ready-map NULL rule
- Uniqueness/overlap protection covers preview and exported execution; standalone data tests are not the sole execution guard
- Editor, query-based create wizard, Join Lens named patches, MappingCheck link
- Multi-output range SCD on seed/source only; Help demos + acceptance scenarios

## Out of scope

- Rewriting ADR-0036 (query-backed attrs / range SCD stay forbidden)
- Treating `authoring_context.target_columns` as Apply/`output_columns` SoT (it is create intent only)
- Per-binding miss policy enum
- Typed numeric/date/boolean outputs
- Fuzzy SCD matching; new dbt major
- Silent fuzzy Join ON ([ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md))
- Running external dbt models for ref maps

## Capabilities

1. **keymap-multi-output-ir** — fields, migration, validation, NULL rule
2. **keymap-multi-output-apply** — emit, miss policy, uniqueness/overlap guard (preview + exported SQL)
3. **keymap-multi-output-adapters** — seed / source / query / ref + write-back
4. **keymap-multi-output-ui** — editor, create wizard, Lens
5. **keymap-multi-output-checks** — MappingCheck / overview

## Success

- Legacy single-To projects load via v2→v3 and round-trip as one output.
- Existing scalar, composite-From, exact-date-key `(id, day)`, and single-output range-SCD workflows retain their semantics (exact From date ≠ `id` + event_time period selection).
- Multi-output Apply preserves input row cardinality, including unmatched rows. Ambiguous keys or overlapping applicable intervals fail execution; no first-row selection or silent deduplication.
- Create persists `authoring_context.target_columns` and validates every entry against fresh schema evidence. Lens partial fills are name-addressed and preserve outputs not included in the patch.
- Source Save compares all outputs; dirty edits are not discarded by an accidental binding change.
- MappingCheck / export agree with Apply; query preview alone is not “done”.

## ADR

[ADR-0037](../../../docs/adr/0037-keymap-multi-output.md)
