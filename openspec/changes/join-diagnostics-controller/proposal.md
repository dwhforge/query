# PR-04B — Join diagnostics and prepare owner

Extract the existing frontend Join scenario under Accepted ADR-0031/0032,
preserving ADR-0041/0044/0045/0046/0047. No new product decision.
Verified starting HEAD: e30220ac98a86a1c5a7bb8799217c2441fc49a02; clean tree.
Never stage, reset or commit; preserve external changes throughout.

Scope: testable Join diagnostics/prepare/status/progress/sample lifecycle owner
and small React adapter; current-context and newest-request guards; one committed
project replacement reset port. Keep existing Join Lens UI and host lanes.
App retains rendering, schema inference, domain transformations and quality/export
progress. Preview remains exclusively in the PR-04A owner; analysis preempts it.

Excluded: Rust, IPC, dependencies, stores/buses, Compare, plugins, Matching
retrieval/Save changes and the historical mapping-create case 6 bug.

Review order: proposal → specs/join-diagnostics/spec.md → design → tasks.
