# ADR-0030 — Project `format_version` and migrations

## Status

**Accepted** (2026-11-03). OpenSpec: [`openspec/changes/project-format-version/`](../../openspec/changes/project-format-version/).

## Context

`Project::from_json` already soft-migrates some legacy fields (`target_dialect` → engine/destination), but there is no declared document version. Future IR changes (typed MappingCheck, mapping data plane) need an explicit contract: read old files, refuse files newer than this app, and keep a backup before on-disk conversion.

This is **independent** of IPC / host protocol version ([ADR-0029](0029-typed-wire-contract.md)). It does **not** introduce immutable workspace revisions or a Parquet mapping store.

## Decision

1. Every saved project document includes `format_version: u32`.
2. **Current** version is `3` ([ADR-0037](0037-keymap-multi-output.md) multi-output KeyMap). Missing field means **0** (pre-versioned legacy). Versions `1`–`2` remain readable via ordered migrations.
3. Load path: if `format_version > CURRENT` → refuse with a clear error. If `< CURRENT` → run ordered migrations in memory, then set `format_version = CURRENT`.
4. Save path: if replacing an on-disk file whose version is older (or missing), write `<path>.bak` (overwrite previous `.bak`) **before** writing the new document.
5. Migrations are pure JSON transforms before typed deserialize; Rust remains the validator.
6. Round-trip fixtures under `crates/dwh-pipeline/tests/fixtures/projects/` (or equivalent) cover v0 → v1.

## Consequences

- New projects always write `format_version: 3` (multi-output KeyMap).
- UI surfaces "unsupported newer project" vs "migrated from legacy".
- `migrate_v1_to_v2` is a stamp-only gate ([ADR-0036](0036-query-backed-keymap.md)).
- `migrate_v2_to_v3` folds scalar To into `output_columns` / `output_values` / `output_bindings` ([ADR-0037](0037-keymap-multi-output.md)).

## References

- [ADR-0013](0013-project-persistence.md), [ADR-0029](0029-typed-wire-contract.md)
