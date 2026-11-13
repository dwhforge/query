# Delivered delta: help-lab

Implements Accepted [ADR-0045](../../../../../docs/adr/0045-safe-help-lab-switch.md).
Merged into the [capability source of truth](../../../../specs/help-lab/spec.md).
See the [delivery report](../../report.md) for validation boundaries.

## ADDED Requirements

### Requirement: Explicit replacement permission

Opening a Help lab or quick-load demo SHALL use the same project-replacement
semantics as opening an existing project. If the current project has unsaved
changes or unsaved Mapping/Matching drafts, the operation SHALL offer
**Save / Discard / Cancel**. A saved path alone SHALL NOT mean the current work
is saved. An unchanged saved project SHALL NOT trigger an unnecessary warning.
Save SHALL permit switching only after successful persistence. Picker
cancellation, save failure, or remaining unsaved separate drafts SHALL keep the
current project open. Project Save SHALL NOT imply that separate warehouse or
Matching drafts have been committed. The same protection SHALL apply to
user-initiated Open and Open Recent through a shared lifecycle path.

#### Scenario: Save changed current project before switching
- **GIVEN** a saved project with an unsaved query or step change
- **WHEN** the user opens a lab and chooses Save
- **THEN** the current project is successfully saved before replacement
- **AND** the clean lab opens with independent identity and no save target

#### Scenario: First save before switching
- **GIVEN** a new project with unsaved work and no save path
- **WHEN** the user opens a lab and chooses Save
- **THEN** the existing save picker requests a path for the current project
- **AND** the lab opens only after saving succeeds

#### Scenario: Save cancelled or failed
- **GIVEN** unsaved work and a pending lab switch
- **WHEN** the user chooses Save but cancels the file picker or saving fails
- **THEN** the current project and drafts remain open with no replacement
- **AND** a save failure is shown through the existing error UI

#### Scenario: Separate drafts remain unsaved
- **GIVEN** local Mapping or Matching drafts not persisted by project-file Save
- **WHEN** the user chooses Save before switching
- **THEN** the current project stays open unless those drafts are safely persisted
- **AND** the UI explains what still needs saving without silently writing a warehouse or accepting proposals

#### Scenario: Discard before switching
- **GIVEN** unsaved work in the current project
- **WHEN** the user opens a lab and explicitly chooses Discard
- **THEN** the lab opens without saving the current changes

#### Scenario: Unchanged saved project
- **GIVEN** a saved project without later edits or separate dirty drafts
- **WHEN** the user opens a lab
- **THEN** it opens without an unsaved-work warning

#### Scenario: Cancel replacement
- **GIVEN** an existing project with a changed query or step
- **WHEN** the user opens a lab and cancels the replacement warning
- **THEN** the graph, changes, tabs, selection, identity and save path remain unchanged
- **AND** Mapping and Matching drafts remain available

#### Scenario: Empty startup
- **GIVEN** an initial empty project without local drafts
- **WHEN** the user opens a lab
- **THEN** no unnecessary replacement warning is shown

#### Scenario: Matching decisions
- **GIVEN** unsaved Matching decisions and existing workspace content
- **WHEN** the user opens a lab
- **THEN** one warning covers discarded content and decisions, rather than duplicate prompts

### Requirement: Independent lab save identity

A successful lab switch SHALL create a new unsaved project using existing
project identity and construction conventions. It SHALL NOT inherit the previous
project's save path, identity, linked dbt export tree, references, project-specific
connection bindings, outputs, checks, or history. App-global connections and
settings SHALL remain available. Explicit advanced-demo routing presets SHALL
remain supported. The offline reconciliation lab SHALL execute in DuckDB.

#### Scenario: Save lab after discarding current edits
- **GIVEN** a working project saved to a known file
- **WHEN** the user opens a lab, discards current edits if prompted, and invokes Save in the lab
- **THEN** a save destination is requested, not implicitly set to the previous project file
- **AND** the previous file's bytes remain unchanged unless explicitly selected for overwrite
- **AND** saving and reopening the lab preserves its independent identity and content

#### Scenario: Offline flagship with PostgreSQL defaults
- **GIVEN** app defaults configured for PostgreSQL and no live PostgreSQL connection
- **WHEN** the user opens the reconciliation flagship lab
- **THEN** it loads using DuckDB with its existing dirty recon join focus and partial map
- **AND** app-global connections and defaults are not rewritten

### Requirement: Replacement is atomic with respect to load completion

Cancellation, a failed load, or a superseded load SHALL NOT commit replacement
project state. A switch SHALL NOT discard a map write in flight or allow a late
reply from the previous project to mutate the new project. These protections
SHALL reuse existing execution lifecycle mechanisms rather than add a new bus.

#### Scenario: Failed lab load
- **GIVEN** an existing project and permission to switch
- **WHEN** lab loading fails
- **THEN** the original project content, identity, drafts and save path remain intact
- **AND** the failure is reported through existing error UI

#### Scenario: Lab load fails after successful save
- **GIVEN** the current project was successfully saved as part of the switch
- **WHEN** subsequent lab loading fails
- **THEN** the saved current project stays open and the successful save is not rolled back

#### Scenario: Map write in flight
- **GIVEN** a Mapping Save is still in flight
- **WHEN** the user requests a lab switch
- **THEN** replacement waits for settlement or is blocked with an explanation
- **AND** no committed write is described as rolled back

#### Scenario: Late load response
- **GIVEN** a lab request is pending and a later project transition has taken precedence
- **WHEN** the older lab response arrives
- **THEN** it does not replace or mutate the later project
