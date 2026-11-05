# Design — KeyMap multi-output

ADR: [0037](../../../docs/adr/0037-keymap-multi-output.md). Product decisions stay there. This file records emit and wire choices for implementers.

## IR

```text
KeyMapDef.output_columns: [String; M≥1]
KeyMapEntry.output_values: [String; M]     // index-aligned with output_columns
ApplyKeyMap.output_bindings: [{
  map_column: String,                       // ∈ output_columns
  destination_column: String
}; K≥1]                                     // unique destinations; subset of outputs OK

KeyMapDirtyBaseline.outputs: Map<String, String>  // name → frozen value
```

Writers omit `to`, `to_column`, `output_column`. Readers fold them only inside `migrate_v2_to_v3`.

`authoring_context.target_columns: string[]` — ordered target-query fields from create (replaces scalar `target_column`; load folds `target_column` → `[target_column]`). Not a copy of `output_columns`. The session create plan holds `selected_outputs: [{ target_field, physical_name }]`.

Lens / editor patch (session, not project JSON):

```text
{ from_parts: [String], cells: [{ column: String, value: String }] }
```

Merge resolves `cells` into `output_values` by name. Positional short arrays are not patches.

## format_version

`PROJECT_FORMAT_VERSION = 3` in the same patch as `migrate_v2_to_v3` + fixture under `crates/dwh-pipeline/tests/fixtures/projects/`.

Refuse when: dual scalar/list disagree; Apply `map_id` missing from this document; Apply has no destination after fold; empty/malformed lists after fold.

## Emit (preview + dbt — one path)

```sql
LEFT JOIN map_relation m
  ON /* all From equalities */
 AND /* optional SCD half-open predicate */
-- SELECT destinations from m.<map_column>
-- existing dest: COALESCE(m.out, t.dest)
-- new dest: CAST(m.out AS VARCHAR)
```

DuckDB: `EXCLUDE` each overwritten destination. Postgres: list prior columns explicitly.

### Uniqueness + ready NULL guard (both dialects) — decided

This is the export/preview execution guard. It is **not** an open decision and is **not** satisfied by emitting YAML tests alone.

Same shared emitter for preview, local run, `dbt build`, and compiled model SQL run without tests. The count/`_match_n` expression SHALL reference the **same** map relation expression as the LEFT JOIN (no separate pre-validated snapshot).

Do **not** `GROUP BY` / `DISTINCT ON` to hide duplicates. Wrap the map relation:

```text
map_checked AS (
  SELECT
    m.*,
    COUNT(*) OVER (PARTITION BY from_cols… [, as_of bucket for SCD]) AS _match_n
  FROM map_relation m
)
```

For static maps the partition is the From columns. For range SCD the partition is From columns plus the version that matches the Apply `as_of` predicate — implement as: join fact to all map rows satisfying From + half-open range, then `_match_n` over `(fact_row_id, from_tuple)`.

Projection:

- `_match_n IS NULL` → miss (COALESCE / NULL per §5)
- `_match_n = 1` → use outputs; if any selected output is NULL or `''`, abort
- `_match_n > 1` → abort

Abort mechanism (same semantics both dialects):

| Dialect | Abort |
|---------|--------|
| DuckDB | `error('KeyMap <id>: ambiguous From …')` / `error('… NULL output …')` in the SELECT list when the bad row is projected |
| Postgres | `CASE WHEN <bad> THEN 1 / (SELECT 0 WHERE <bad>) END` (or equivalent statement-failing expression) with the same message in a preceding comment / host mapping |

YAML tests remain additional. They are not the uniqueness gate. Unmatched fact rows stay (LEFT JOIN); only ambiguity / NULL-on-match aborts.

Ref preview that cannot materialize the external model: surface **unvalidated**; do not show a successful Apply preview.

## Source write-back

Extend `entry_to_matches` / baseline verify to every key in `baseline.outputs` (fallback: legacy `to` when `outputs` empty). Content hash includes all output values.

UI: output-set change with dirty delta → confirm discard or refuse. Cancel restores previous binding + delta.

## Create wizard

`buildMappingCreatePlan` / `validateMappingCreatePlan` take the full selected output list. Stale if any `target_columns` entry or Fields patch fails fresh schema. Physical names assigned before commit when target field collides with From / stewardship / other outputs. Persist `authoring_context.target_columns` = chosen target-query field names; `output_columns` = physical names (may differ on collision).

## MappingCheck

Fingerprint includes `output_columns` + each consumer's `output_bindings`. Inspect shows full output tuple. Coverage stays per key/row in check scope.
