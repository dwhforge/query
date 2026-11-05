# ADR-0034 — KeyMap authoring context (query-based create)

## Status

**Accepted** (2026-11-04). Implementation brief: Query-based mapping creation v0.3.1.

## Context

Creating a KeyMap from two local workspace queries needs a durable, typed record of *intent* (which queries/columns the user chose). That is not Join ownership, not MappingCheck projection, and not ApplyKeyMap consumers (those stay computed from the graph).

## Decision

1. Optional `authoring_context` on `KeyMapDef`:
   - `source_query_id`, ordered `source_columns[]`, `target_query_id`, `target_column`
   - Multi-target create: `target_columns[]` replaces `target_column` ([ADR-0037](0037-keymap-multi-output.md)).
2. Absent on legacy maps — still valid.
3. **No `format_version` bump** for this additive optional field (`skip_serializing_if = None`). Consequence (accepted): older app builds that re-save a project may drop the field; load of newer files by older builds ignores unknown keys via serde defaults.
4. Context does not limit map reuse. Real Apply consumers remain graph-derived.
5. Query-based create commits map (+ optional last-Fields patches) via a pure project fold with `applied|stale` acknowledgement — not warehouse Save.

## Consequences

- Rust remains SoT; `KeyMapAuthoringContext` is exported via ts-rs into `src/types/generated/` and re-exported from `pipeline.ts` (do not hand-copy the shape).
- Wizard is session-only until commit; Cancel leaves Project unchanged.
- Post-commit undo is out of scope for the first slice.

## References

- [ADR-0020](0020-join-key-mapping.md), [ADR-0030](0030-project-format-version.md), [ADR-0032](0032-ui-host-decomposition.md)
