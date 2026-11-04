# Spec Delta: ui-host-decomposition

## ADDED Requirements

### Requirement: Checks scenario lives in an application service

Creating a MappingCheck, recording a CheckRun, allow-decisions, cohort inspect planning, and frozen-remap confirm SHALL be implemented in a dedicated application module. `App.tsx` SHALL apply service results without re-implementing IR rules.

#### Scenario: CheckRun record
- **GIVEN** overview cells and an active MappingCheck
- **WHEN** the user recalculates
- **THEN** the service returns the CheckRun, updated check/run lists, and delta note text
- **AND** App persists those onto the project document

### Requirement: KeyMap editing use-cases live in an application service

Applying a KeyMap onto a Join, normalizing editor open/merge, AST form for source maps (empty entries), and Save outcome classification SHALL be implemented in `src/app/keyMap/`. Host `read_key_map` / `write_key_map` SHALL dispatch through `commands/keymap.rs`.

#### Scenario: Source map AST
- **GIVEN** a KeyMap with `storage.kind = source` and non-empty session entries
- **WHEN** persisted into the project document via the application service
- **THEN** the stored map has an empty `entries` array
