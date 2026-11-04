# Design — mapping-data-plane (slice 1)

In `migrate_v0_to_v1` (or a dedicated post-step while version stays 1): walk `workspace.key_maps`, if storage is source object with non-empty entries → set entries to `[]`.

UI already strips on save via `mapForProjectAst`.
