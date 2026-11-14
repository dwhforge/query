# Spec: keymap-composite-auto

Current primary-UI policy: [ADR-0050](../../../docs/adr/0050-unified-batch-tuple-matching.md)
and [batch contract](../unified-batch-tuple-matching/spec.md). Historical mode
delivery remains recorded in the original change documents.

## Requirements

### Requirement: Multi-key Join uses full-tuple Find Matches

The primary Join Lens batch UI SHALL offer **Find Matches** for every positive
Join arity. It SHALL use every ordered Join pair without requiring per-column or
composite-map mode selection or a designated fuzzy slot. Missing tuple results
SHALL fail explicitly, not fall back to scalar writes. The existing legacy Rust
scalar/composite commands SHALL remain compatible; manual Mapping workflows are
not removed. Single-source Suggest Right retains its separate
[full-tuple contract](../unified-suggest-right/spec.md).

#### Scenario: Full-tuple batch instead of per-column selection
- **GIVEN** Join ON `[sku_code, day]` / `[item_code, day]`
- **WHEN** the user opens Find Matches
- **THEN** candidates and decisions include both ordered fields, without a slot picker
- **AND** an accepted complete target writes both aligned outputs through Apply

#### Scenario: Scalar and larger arities share one flow
- **GIVEN** a Join with one or several ordered pairs
- **WHEN** the user reviews a batch
- **THEN** the same explicit complete-target selection and Mapping/Apply flow applies
- **AND** legacy Rust scalar/composite callers retain their existing behavior

### Requirement: No glued separator From

The system MUST NOT invent KeyMap From values by joining columns with a display separator (e.g. ` · `) as a substitute for composite From.

#### Scenario: Reject glue strategy
- **GIVEN** a multi-key Join
- **WHEN** suggestions are produced by Find Matches
- **THEN** accepted entries use `from_parts` arrays, not a single glued string
