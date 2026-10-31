## ADDED Requirements

### Requirement: Detect missing dbt on launch

On app startup the system SHALL resolve the dbt CLI (settings venv, app-home venv, cwd/repo venv, PATH). WHEN none is found AND `dbt_setup_dismissed` is false, the system SHALL show the dbt setup dialog.

#### Scenario: Fresh settings, no dbt

- **WHEN** settings load with empty `dbt_venv_path` and no discoverable `dbt`
- **AND** `dbt_setup_dismissed` is absent or false
- **THEN** the setup dialog is offered

### Requirement: Guided install into app home

**Install for me** SHALL create a Python venv at `~/.dwhforge-query/dbt-venv`, install dbt-core / dbt-duckdb / dbt-postgres (1.x pins matching `fetch-dbt-venv.sh`), set `dbt_venv_path` to that root, and set `dbt_setup_dismissed` true.

#### Scenario: Install succeeds

- **WHEN** the user chooses Install and python3 is available
- **THEN** `dbt --version` works via the new venv
- **AND** Options shows the configured venv path

### Requirement: Copy install script

The system SHALL provide a **Copy install script** action (first-run dialog and Options) that places platform-appropriate shell/PowerShell commands on the clipboard targeting the same app-home venv.

### Requirement: Options repeat

Options SHALL expose Install and Copy next to the dbt venv field so setup can be repeated after dismiss or failure.
