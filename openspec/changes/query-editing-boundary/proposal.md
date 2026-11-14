# Updated-roadmap PR-02 — Query operation boundary

Starting HEAD: `278ff34` (PR-01); its full rebuilt Electron run passed
70 cases, with 2 PostgreSQL skips; production build, 41 unit files and Rust passed.

Expose only the six implemented PR-01 mutations through a React-independent,
snapshot-bound QueryEditingService. App binds it inside the existing reducer.
Future tests/tool adapters call small typed inputs, not App handlers, setters or
QueryContext. Optional target-query revision checking refuses stale intentions.

Keep operations.ts as the sole graph-rule/validation owner. No additional
authoring store, React requirement, IPC/format change, MCP/HTTP, scheduling,
plugin/runtime, CLI or Compare feature. Existing navigation and preview
invalidation consume operation selection intents unchanged.

Review: proposal → specs/query-editing-boundary/spec.md → design → tasks.
