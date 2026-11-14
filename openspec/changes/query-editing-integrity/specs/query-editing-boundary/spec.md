# Query editing boundary

## MODIFIED Requirements

### Requirement: Narrow existing-operation facade
The facade SHALL additionally expose the implemented deriveQuery and removeEdge
operations, using domain inputs rather than canvas/React types. Existing
snapshot/revision/commit/navigation semantics remain unchanged. File picker and
Load-file rebinding orchestration SHALL remain outside this extraction.
