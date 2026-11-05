# ADR-0037 — KeyMap multi-output (one row, several values)

## Status

**Accepted** (2026-11-05). **Amended** (2026-11-05) — execution-path uniqueness, no silent discard of dirty source edits, full creation-plan validation, named Lens patches, migration cases, required non-NULL outputs.

OpenSpec before implementation: `openspec/changes/keymap-multi-output/`.

Extends the v1 deferral in [ADR-0024](0024-keymap-composite.md) §5 and the out-of-scope line in [ADR-0028](0028-keymap-stewardship-shapes.md). Does not rewrite those ADRs. Does not lift [ADR-0036](0036-query-backed-keymap.md) bans on query-backed attrs and range SCD.

## Context

[ADR-0024](0024-keymap-composite.md) made From a tuple and left To as one column (`to` / `to_column` / `ApplyKeyMap.output_column`). That covers `external_sku → product_id` and then a Join to the dimension. It does not cover a correspondence whose useful result is itself a composite, for example `external_sku → (product_id, variant_code)`, or `supplier_id + sku → (product_id, variant_code)`.

Putting those extra values in `editable_columns` / `attrs`, or in MappingCheck `left_attrs[]` / `right_attrs[]`, would blur four different jobs. [ADR-0035](0035-mapping-check-attrs-ux.md) attrs are overview axes. [ADR-0034](0034-keymap-authoring-context.md) records how a map was created. Neither is the Apply result.

The simple path stays valid: one canonical id, then Join to the dimension. Multi-output is for when that id does not identify the target row or version by itself.

## Decision

### 1. Cardinality

One From tuple matches at most one map row in the scope that Apply uses.

- **Static map:** a duplicate From tuple is an error.
- **Range SCD:** overlapping intervals for the same From tuple are an error. The same From tuple in non-overlapping periods is valid. At one event time, at most one row matches.

Apply does not multiply input rows. The product does not pick the first row and does not assemble one result from several rows or from independent fallback lookups.

A later Join that uses the new columns may filter or multiply rows. That is Join cardinality, not Apply cardinality.

**Who enforces the match.** Editor checks and exported YAML tests are not enough. Source and ref data can change outside the app. Before Apply returns a row-preserving result, the execution path establishes uniqueness of the matching relation for the applicable key/time scope: the From tuples present on the input being applied, and for range SCD the half-open predicate. This is not a hash of the whole warehouse on every preview.

The same rule covers preview, local execution, exported `dbt build`, and a direct run of the exported model SQL outside a full build. If uniqueness cannot be established, that execution fails or is explicitly reported as unvalidated. An unvalidated result is not a successful Apply and must not be presented as row-preserving. Dropping duplicate map rows and continuing is not an acceptable guard.

YAML tests (`not_null`, `unique_combination_of_columns`, overlap checks) stay additional. Their presence does not make the model row-preserving when tests are skipped or when the compiled SQL is run on its own. The emitted SQL itself fails the statement when the applicable key is ambiguous, on both dialects. The concrete guard is an OpenSpec emit choice. It is not a second product policy.

A ref preview that cannot read the external model stays within the existing preview limitation and is reported unvalidated. It does not claim a row-preserving Apply.

### 2. Four separate notions

| Notion | Role |
|--------|------|
| From columns | Lookup key of the map row |
| Output columns | Values Apply returns from that row |
| `editable_columns` / entry attrs | Extra row data. Apply does not return them |
| `left_attrs[]` / `right_attrs[]` | MappingCheck labels and groups ([ADR-0035](0035-mapping-check-attrs-ux.md)) |

`authoring_context` stays creation intent ([ADR-0034](0034-keymap-authoring-context.md)), not Apply SoT. This change replaces the single `target_column` with ordered `target_columns: string[]` — the target-query fields chosen at create. That list is **not** a second copy of `output_columns`: physical output names on the map may differ when a target field would collide with From / stewardship / another output.

The session creation plan still carries each chosen target field and the physical output name it becomes. Commit validates every `target_columns` entry and every last-Fields patch against fresh schema evidence. If any selected target field was removed or excluded after review, creation is refused.

On load, a document that still has scalar `target_column` folds to `target_columns: [target_column]`. Writers emit `target_columns` only.

### 3. Canonical fields

Rust is the source of the shared contract. TypeScript for these shapes is generated ([ADR-0029](0029-typed-wire-contract.md)).

