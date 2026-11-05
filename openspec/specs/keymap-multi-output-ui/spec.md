# Spec: keymap-multi-output-ui

ADR: [0037](../../../docs/adr/0037-keymap-multi-output.md).

## Requirements

### Requirement: Output list in the editor
The KeyMap editor SHALL present an ordered output list: add, remove, reorder. Seed maps name columns and edit values. Query and source maps pick columns from the available schema. Removing or renaming an output SHALL show Apply steps that bind that `map_column`. Reorder and rename SHALL move values with the column name; the UI SHALL NOT silently reassign values by position.

#### Scenario: Rename seed output moves values
- **WHEN** the user renames seed output `product_id` to `sku_id`
- **THEN** existing cell values remain under `sku_id`
- **AND** Apply bindings still targeting `product_id` are shown as needing update

### Requirement: Query-based create with several targets
The create-from-queries wizard SHALL allow several target fields. `authoring_context` SHALL persist ordered `target_columns` (chosen target-query fields), replacing scalar `target_column` (load MAY fold `target_column` → one-element list). That list is create intent, not Apply SoT and not a duplicate of `output_columns`. The session plan SHALL carry each selected target field and its physical output name. Commit SHALL validate every `target_columns` entry and every last-Fields patch against fresh schema evidence. If a selected target disappears after review, creation SHALL be stale/refused. When a target field name collides with From or stewardship names, the plan SHALL assign a non-colliding physical name before commit.

#### Scenario: Second target removed after review
- **GIVEN** selected `target_columns` `product_id` and `variant_code`
- **WHEN** `variant_code` is removed or excluded before commit
- **THEN** creation does not apply
- **AND** the project document is unchanged

#### Scenario: Collision renames physical output
- **GIVEN** a target field whose name equals a From column
- **WHEN** create commits
- **THEN** `authoring_context.target_columns` still records the target field name
- **AND** `output_columns` uses a different non-colliding physical name

### Requirement: Join Lens multi-output
Lens SHALL separate **Apply the map** from **Apply the map and change the Join**. Join changes require review; stale context applies nothing. Proposed Join equalities SHALL use only the output bindings the user also maps to right-side columns. A suggestion/patch SHALL be `{ from_parts, cells: [{ column, value }] }` from one target row. Existing `toValues[]` remains one scalar To per suggestion and SHALL NOT mean multi-output. Merge SHALL write named cells into canonical `output_values` positions; unnamed columns stay unchanged; a conflicting filled cell SHALL be reported without silent overwrite. Query-backed fill jumps to the map query; ref fill does not write the model.

#### Scenario: Partial Lens patch leaves first output
- **GIVEN** a map row with `product_id` already filled
- **WHEN** a Lens patch names only `variant_code` and `category_id`
- **THEN** `product_id` remains unchanged
- **AND** a conflicting `variant_code` is not overwritten silently
