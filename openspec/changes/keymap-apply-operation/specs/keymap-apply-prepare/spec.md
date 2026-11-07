## ADDED Requirements

### Requirement: Compile does not validate map data
`compile_focus_sql` and `compile_ctes_from` SHALL generate SQL without executing full-set query-map scans. Full-set validation SHALL run via an explicit validate step before preview/execute of paths that Apply query-backed maps.

#### Scenario: Describe without full-set scan
- **WHEN** the product describes columns for a picker
- **THEN** it MAY prepare schemas without running query-map full-set validation

#### Scenario: Preview runs validate
- **WHEN** preview executes a focus query that Applies a query-backed map
- **THEN** full-set validation runs once after prepare and before SQL execution
