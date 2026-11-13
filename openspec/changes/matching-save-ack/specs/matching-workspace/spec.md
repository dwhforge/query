## MODIFIED Requirements

### Requirement: Final review Save uses existing storage semantics

Commit planning SHALL NOT mark decisions saved or clear unsaved decisions.
Matching SHALL expose explicit saved, no_changes, conflict, refused, and error
outcomes. Only acknowledged persistence or a no-op verified against the current
Mapping SHALL settle the corresponding confirmed decisions. Missing target IDs,
missing maps, import refusal, unsupported write bindings, skipped required writes,
conflict/error, cancellation, and stale context SHALL NOT count as Saved.

Live map data SHALL be revalidated before mutation. Source maps SHALL use real
exact-key baselines and existing dirty-delta writes, not paged/project caches.
Unrelated dirty Mapping drafts SHALL NOT be implicitly saved. Explicitly approved
replacements SHALL write the approved outputs, not silently preserve old cells.

Failures SHALL keep confirmed decisions and allow retry without success copy.
Successful Mapping Save SHALL NOT imply that the project file has been saved.
A skipped external sync for a seed with no linked export SHALL acknowledge its
successful local Mapping save; this is not a refused warehouse or linked-seed write.
Failed external sync SHALL NOT imply rollback of a local AST update. Retrying
after external failure SHALL retry persistence even if local rows now match.
Late replies SHALL NOT settle a changed/closed session or replacement project.

#### Scenario: Missing target or failed write
- **GIVEN** confirmed draft decisions
- **WHEN** target resolution or persistence fails or refuses the write
- **THEN** the draft stays dirty and no Saved message is displayed

#### Scenario: Acknowledged save and repeated save
- **WHEN** the existing Mapping path acknowledges persistence
- **THEN** only the confirmed write set becomes saved
- **AND** a repeated save verifies live rows without duplicating From keys

#### Scenario: Concurrent edit during save
- **WHEN** the map, session, or project changes while planning or writing awaits
- **THEN** stale work is not published as a successful current-session save
- **AND** committed writes are not described as rolled back
