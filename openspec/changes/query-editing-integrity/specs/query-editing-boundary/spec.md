# Query editing boundary

## MODIFIED Requirements

### Requirement: Narrow existing-operation facade
The facade SHALL additionally expose the implemented deriveQuery, removeEdge and prepareRemoveQuery
operations, using domain inputs rather than canvas/React types. Existing
snapshot/revision/commit/navigation semantics remain unchanged. File picker and
Load-file rebinding orchestration SHALL remain outside this extraction.
Deletion preparation SHALL expose structured consequences and a separate
target-bound graph-snapshot token. It SHALL NOT commit the proposed deletion or
request user confirmation; UI/adapters own consent. Existing expectedRevision
tokens SHALL remain target-definition-only.
