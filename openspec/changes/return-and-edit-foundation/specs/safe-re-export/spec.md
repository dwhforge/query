# Spec Delta: safe-re-export

## Purpose

Make re-export safe for Git workflows: stable names, reviewable diffs, and no silent clobber of hand-edited generator-owned files.

## ADDED Requirements

### Requirement: Generator-owned manifest

Each successful export SHALL write a manifest listing generator-owned relative paths and content hashes for those files, suitable for the next re-export conflict check.

#### Scenario: First export writes manifest
- **WHEN** export completes successfully into an empty or non-manifest directory
- **THEN** a manifest is written documenting owned paths and hashes

### Requirement: Refuse conflicts before any write

On re-export, if any generator-owned file on disk has a content hash different from the last successful export manifest, the system SHALL refuse the export **before** modifying any file, and SHALL report which paths conflict.

#### Scenario: Hand-edited model blocks export
- **GIVEN** a prior export with manifest
- **AND** the user edited an owned `.sql` file
- **WHEN** they export again to the same directory
- **THEN** no project files are updated
- **AND** the error names the conflicting path(s)

### Requirement: No partial update on failure

Validation of the full export plan and conflict checks SHALL complete before writing. A failed export SHALL leave the previous tree unchanged.

#### Scenario: Conflict mid-plan
- **WHEN** conflict detection fails for any owned file
- **THEN** the on-disk project matches the pre-export state (including prior manifest)

### Requirement: Stale owned files

Owned paths present in the old manifest but absent from the new export plan SHALL be removed only after conflict checks pass for all retained owned files.

#### Scenario: Removed query
- **GIVEN** a prior export that included model M
- **AND** the workspace no longer produces M
- **AND** no conflicts on remaining owned files
- **WHEN** re-export succeeds
- **THEN** M is deleted from disk
- **AND** the new manifest no longer lists M

### Requirement: Unowned files untouched

Paths not listed as generator-owned SHALL NOT be deleted or overwritten by export.

#### Scenario: User sidecar
- **GIVEN** a file in the export directory that was never in the manifest
- **WHEN** re-export runs successfully
- **THEN** that file remains unchanged

### Requirement: Stable model identity

dbt model file names and `ref()` targets for existing queries SHALL remain stable when only `focus_query_id` changes or when an unrelated query is added.

#### Scenario: Focus change
- **GIVEN** a workspace with queries A and B
- **WHEN** focus moves from A to B and the user re-exports
- **THEN** model paths for unchanged queries stay the same
- **AND** an identical logical export (aside from mart prefix rules tied to focus) produces a reviewable, minimal diff

#### Scenario: Unrelated query added
- **GIVEN** an exported workspace
- **WHEN** the user adds a new Load-only query that nothing references
- **AND** re-exports
- **THEN** previously exported models keep the same filenames
- **AND** new staging files appear for the added query

### Requirement: Identical workspace trivial diff

Re-exporting a bitwise-identical workspace and settings into the same directory SHALL produce an empty or trivial diff on owned files (hash-stable content).

#### Scenario: No-op re-export
- **WHEN** export is repeated with no workspace changes and no hand-edits
- **THEN** owned file hashes match the previous manifest
- **AND** Git-relevant content does not churn (no random ids in filenames or SQL)
