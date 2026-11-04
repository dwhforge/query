# Design — query-based mapping create (v0.3.1)

## Approach

- **IR:** optional `KeyMapDef.authoring_context` (Rust SoT, TS mirror). No `format_version` bump ([ADR-0034](../../../docs/adr/0034-keymap-authoring-context.md)).
- **Helpers:** `src/app/mappingCreate/` — pure `buildMappingCreatePlan` / `validateMappingCreatePlan` / `applyMappingCreateOntoProject` with `applied|stale|error` + `opId` (same acknowledgement pattern as Confirm).
- **Fields:** last-step `SelectColumns` only; `directQueryConsumers` for warnings (graph deps, not Apply consumers).
- **UI:** `MappingCreateWizard` → App reducer `create_mapping` → existing `openKeyMapEditor`. Seed storage only; no post-commit undo.

## Non-goals

Prepared copies, lineage tour, suggest/reconcile, Lens/Check wiring, DDL, Phases 4–6.
