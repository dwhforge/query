# Query graph editing

## MODIFIED Requirements

### Requirement: Structural Query deletion preserves independent owners
Deleting a Query SHALL preserve unrelated Workspace properties and KeyMaps.
Surviving FromQuery or explicit SQL-placeholder consumers SHALL cause controlled
rejection. Query-backed KeyMap and MappingCheck input closures that need the
target SHALL block deletion, without automatic owner deletion/rebinding.
Unprotected Join/Append references SHALL be scrubbed as before, including empty
Appends. Publications of the deleted Query SHALL be removed; focus/canvas/source
catalog synchronization SHALL be preserved. All rejected edits SHALL retain the
exact original snapshot and have no navigation effect.

### Requirement: Confirm soft deletion consequences
The application boundary SHALL expose structured affected Query IDs/names,
operation kinds, step indices and whether a Join/Append step is removed or an
Append input is removed. The UI SHALL list these consequences and require
confirmation before changing surviving operations. Cancellation SHALL not mutate
the Project or navigate. No extra prompt is required without these consequences.
Commit SHALL revalidate hard dependencies and reject a stale graph-snapshot
confirmation without applying deletion. Existing target revision semantics,
project formats and IPC contracts SHALL remain unchanged.

#### Scenario: Dependencies change after preparation
Prepare deletion, then add/change a dependency in another Query or bind a Mapping
or Check to the target. Committing the earlier confirmation SHALL reject with
the current snapshot intact, even when the deleted Query itself did not change.

### Requirement: Pure derive and edge edits
Derive and removeEdge SHALL use the existing pure Query Editing service and
current reducer snapshot. Derive SHALL create a unique local FromQuery branch,
preserving other Workspace fields and unrelated project content. All five
existing Query creation handlers SHALL retain KeyMaps.
Edge removal SHALL distinguish typed local/external targets and indexed Joins,
preserving unrelated edges. Stale/missing edges SHALL be no-ops. Removal SHALL
refuse rootless transforms and protected Mapping/Check inputs. Clearing a sole
From root SHALL refuse if another Query/publication/Mapping/Check needs it.

#### Scenario: Round-trip after sequential edits
Open a project with multiple Queries and KeyMaps, create Queries using the
existing creation paths, derive, edit steps/Join and remove safe edges/Queries.
After each action unrelated KeyMaps remain unchanged; Save and reopen preserve
the resulting graph and Mapping definitions.
