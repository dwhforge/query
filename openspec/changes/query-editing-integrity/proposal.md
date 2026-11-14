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

## Follow-up review at HEAD 6f15be6

Confirmed: soft Join/Append cleanup has no UI warning. Add pure consequence
inspection and UI confirmation, retaining existing deletion semantics and hard
blocks. Revalidate on commit and reject an outdated confirmation. Verify the
existing dependency/creation/round-trip coverage and add missing cases. Keep
conservative Mapping edge protection unless safety of a relaxation is proved.