Project JSON (snake_case):

| Place | Field | Meaning |
|-------|--------|---------|
| `KeyMapDef` | `output_columns: string[]` | Ordered output names. Length ≥ 1 after normalize |
| `KeyMapEntry` | `output_values: string[]` | Aligned by index with the full `output_columns`, same rule as `from_parts` / `from_columns` |
| `ApplyKeyMap` | `output_bindings: { map_column, destination_column }[]` | Length ≥ 1. A subset of the map's `output_columns`. `map_column` names a map output. `destination_column` is the fact column written |

Input bindings stay `columns` (legacy `column` still folds into that list).

`output_values` keep today's textual mapping-value semantics. This ADR does not introduce typed numeric, date, or boolean outputs. Preview and dbt apply the same casts. Range bounds and the event-time column stay the temporal semantics of [ADR-0028](0028-keymap-stewardship-shapes.md). They are not output values.

Names of From columns, output columns, `valid_from`, `valid_to`, and `editable_columns` are unique on the map under ASCII case-fold. Destination columns on one Apply step are unique.

Order is column identity, not a silent shift. Reorder and rename are explicit edits: values move with the column name. Seed CSV round-trip matches on header name. Header order is `from_columns…, output_columns…, stewardship…` (range bounds, then editable columns). A legacy header cell `to` is the single output name.

Apply bindings are name-based, so reordering `output_columns` does not retarget an Apply step.

A Lens suggestion is not stored as a shortened `output_values` array. See §10.

### 4. `format_version` 3

[ADR-0030](0030-project-format-version.md) CURRENT is **3** with this change (`migrate_v2_to_v3` + fixtures).

`migrate_v2_to_v3` is a JSON transform before typed deserialize. It converts every serialized `KeyMapEntry`, including legacy `ApplyKeyMap.entries` snapshots, not only `workspace.key_maps[].entries`.

Scalar agreement, when both the legacy field and the new list are present:

| Legacy | Must equal |
|--------|------------|
| `to` | `output_values[0]` |
| `to_column` | `output_columns[0]` |
| `output_column` | the first binding's `destination_column` |
| the map's single output name, when this document has that map | the first binding's `map_column` |

Agreement keeps the new list and drops the legacy field. Disagreement refuses the file. The migration does not drop extra outputs and does not keep two copies.

Fold when the new list is absent:

| Object in this document | Result |
|-------------------------|--------|
| `KeyMapDef` with `to_column` | `output_columns: [to_column]` |
| `KeyMapDef` with no output name | `output_columns: ["to"]` only for a map object that exists in this document |
| `KeyMapEntry` with `to` | `output_values: [to]` |
| `ApplyKeyMap` whose `map_id` resolves to a `KeyMapDef` in this document | one binding. `map_column` is that map's single output name. `destination_column` is `output_column` when present, otherwise the first input column |
| `ApplyKeyMap` whose `map_id` is absent from this document | refuse. Do not invent `map_column` for a missing map or for an external project |
| `ApplyKeyMap` with no `output_column` and no input columns | refuse. Do not invent `destination_column` |
| Empty or malformed `output_columns`, `output_values`, or `output_bindings` after the fold | refuse |

An external `storage=ref` or `storage=source` map that is present in this document is the first row of the table: its `to_column` is in the document, so it is not guessed. A map id that is not in this document is the refuse row.

After migration the in-memory value has the new fields only. Writers omit `to`, `to_column`, and `output_column`.

An older app sees `format_version: 3` and refuses the file. That is the guard against silently saving a multi-output map back as a single `to`.

### 5. Miss policy and NULL

A ready map requires every declared output to be present and non-NULL. An incomplete value is allowed only in an editor draft. `KeyMapDef::validate`, project save, preview, local execution, and dbt export all refuse a ready map row whose output is NULL or `""`.

Blank means NULL or `""`. There is no implicit trim. A whitespace-only string is a stored value. The same rule applies to seed, source, query, and ref. It matches the query full-scan rule in [ADR-0036](0036-query-backed-keymap.md): no trim and no case-fold of values.

No per-binding policy enum. With that NULL rule, the existing emit means:

- No matching map row, and the destination column already exists: `COALESCE(map value, original)`.
- No matching map row, and the destination column is new: NULL.
- A matching row with a NULL or blank output: the execution fails. It does not fall back per field inside a found row.

