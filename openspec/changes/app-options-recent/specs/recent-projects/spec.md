## ADDED Requirements

### Requirement: File Open Recent MRU

The system SHALL expose **File → Open Recent** listing up to 10 absolute project paths from `settings.json` `recent_projects`, most recent first.

#### Scenario: Successful open updates MRU

- **WHEN** the user successfully opens or saves a project at path P
- **THEN** P is moved to the front of `recent_projects` (deduped, max 10)

#### Scenario: Missing file pruned

- **WHEN** the user selects a recent path that no longer exists
- **THEN** the app shows an error and removes that path from `recent_projects`

#### Scenario: Clear recently opened

- **WHEN** the user chooses Clear recently opened
- **THEN** `recent_projects` becomes an empty list
