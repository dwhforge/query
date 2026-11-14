# Design

`createQueryEditingService(project)` is a small immutable snapshot binding, not
a store. Named methods accept the existing operations' typed input plus optional
`expectedRevision`. No universal command union, registry or setter ports.

`revision(queryId)` fingerprints project identity and the target Query definition
(including steps). This is an in-process optimistic token, not persisted IR, a
warehouse/evidence revision, or a transitive dependency freshness guarantee.
Expected revision is opt-in: ordinary synchronous UI batch edits still run on the
latest reducer snapshot rather than incorrectly rejecting the second edit.

Existing pure operations validate IDs and apply graph rules. The facade only
checks the optional revision before publishing their pure result. An error
preserves the original snapshot and has no navigation intent. Operations are
synchronous; there is no background job or cancellation protocol to implement.
Existing Preview/Join execution remains independently cancelable.
Editor-selection hints are optional; a standalone remove-step call needs only
the query ID and step index. UI supplies its selection to retain existing
post-edit navigation behavior, not to authorize the mutation.

The reducer action accepts a function over the facade rather than over raw
Project. It binds the facade inside reducer execution. The existing post-commit
receipt remains the UI-only navigation/error/preview adapter.
