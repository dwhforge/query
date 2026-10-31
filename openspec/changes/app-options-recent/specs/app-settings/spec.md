## ADDED Requirements

### Requirement: Options dialog persists app-global settings

The system SHALL provide **File → Options…** that reads and writes `~/.dwhforge-query/settings.json` without mutating the open project's IR.

#### Scenario: Save custom dbt venv and engine defaults

- **WHEN** the user sets `dbt_venv_path` to an absolute venv root, sets default execution engine and destination, and saves Options
- **THEN** those values are stored in `settings.json`
- **AND** `default_target_dialect` equals `default_execution_engine`

#### Scenario: Empty dbt path means auto-discovery

- **WHEN** `dbt_venv_path` is empty or whitespace
- **THEN** dbt resolution uses only the built-in candidate list and PATH (no custom prepend)

### Requirement: Custom dbt venv is preferred when present

When `dbt_venv_path` is non-empty, the host SHALL try `{dbt_venv_path}/bin/dbt` (or Windows `Scripts/dbt.exe`) before other candidates.

#### Scenario: Custom venv wins

- **WHEN** the setting points at a venv that contains an executable `dbt`
- **THEN** parse/build use that binary

### Requirement: New projects use Options engine defaults

`emptyProject` SHALL seed `execution_engine` and `destination.kind` from `default_execution_engine` and `default_destination_kind` (falling back to `default_target_dialect` / duckdb).

#### Scenario: Cold start untitled project

- **WHEN** the app creates an Untitled project without restoring a file
- **THEN** engine and destination match Options defaults

#### Scenario: Open existing project unchanged

- **WHEN** the user opens a `.dwhproj.json`
- **THEN** that project's engine and destination are left as stored (Options defaults do not overwrite)
