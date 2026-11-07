# Spec: mapping-quality-checks

## Requirements

### Requirement: MappingCheck and CheckRun are distinct
The product SHALL persist MappingCheck definitions separately from CheckRun results. A MappingCheck SHALL reference a KeyMap, input bindings, grouping attributes, and a cohort predicate. Each recalculation SHALL create a new CheckRun and SHALL NOT overwrite prior runs in place.

#### Scenario: Save check across sessions
- **WHEN** the user saves a MappingCheck and reopens the project
- **THEN** the check definition is still available
- **AND** prior CheckRuns remain addressable for comparison when retained

#### Scenario: Recalculate produces a new run
- **WHEN** the user recalculates a MappingCheck
- **THEN** a new CheckRun is recorded with its own timestamps and revisions
- **AND** the MappingCheck definition is unchanged by the run alone

### Requirement: Overview works on the user’s KeyMap
The overview SHALL run against a KeyMap and inputs in the open project, with user-selected grouping attributes. Help-lab fixtures alone SHALL NOT be the only supported path for this capability.

#### Scenario: Own map overview
- **WHEN** the user opens overview for their KeyMap and chosen attributes
- **THEN** aggregates reflect that map and those inputs
- **AND** observations remain distinct from correctness verdicts

### Requirement: Join-anchored attrs axes (ADR-0035)
Attrs overview SHALL select left-axis columns from the Join’s left input and right-axis columns from the right input (side-anchored), not only from columns that survive the final host SELECT. Composite From/ON tuples (including date parts) SHALL form the row-axis identity. Creation and attribute changes SHALL go through an inference+override dialog from KeyMap editor or Join inspector — not Help. The product SHALL NOT default both axes to bare Join ON×ON when a non-key label is available on a side.

#### Scenario: Side-anchored composite overview
- **WHEN** the user confirms a check whose From key is `(ext_offer_id, as_of_day)` with a right-side name-like attribute
- **THEN** the overview matrix rows are labeled by the full left tuple (date included)
- **AND** the SQL rebuilds the Join to read those side columns

#### Scenario: Entry points outside Help
- **WHEN** the user creates a mapping check from the KeyMap editor or Join inspector
- **THEN** a setup dialog shows inferred attributes for override
- **AND** Help remains for Mapping labs only (not check creation)

### Requirement: Cohort is a predicate
Selecting a matrix cell or equivalent group SHALL define a cohort via the check’s selection condition. The UI SHALL NOT require loading every cohort key into the client to open investigation.

#### Scenario: Open cohort in Join Lens
- **WHEN** the user opens the cohort in Join Lens
- **THEN** Lens uses the check predicate as context
- **AND** existing Lens pagination and KeyMap editing apply
- **AND** sample rows illustrate the cohort without replacing the predicate

### Requirement: Batch remap is frozen at confirm
Before confirming a group remap, the product SHALL freeze the concrete From→To changes and the expected KeyMap revision shown in preview. If the map or inputs change after that preview, confirm SHALL be refused until a new preview is produced. Link mutations SHALL use existing KeyMap Save/Apply only.

#### Scenario: Stale preview blocks confirm
- **GIVEN** a batch remap preview bound to KeyMap revision R
- **WHEN** the KeyMap revision is no longer R before confirm
- **THEN** confirm is refused
- **AND** the user must refresh the preview

#### Scenario: Confirm applies only reviewed links
- **WHEN** confirm succeeds
- **THEN** only the frozen From→To set is applied through KeyMap persistence
- **AND** no silent fuzzy Join ON is introduced

### Requirement: Accept links ≠ allow observed difference
Accepting proposed links SHALL change the KeyMap. Marking an observed difference as allowed SHALL record a decision on the MappingCheck with an explanation and SHALL NOT change links or hide the observation without that explicit record.

#### Scenario: Allow difference without remap
- **WHEN** the user marks a family/grade (or similar) difference as allowed
- **THEN** the KeyMap is unchanged
- **AND** the check retains an explained allow decision
- **AND** the observation remains accountable in the UI

### Requirement: Comparable Δ with attribution
Comparing CheckRuns SHALL state whether the mapping changed, the inputs changed, both, or that comparability is limited when a required source version cannot be established. Aggregate hashes and timestamps alone SHALL NOT be presented as sufficient attribution.

#### Scenario: Map-only change
- **GIVEN** two CheckRuns with identical input revisions and differing map revisions
- **WHEN** the user views Δ
- **THEN** the UI attributes the change to the mapping

#### Scenario: Unknown input version
- **WHEN** an input revision cannot be determined for either run
- **THEN** Δ is labeled limited comparability
- **AND** the UI does not claim a pure mapping improvement from aggregates alone
