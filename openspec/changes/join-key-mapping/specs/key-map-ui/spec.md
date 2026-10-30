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

### Requirement: Dictionary fuzzy reuses the KeyMap workflow

The editor SHALL accept two query/key/optional-label selections and configurable score/ambiguity thresholds. Suggestions SHALL contain original From/To keys, be read-only until accepted, and use the shared matching core. Product defaults SHALL NOT refer to stress fixture queries or columns.

#### Scenario: Different system codes, matching names
- **GIVEN** two dictionary queries whose codes differ but names are similar
- **WHEN** the user requests and accepts unambiguous suggestions
- **THEN** proposals contain the original codes and update only the KeyMap draft
- **AND** filled mappings remain unchanged and persistence uses the existing Save action

#### Scenario: Source or options change during a request
- **WHEN** query selections, matching options, workspace or connections change
- **THEN** a response for the previous inputs cannot be accepted

### Requirement: Full dictionary limits are explicit

The host SHALL reject duplicate/untrimmed/blank keys, NULL/empty labels, fields longer than 512 characters, invalid thresholds and inputs exceeding 250000 rows per side. Bounded candidate search SHALL be disclosed; lack of a proposal SHALL NOT be described as proof that no match exists.

#### Scenario: Input exceeds the limit
- **WHEN** a dictionary has 250001 rows
- **THEN** the request fails without accepting or returning a truncated successful map

#### Scenario: Equally good target codes
- **GIVEN** two eligible retrieved targets with equal scores
- **THEN** the proposal is ambiguous even when configured ambiguity gap is zero
- **AND** bulk acceptance leaves it unaccepted
