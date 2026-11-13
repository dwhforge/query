# PR-03 — Query context and semantic navigation

Implement the next scenario extraction under Accepted ADR-0031/0032/0039/0044/
0045/0046/0047. Preserve PR-00A acknowledgement, PR-00B origin policy, PR-01
typed tabs and PR-02 project controller/reset boundaries. No new product decision.

Scope: ephemeral Query context, small explicit navigation commands shared by
Explorer, Help Lab and Matching; original-JOIN return validation; stale async
panel/handoff refusal; editor hydration and ordinary preview semantics.

Not in scope: framework, global store/bus, Compare, persisted IR, IPC, Rust,
live row acquisition, project replacement changes or PR-04 extraction.

Live baseline: feature/matching HEAD 9a918c5d668ab4dd39dbf49008a3ab59d2695fba;
PR-01 staged and PR-02 unstaged/untracked. Preserve index and all prior work.
Review order: proposal → specs/query-navigation/spec.md → design → tasks.
