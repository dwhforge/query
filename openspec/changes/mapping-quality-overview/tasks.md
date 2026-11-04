# Tasks

- [x] Add deterministic Rust lab generator and workspace projections.
- [x] Add Help entry and separate overview tab with DuckDB preset.
- [x] Implement matrix dimensions, normalization, concentration and sample drill-down.
- [x] Add completeness/inspection tests and generator/workspace tests.
- [x] Verify actual DuckDB aggregates, frontend build and browser interactions.
- [x] Merge capability contract into openspec/specs and document limits.

Validation: all TS assertions and production build passed; generator and workspace
module tests passed against the real pipeline crate in an isolated check harness;
its emitted SQL ran in DuckDB 2.0.0 over the complete 100K fixture and all expected
counts were asserted. Browser interactions used those computed aggregates.
`cargo check -p dwh-host --tests` was blocked by libduckdb-sys download
(Connection refused), so native host acceptance is supplied but not claimed run.
