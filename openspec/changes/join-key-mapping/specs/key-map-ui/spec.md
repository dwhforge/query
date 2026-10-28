# Spec Delta: key-map-ui

## Purpose

One From→To KeyMap editor with multiple entry points and explicit Apply on Left / Right / Both.

## ADDED Requirements

### Requirement: From→To editor

The system SHALL provide a KeyMap editor with From|To rows, add/delete, search/filter, paste TSV/CSV `from,to`, and block save on duplicate `from` or empty `to`.

#### Scenario: Paste two rows
- **WHEN** the user pastes `a\tA\nb\tB` into the editor and saves
- **THEN** the KeyMap contains two entries with those from/to values

### Requirement: Entry points reach the same editor

The following SHALL open or feed the same KeyMap editor: Join Lens Probe unmatched → Map to…; Linked / blame `no_partner` → Add to map; diagnostics unmatched samples → Map selected; History ApplyKeyMap step; Explorer/project KeyMaps list.

#### Scenario: Probe map to
- **GIVEN** Probe mode with an unmatched left key selected
- **WHEN** the user chooses Map to… and picks a partner To value
- **THEN** an entry is added (or the editor opens with From prefilled)

### Requirement: Apply L/R/Both

Apply SHALL insert or update `ApplyKeyMap` on the owning query for Left, Right, or Both (shared `map_id`), without duplicating identical steps.

#### Scenario: Re-apply same map
- **GIVEN** an ApplyKeyMap already on the left for `(column, map_id)`
- **WHEN** the user Applies the same map again with updated entries
- **THEN** the existing step’s entries are updated (no second ApplyKeyMap for that triple)
