# Query graph editing

Merged from [updated-roadmap PR-01](../../changes/query-graph-editing/proposal.md)
under ADR-0032. Existing execution, navigation, lifecycle and Mapping contracts
remain authoritative.
Integrity and deletion confirmation follow ADR-0048 and the merged
[integrity change](../../changes/query-editing-integrity/proposal.md).

## Requirements

### Requirement: Explicit pure graph operations
Query deletion, JOIN upsert and step replace/move/append/remove SHALL be pure
TypeScript operations over an explicit Project. They SHALL return a new Project
or the original snapshot for a no-op/error, a controlled validation error where
applicable, and optional query/step selection intent. They SHALL NOT depend on
React, DOM, IPC, storage or mutable global state. Ambiguous duplicate local Query
IDs and missing/invalid operation targets SHALL not partially mutate the project.

### Requirement: Structural Query deletion preserves independent owners
Deleting a Query SHALL preserve unrelated Workspace properties and KeyMaps.
Surviving FromQuery or explicit SQL-placeholder consumers SHALL cause controlled
rejection. Query-backed KeyMap and MappingCheck input closures that need the
target SHALL block deletion, without automatic owner deletion/rebinding.
Unprotected Join/Append references SHALL be scrubbed as before, including empty
Appends. Publications of the deleted Query SHALL be removed; focus/canvas/source
catalog synchronization SHALL be preserved. All rejected edits SHALL retain the
exact original snapshot and have no navigation effect. Independent catalog
Sources SHALL not be deleted just because a query was removed. Missing deletion
is an explicit no-op.

#### Scenario: Deep dependency graph
Delete an unprotected node referenced by several Join/Append descendants. Those
direct references are scrubbed at every depth; surviving queries and references to
other nodes remain. No transitive query deletion or arbitrary SQL rewrite occurs.

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

### Requirement: JOIN upsert retains editable keys and deterministic selection
JOIN upsert SHALL update the first existing Join to the same right target or
append a new Join, retaining other Joins. Empty keys SHALL remain legal for
editing. A missing host/right local query or self-Join SHALL return a controlled
error. The success result SHALL identify the actual committed JOIN index.

#### Scenario: Two edits in a batch
Apply two graph edits to the latest reducer snapshot. Both changes survive and
the selection intent resolves against the committed graph, not updater-local
variables or a stale render-captured queries array.

### Requirement: Step guards and no-op semantics
Root Load/FromQuery/SqlModel steps SHALL remain pinned at the start when moved.
Removing a root with later transforms SHALL refuse. Invalid step targets SHALL
return a controlled error; out-of-range movement and pinned-root movement SHALL
be no-ops without an invalid selection. Replacement SHALL retain the editor's
existing draft-lifetime contract.

### Requirement: Commit then navigate
App SHALL commit operations in its existing ProjectBag reducer using the current
project. The reducer/updaters SHALL have no React effects. Successful selection
intents SHALL use existing semantic Query navigation after commit; errors/no-ops
SHALL not navigate to nonexistent steps. A receipt from a replaced project SHALL
not reopen old Query UI. Preview invalidation SHALL retain existing ownership.
