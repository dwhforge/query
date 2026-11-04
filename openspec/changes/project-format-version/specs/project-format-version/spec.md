# Spec Delta: project-format-version

## ADDED Requirements

### Requirement: format_version on project documents

Saved projects SHALL include integer `format_version`. The application CURRENT version is 1. Absence of the field SHALL be treated as version 0.

#### Scenario: Legacy open
- **GIVEN** a project JSON without `format_version`
- **WHEN** loaded
- **THEN** migrations run and the in-memory project has `format_version == 1`

#### Scenario: Future file refused
- **GIVEN** a project with `format_version` greater than CURRENT
- **WHEN** loaded
- **THEN** load fails with an unsupported-version error

### Requirement: Backup before on-disk upgrade

When saving over an existing file that is older than CURRENT, the host SHALL write `<path>.bak` before replacing the file.

#### Scenario: Save upgrades
- **GIVEN** an on-disk v0 project
- **WHEN** the app saves the migrated project to the same path
- **THEN** the previous bytes are available at `<path>.bak`
