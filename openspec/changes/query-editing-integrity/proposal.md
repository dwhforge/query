# Complete Query Graph Editing integrity

Starting HEAD: `3e36bcc918c9a0707b6395fa405eccd180785f8f`; clean tree.
Baseline units (42 files) and `tsc --noEmit` passed before edits.

Address the combined review, not a new architecture:
1. Preserve KeyMaps in all five Query creation paths.
2. Refuse destructive deletion that leaves executable dependencies unresolved;
   clean deleted publications without discarding Mapping or Check definitions.
3. Add deriveQuery/removeEdge to existing operations/service and thin App glue.
4. Verify sequential UI edits, real save/reopen and flagship Mapping workflow.

ADR-0048 records the bounded deletion policy approved in the review. Preserve
ADR-0027/0031/0032/0034/0036/0037/0043–0047.
Leave file rebinding, target revision semantics, Shell decomposition and future
CLI/Compare/MCP/plugin work untouched.

Review: proposal → specs → design → tasks.