The UI shows which miss rule a binding uses. Choosing an existing destination column is the explicit overwrite. Join/Apply reads input key columns from the pre-projection row, including when a destination column is also a From column.

### 6. Storages

| Storage | Behavior |
|---------|----------|
| Seed | Edit every output. Project round-trip. CSV import, export, and sync use the header in §3 |
| Source | Bind several existing columns. Read, dirty write-back, and concurrency follow §7. Picking a column does not create it in the database |
| Query | Outputs are columns of the map query. Read-only grid, Refresh, jump to the query. Apply joins the live relation (preview CTE / export `ref` of the exported model name). Dependency edges, cycle detection, and query revision stay as in [ADR-0036](0036-query-backed-keymap.md). Computed rows are not copied into `entries` or Apply snapshots |
| Ref | Exported Apply projects several model columns. The existing preview limitation stays (§1 unvalidated preview). This change does not run an external dbt model. The Lens does not offer a write into that model |

Query, ref, and source maps do not gain a seed copy. A displayed sample does not bound Apply or validation. Execution uniqueness follows §1 for every storage.

### 7. Source write-back

Row identity on write stays the From tuple. For range SCD it stays From tuple + `valid_from`. Outputs are not part of the key.

`KeyMapDirtyBaseline` gains `outputs`: a map of output column name → value frozen at the start of the local edit. On Save, inside the existing transaction and advisory lock, every participating output is compared to the current Postgres row, together with editable attrs. A difference in any of them refuses the Save.

A baseline with an empty `outputs` map still means legacy `to` is the sole output (single-output sessions).

Output-set changes do not discard unsaved row edits by themselves.

- **No dirty row edits.** Changing which existing source columns are outputs drops baselines, the dirty delta, and `expectedContentHash`, then re-reads under the new column list.
- **Dirty row edits exist.** The output-set change is refused, or it asks for an explicit discard. Cancel leaves the previous output settings, baselines, delta, and row edits unchanged.

Reorder of the same output names does not re-read, because baselines are name-keyed. `expectedContentHash` from a different column list is not reused. The content hash covers every output value.

Three edits stay distinct:

| Edit | Effect |
|------|--------|
| Rename a physical column on an editable seed | Values move with the column name (§3). This is not a warehouse re-read |
| Choose a different existing column on a source or query map | Binding change. The dirty-edit rule above applies to source row edits. A query map has no row write-back; the change revalidates against the query schema |
| Rename an Apply `destination_column` | Changes the fact column written. Does not drop source baselines, the dirty delta, or map row edits |

While Save is in flight, the output set and the output bindings of that map do not change. The baseline check and the `UPDATE` list stay on one column set.

Uniqueness in the database is not enforced by `ALTER TABLE`. Export still adds dbt tests: `not_null` on each From and output column; `unique_combination_of_columns` on the From columns for a static map. Range overlap stays an editor and export validation, as in [ADR-0028](0028-keymap-stewardship-shapes.md). Those tests do not replace the execution-path guard in §1.

### 8. Editor and create wizard

The editor shows an ordered output list: add, remove, reorder. Seed maps name columns and edit values. Query and source maps pick columns from the relation schema. Removing or renaming an output shows the Apply steps that bind that `map_column`.

An incomplete row (NULL or `""` in an output) stays in the editor session only. `KeyMapDef::validate` and project save refuse it. The project does not gain a second "draft map" state. A ready map follows §5.

The query-based create wizard may choose several target fields. Commit writes `authoring_context.target_columns` from the chosen target-query fields and `output_columns` from the physical names on the creation plan (§2). Stale acknowledgement still leaves the project unchanged. Freshness covers every entry of `target_columns` and every last-Fields patch.

### 9. Apply

One LEFT JOIN returns every selected output from the one matched row. Uniqueness of that match is §1. The shared emit path used by preview and dbt is the only SQL generator ([ADR-0015](0015-sources-vs-target-extensibility.md)). DuckDB overwrites with `EXCLUDE` of each overwritten destination. Postgres lists columns explicitly. Preview and `dbt build` match on the control fixtures, including a found row whose output is NULL or `""`: both fail.

The ready-map NULL rule in §5 applies to every declared output column, on every storage. An Apply that uses a subset does not narrow that check. The UI sample does not bound it.

### 10. Join Lens

Two actions stay separate:

