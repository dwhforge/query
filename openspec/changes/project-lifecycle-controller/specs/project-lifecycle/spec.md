# Query project lifecycle

## ADDED Requirements

### Requirement: Scenario-owned orchestration

A reusable Query Project controller SHALL own the saved baseline, replacement
snapshot, single-flight Save/replacement coordination, Save As identity and
Open/Recent/lab orchestration. React SHALL supply current owners and effect
adapters rather than reproduce lifecycle policy. Existing pure replacement and
lab construction functions SHALL remain authoritative.

### Requirement: Persistence and concurrent edits

Save SHALL record only the acknowledged snapshot. Edits made while a picker is
open SHALL be included when submission starts. Edits made during persistence
SHALL remain current and dirty; Save-before-replace SHALL stop. Save As to a new
file SHALL fork UID only on acknowledged, still-current application; same-file
Save As SHALL retain UID. Failure/cancel SHALL retain document and navigation.
Connections SHALL remain app-global. Project-file Save SHALL NOT save separate
Mapping/Matching drafts or weaken their existing acknowledgement/origin policy.

#### Scenario: Slow Save or Save As
- WHEN the document changes during save IPC
- THEN the newer document stays open and dirty and replacement does not proceed
- AND the baseline describes the persisted snapshot, not the newer edits

### Requirement: Atomic replacement and transient reset

Open, Recent and labs SHALL share Save/Discard/Cancel and current-owner mutation
guards. Late project or draft changes SHALL prevent replacement. Only committed
replacement SHALL clear old owner tabs, reset typed navigation, invalidate old
preview requests and clear preview/diagnostics/check/lab transient state. A lab
SHALL be independent and unsaved; only a newly opened flagship SHALL start its
task session. Failed Recent loads MAY prune Recent; cancel/save failure SHALL NOT.
Asynchronous export-map refresh SHALL NOT overwrite concurrent document edits.
Project load/save failures SHALL remain visible until dismissed or settled by a
subsequent lifecycle operation; unrelated preview completion SHALL NOT clear them.

#### Scenario: Slow project or lab load
- WHEN edits arrive after permission and before load completion
- THEN replacement is rejected with no session reset

#### Scenario: Successful replacement
- WHEN a replacement is committed
- THEN stale preview state and old Mapping/Matching/navigation are removed
- AND Help Lab remains available with the existing canvas/quality destination
- AND app-global connections remain available
