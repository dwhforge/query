# Spec Delta: mapping-data-plane

## ADDED Requirements

### Requirement: Source KeyMaps do not persist row bodies

When a KeyMap uses `storage.kind = source`, the project document SHALL store an empty `entries` array. Loading a legacy file that still contains source rows SHALL clear them before the typed project is returned.

#### Scenario: Legacy source rows stripped
- **GIVEN** a project JSON with a source KeyMap that includes `entries`
- **WHEN** loaded
- **THEN** that map’s `entries` is empty in memory
- **AND** a subsequent save does not reintroduce those rows