- **Apply the map** — adds or updates `ApplyKeyMap` only.
- **Apply the map and change the Join** — one project fold. The Join change is reviewed. Stale context applies nothing.

Proposed Join equalities are the selected output bindings that the user also maps to right-side columns. Unselected map outputs are not added to the Join.

A stored map row uses `output_values` aligned to the full `output_columns` (§3).

A suggestion or patch is one From tuple plus named output cells taken from **one** target row: `{ column, value }[]`. A positional list such as `["BLUE-M", "C10"]` is not a patch against a longer `output_columns`. Many unmatched keys are many suggestions. Existing `toValues[]` remains the scalar-To list of those suggestions (one To per suggestion). It is not a multi-output row.

Merge writes each named value into the matching position of the canonical row. Columns the patch does not name are left unchanged, including values already stored. A patch value that differs from an already filled cell is a reported conflict. The merge does not overwrite that cell. Filling a query-backed map jumps to the map query instead of writing rows.

### 11. MappingCheck

[ADR-0035](0035-mapping-check-attrs-ux.md) grain and axes stay: grain is the Join keys; axes are the chosen side attributes; a composite key keeps every part, including a date part.

The Apply↔Join link, the revision fingerprint, Inspect, and the jump into the Lens include the output column list and each step's `output_bindings`. Inspect shows the whole output tuple of the matched row.

Coverage counts rows or keys in the accepted check scope. Two filled outputs are not two matches. These outcomes stay distinct: no map row; map row ambiguous; map row found and the target Join missed; the target Join multiplied rows.

### 12. Time

Two modes stay distinct:

- `(id, day) → outputs` — the date is part of the From tuple ([ADR-0024](0024-keymap-composite.md)).
- `id` + event time `→` outputs of the open period — range SCD ([ADR-0028](0028-keymap-stewardship-shapes.md)).

Single-output range SCD behaviour is unchanged. Multi-output range SCD on seed and source maps uses the same half-open predicate `[valid_from, valid_to)`. One event time selects one version. Every selected output comes from that version. Overlapping periods for one From tuple are refused (§1). The same From tuple in non-overlapping periods stays valid.

Query-backed range SCD stays forbidden ([ADR-0036](0036-query-backed-keymap.md)).

### 13. What this change includes

Existing scalar labs keep their meaning: crosswalk, dual maps, multi-hop, composite offer id + day, ref, and source.

Additional scenarios for the OpenSpec change:

- `external_sku → product_id + variant_code`.
- `supplier_id + sku → product_id + variant_code`.
- Query-backed multi-output through preview, Apply, and export.
- Source-backed edit, Save, and Reload.
- A range map with both outputs before a boundary, on it, and after it.

Negative scenarios:

- Dirty source row, then an output-set change, then Cancel: the row edits and the previous binding remain.
- A second selected target field disappears after review: creation does not apply, even if the first `target_columns` entry still exists.
- A Lens patch names the second and third outputs: the first stored output stays unchanged.
- A duplicate From appears in an external table after the editor was opened: Apply does not silently multiply rows (§1).
- A legacy Apply whose map is missing from the document: migration refuses, and does not invent `map_column`.
- A found map row has NULL or `""` in an output: preview and dbt fail the same way (§5).

The change is unfinished while only the query grid shows two output columns. Done means storage, Apply, Lens, MappingCheck, and export agree, including source write-back from §7 and the execution-path guard from §1.

A new dbt major is out of scope. Fuzzy SCD matching stays out of scope ([ADR-0019](0019-join-lens-ai-narrator.md)).

## Consequences

- Soft-migrate v2 projects on load. New saves write `format_version: 3` once CURRENT moves. Disagreement or a missing map on Apply refuses the file.
- `KeyMapDirtyBaseline.outputs` extends the source-map wire DTO in the same change. Single-output baselines with only `to` still load.
- Preview SQL and dbt SQL come from one emitter. That SQL is what makes Apply row-preserving when YAML tests do not run.
- OpenSpec `keymap-multi-output` must merge into `openspec/specs/` when the change is done.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0024](0024-keymap-composite.md), [ADR-0028](0028-keymap-stewardship-shapes.md), [ADR-0029](0029-typed-wire-contract.md), [ADR-0030](0030-project-format-version.md), [ADR-0034](0034-keymap-authoring-context.md), [ADR-0035](0035-mapping-check-attrs-ux.md), [ADR-0036](0036-query-backed-keymap.md)
