# Design

Keep the current operations/result/service/reducer/receipt structure.
Add two named operations, not a new action registry. Reuse existing Query ID and
SQL-placeholder/dependency helpers. A bounded traversal of query definitions
checks protected map/check owners; it is not a dependency-management subsystem.

Reject FromQuery consumers rather than removing a root and leaving transforms.
Retain safe Join/Append scrub; filter direct output IDs. Keep historical
CheckRuns and seed-map creation provenance. Edge removal checks roots and
protected owners before committing; the UI provides optional selection hints.

The other four Query creation handlers need only Workspace spread fixes,
not an unrelated creator/controller extraction. Test their real UI paths and
persist/reopen actual host-written JSON. PG requires DSN for live execution;
do not claim live PG coverage from a synthetic picker response.
