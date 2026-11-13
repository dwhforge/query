# Workspace tabs

## ADDED Requirements

### Requirement: Typed collision-free navigation

The center workspace SHALL distinguish query canvas, Help Lab, Mapping, Matching
and quality using typed descriptors. Keys SHALL include kind and unambiguous
identity, never raw document IDs in a reserved namespace. Opening an existing tab
SHALL activate without duplication. Activating an unknown tab SHALL do nothing.
Navigation metadata SHALL NOT own Mapping documents or Matching sessions.

#### Scenario: Reserved-looking map identity
- **WHEN** maps have IDs such as canvas, help_lab, or matching:x
- **THEN** they remain distinct from services and Matching x

### Requirement: Safe close and mounted sessions

Switching tabs SHALL preserve mounted Mapping/Matching state. Dirty close SHALL
request discard confirmation and cancellation SHALL preserve navigation and drafts.
Closing an inactive tab SHALL not change the active tab. Closing active Mapping
SHALL prefer its next/previous Mapping neighbor, otherwise canvas; closing active
Matching SHALL return to canvas. Existing Join/Lens return context SHALL remain.
Keyboard close SHALL use the same guards. Save acknowledgement and demo/live
mode/provenance policies SHALL remain with existing owners unchanged.

#### Scenario: Cancel dirty close
- **WHEN** a dirty Mapping or Matching close is cancelled
- **THEN** the same tab and draft remain open and active selection is unchanged

### Requirement: Project replacement resets only after success

Successful project replacement SHALL remove old Mapping, Matching and quality
navigation and documents, retain Help Lab availability, and activate the existing
canvas/quality destination policy. Cancelled or failed replacement SHALL not reset
tabs, sessions or selections. Project-file Save SHALL not imply draft persistence.

#### Scenario: Replace or cancel
- **WHEN** replacement is cancelled
- **THEN** navigation and sessions stay unchanged
- **WHEN** replacement succeeds
- **THEN** no old document tab remains and Help Lab remains available
