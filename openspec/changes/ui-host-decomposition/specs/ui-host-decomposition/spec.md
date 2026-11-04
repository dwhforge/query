# Spec Delta: ui-host-decomposition

## ADDED Requirements

### Requirement: Checks scenario lives in an application service

Creating a MappingCheck, recording a CheckRun, allow-decisions, cohort inspect planning, and frozen-remap confirm SHALL be implemented in a dedicated application module. `App.tsx` SHALL apply service results without re-implementing IR rules.

#### Scenario: CheckRun record
- **GIVEN** overview cells and an active MappingCheck
- **WHEN** the user recalculates
- **THEN** the service returns the CheckRun, updated check/run lists, and delta note text
- **AND** App persists those onto the project document
