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
