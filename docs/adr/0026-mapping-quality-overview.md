# ADR-0026 — Mapping quality overview prototype

## Status

Accepted — prototype implemented (2026-11-03); contract merged to `openspec/specs/mapping-quality-overview/`.

## Context

Join Lens already supports local investigation and individual mapping decisions.
A second list/card editor with drag-and-drop does not provide a distinct product
capability. The missing task is understanding the structure and evidence of the
whole mapping, including fully resolved but questionable regions.

## Decision

Introduce an isolated Help lab and overview tab. Preserve Join Lens unchanged.
The lab generates 100000 commercial positions, 2400 catalog products and 95000
seed links locally without Python, network access or a database service.

The overview uses full-input DuckDB SQL aggregates for family/grade correspondence,
declared decision basis and target concentration. Only aggregate rows, top targets
and bounded exact-key samples reach the UI. A window total verifies that the
preview has not silently truncated the aggregate. No global quality score is
invented. Attribute differences and concentration are observations, not errors.

Inspecting a region creates a normal query filtered to at most 24 actual sample
keys and opens its real Join in the existing Lens. This is explicitly a sample,
not the full selected cohort. The original Join is never changed.

This is a configured prototype for its lab schema, not automatic arbitrary-map
profiling, a second editing store, a new matcher, or new mapping cardinalities.
Decision methods/scores are fixture annotations, not live matcher/LLM output.
The rejected visual-card editor patch is not a prerequisite and is not included.

## Consequences

- Offline sample is available in Help → Mapping labs.
- Generated CSV files stay in the application demo cache; incomplete caches fail
  explicitly instead of being silently overwritten.
- Existing seed semantics remain. The prototype does not solve general seed-scale
  transport: current workspace snapshots and seed SQL still contain mapping rows.
- Overview queries are DuckDB SQL models; demo execution is explicitly DuckDB.
- The lab pack is an ordinary generated project. Graph Data preview follows the
  general heavy-sample policy ([ADR-0041](0041-heavy-preview-sample.md)); it does
  not special-case lab query ids.
- OpenSpec: `openspec/changes/mapping-quality-overview/` (merged to
  `openspec/specs/mapping-quality-overview/`).
- Closed stewardship loop (saved check, cohort predicate, attributed recompute) is
  **not** in this ADR — see Proposed [ADR-0027](0027-mapping-quality-checks.md).
