# Spec: project-relative-load-paths

Capability contract for [ADR-0043](../../../../docs/adr/0043-project-relative-load-paths.md).

## Requirements

### Requirement: Explicit path_kind on file Loads and Sources

File Load steps (`LoadCsv`, `LoadParquet`, local file `LoadDuckdb`) and file `SourceDef` entries SHALL store `path_kind` as `absolute` or `relative`. Runtime resolution SHALL use `path_kind`, not host `Path::is_absolute` alone.

#### Scenario: Relative load resolves against project file
- **GIVEN** a saved project at `/repo/app.dwhproj.json`
- **AND** a LoadCsv with `path` `data/a.csv` and `path_kind` `relative`
- **WHEN** preview or export runs with that project file
- **THEN** the engine reads `/repo/data/a.csv` (or OS-equivalent join)

#### Scenario: Absolute load unchanged
- **GIVEN** LoadCsv with an absolute path and `path_kind` `absolute`
- **WHEN** preview runs
- **THEN** that path is used as stored (no join against the project directory)

### Requirement: Relative storage is portable

When `path_kind` is `relative`, the stored `path` SHALL use forward slashes only. Absolute paths MAY use the native separators of the authoring OS.

#### Scenario: Windows-authored relative opens on Linux
- **GIVEN** `path_kind` `relative` and `path` `data/crm.csv`
- **WHEN** the project is opened on Linux with the same folder layout
- **THEN** resolution succeeds against the project directory

### Requirement: Save relativizes under the project directory

On Save to a project file path, any absolute file Load/Source path that is under the project file’s directory SHALL be rewritten to a relative path with `path_kind` `relative`. Paths outside that tree, `s3://` URIs, and remote connection-backed paths SHALL remain absolute (or remote).

#### Scenario: CSV beside project becomes relative
- **GIVEN** project saved at `/repo/p.dwhproj.json` and LoadCsv absolute `/repo/data/x.csv`
- **WHEN** Save completes
- **THEN** the on-disk document has `path` `data/x.csv` and `path_kind` `relative`

### Requirement: Relative requires a project file at execute time

An operation that must read a `path_kind` `relative` Load SHALL fail clearly when `project_file` is not provided (unsaved project).

#### Scenario: Unsaved relative refused
- **GIVEN** a relative Load in memory
- **AND** no `project_file` on the preview request
- **WHEN** preview runs
- **THEN** the host returns an error asking to Save the project first

### Requirement: format_version 5 stamps path_kind

Loading a v4 (or older migrated) document SHALL set `format_version` to 5 and stamp missing `path_kind` via the cross-platform absolute heuristic (`s3://`, `/…`, `\\…`, `X:/` / `X:\`).

#### Scenario: Legacy absolute stamped
- **GIVEN** a v4 project with LoadCsv `path` `/tmp/a.csv` and no `path_kind`
- **WHEN** the document is migrated
- **THEN** `path_kind` is `absolute` and `format_version` is 5
