# Query editing boundary

Merged from [updated-roadmap PR-02](../../changes/query-editing-boundary/proposal.md)
under ADR-0032; [pure operations](../query-graph-editing/spec.md) remain the
graph-rule owner.

## Requirements

### Requirement: Narrow existing-operation facade
QueryEditingService SHALL expose Query removal/preparation, derivation, edge
removal, JOIN upsert and step replace/move/append/remove. It SHALL be usable
without React, Electron, DOM, storage or host IPC. Operation inputs SHALL contain domain targets/values and
optional target revision, not QueryContext, panel geometry or tab/view state.
The existing pure operations SHALL remain the sole owner of graph rules.
File picker and Load-file rebinding orchestration SHALL remain outside this
boundary. Deletion preparation SHALL expose structured consequences and a
separate target-bound graph-snapshot token. It SHALL NOT commit the proposed
deletion or request confirmation; UI/adapters own consent. Existing
expectedRevision tokens SHALL remain target-definition-only.

### Requirement: Explicit snapshot and revision semantics
The service SHALL evaluate against an explicitly bound Project snapshot. It
SHALL NOT own or implicitly advance an authoring store. Applying a result and
rebinding the next snapshot is the caller's responsibility. Repeated calls SHALL
not mutate the original Project. An optional expected target-query revision SHALL
refuse stale operations with the original Project and a controlled error.
Missing/invalid targets SHALL retain existing domain validation/no-op behavior.

#### Scenario: Stale editor target
Capture the target Query revision, change its steps and invoke a mutation against
the new snapshot with the earlier revision. It fails without changing either
snapshot or emitting a selection intent.

### Requirement: Current reducer commit and semantic navigation
App SHALL bind the service to the current ProjectBag reducer snapshot, not a
render-captured graph. Post-commit effects SHALL map successful query/step intents
to existing semantic navigation and Preview invalidation. Presentation context
SHALL not be required to validate or compute the graph mutation.

#### Scenario: Standalone tool adapter
A unit test binds a Project, invokes JOIN upsert and resolves the returned
selection against the result graph without mounting React or Electron.
