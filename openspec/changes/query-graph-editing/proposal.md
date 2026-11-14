# PR-01 — Pure Query graph edit operations

Starting HEAD: `b9e63bd6dace6cccf49839a34e01dce80fd9c487`; clean tree.
Implements the updated roadmap's PR-01 under ADR-0032, preserving ADR-0031,
ADR-0037/0043–0047 and the merged lifecycle/navigation/Query workspace contracts.

Extract a small vertical slice: remove Query, apply/update JOIN, replace/move
steps, and the adjacent append/remove-step rules needed to eliminate impure
step updaters. Functions accept an explicit Project and typed inputs and return
the project, controlled error or no-op and optional semantic selection intent.
Commit against the current ProjectBag reducer snapshot; consume UI effects only
after commit. No captured query-array replacement or updater-local JOIN index.

No Rust, wire, format, Mapping persistence, execution controller, generic command
bus, new authoring store, CLI or Compare changes. Derive/remove-edge extraction
is deferred; existing SQL-placeholder and query-backed-map deletion policy is
not expanded into cascading deletion or SQL rewriting.

Review: proposal → specs/query-graph-editing/spec.md → design → tasks.
