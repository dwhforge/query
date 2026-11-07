# Spec: keymap-multi-output-apply

ADR: [0037](../../../docs/adr/0037-keymap-multi-output.md).
Design: [`design.md`](../../design.md) (emit uniqueness/overlap guard — decided, not open).

## Requirements

### Requirement: One lookup, several destinations
ApplyKeyMap SHALL perform one LEFT JOIN to the map relation and write each selected `output_binding` from the single matched row. Destination columns on one step SHALL be unique. Input key columns SHALL be read from the pre-projection row even when a destination overwrites a From column. Reordering `output_columns` SHALL NOT retarget bindings (name-based). Apply SHALL preserve input row cardinality, including unmatched rows (LEFT JOIN miss keeps the fact row).

#### Scenario: Subset of outputs
- **GIVEN** a map with outputs `product_id`, `variant_code`, `category_id`
- **WHEN** Apply binds only `product_id` and `variant_code`
- **THEN** those two destinations are written from the matched row
- **AND** `category_id` is not required as a destination
- **AND** a NULL/blank `category_id` on the map row still invalidates the ready map

#### Scenario: Unmatched rows retained
- **GIVEN** a fact row whose From tuple has no map match
- **WHEN** Apply runs
- **THEN** the fact row remains in the result
- **AND** existing destinations follow COALESCE; new destinations are NULL

### Requirement: Miss policy without per-binding enum
When no map row matches: an existing destination SHALL use `COALESCE(map value, original)`; a new destination SHALL be NULL. When a row matches with NULL or blank in a declared output, execution SHALL fail. The UI SHALL show which miss rule each binding uses. Choosing an existing destination column is the explicit overwrite.

#### Scenario: Found row with NULL output fails equally
- **GIVEN** a matching map row whose selected output is NULL
- **WHEN** preview Apply runs
- **THEN** the execution fails
- **AND** the same fixture fails under dbt build / exported SQL

### Requirement: Execution-path uniqueness and overlap guard
Before a successful row-preserving Apply result, the **emitted Apply SQL** (shared preview + dbt path) SHALL detect ambiguous matches for the applicable key/time scope and abort the statement. Static maps: more than one map row for a From tuple in that scope. Range SCD: more than one map row satisfying From + half-open predicate for that event time (overlapping applicable intervals). First-row selection, `DISTINCT`/`GROUP BY` collapse, and silent deduplication are forbidden.

Guard surfaces (all required):

| Path | Behavior |
|------|----------|
| In-app preview / local execution | Same shared emitter; abort fails the preview |
| Exported model under `dbt build` | Guard expressions are inside the model SQL |
| Direct run of compiled/exported model SQL without running dbt data tests first | Same abort; tests are not required for safety |
| Relation identity | Guard counts matches on the **same** map relation the LEFT JOIN uses (seed VALUES / query CTE / `ref` / `source` ATTACH). No separate pre-checked snapshot that can diverge |

Standalone YAML uniqueness / not_null / overlap tests are **additional**. Exporting those tests alone does **not** satisfy this requirement. Concrete abort expressions are fixed in `design.md` (DuckDB `error(...)`, Postgres statement-failing expression).

If a ref map cannot be read for preview, the result SHALL be reported unvalidated and SHALL NOT claim a successful Apply.

#### Scenario: Preview aborts on ambiguous From
- **WHEN** the map relation used by preview Apply has two rows for one From tuple in scope
- **THEN** preview fails
- **AND** no partial remapped result is shown as success

#### Scenario: Exported SQL aborts without dbt tests
- **GIVEN** an exported Apply model whose map relation has become ambiguous
- **WHEN** that model SQL is executed without running schema/data tests first
- **THEN** the statement fails via the embedded guard
- **AND** success is not claimed because YAML tests exist in the project

#### Scenario: Guard uses the joined relation
- **WHEN** Apply joins `ref('map_query_model')` (or seed / source / VALUES)
- **THEN** the uniqueness/overlap count is computed over that same relation expression
- **AND** not over a separately materialized copy that can drift

#### Scenario: External duplicate after editor open
- **GIVEN** a source or ref map that was unique when the editor opened
- **AND** a second row with the same From later appears in the warehouse
- **WHEN** Apply runs
- **THEN** execution fails (or is unvalidated for an unreadable ref)
- **AND** input row count is not silently multiplied or reduced

#### Scenario: Join may multiply after Apply
- **GIVEN** Apply wrote `mapped_product_id` and `mapped_variant_code` without changing fact cardinality
- **WHEN** a subsequent Join uses those columns and the right side is not unique
- **THEN** Join cardinality may change
- **AND** that change is not attributed to Apply
