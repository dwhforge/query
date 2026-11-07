# Proposal: heavy-preview-sample

## Why

Empty Data for large seed Apply focuses breaks the Power Query “always show a sample” loop. Hard-coding Mapping-quality lab query ids as always-heavy treats a generated demo as a special runtime mode.

## In scope

- Heaviness = needed seed map with ≥ 5000 entries only (no lab id list)
- Auto-preview runs sample (`LIMIT 50`) for every focus, including heavy
- Explicit **Load full** for heavy focuses (no output row LIMIT)
- Sample / full labeling in Data chrome; session cache by fingerprint
- ADR-0041; Help lab remains an ordinary generated project for preview policy

## Out of scope

- Changing Apply / validation semantics or seed transport format
- Reworking Mapping quality overview aggregates
- Permanent map truncation for sample correctness shortcuts
