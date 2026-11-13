# PR-05 — Query workspace and local Inspector editors

Implement only the view/editor ownership slice after PR-04B, under Accepted
ADR-0031/0032/0039/0044/0045/0046/0047. No new product decision.
Starting HEAD: e30220ac98a86a1c5a7bb8799217c2441fc49a02; empty index;
PR-04B is present as unstaged/untracked work and must be preserved.

Extract Query composition and concrete Inspector editors. Drafts belong to the
selected project/query/step editor, not App. Applying commits through existing
transformations without replacing the user's textual representation. Async
schema information supplies choices only and cannot hydrate over typed input.
Shell retains tool tabs and mounted Mapping/Matching sessions. Preview and Join
diagnostics retain independent controllers and replacement reset ports.

Out of scope: host/IPC/IR/dependencies, Compare, plugins, stores/buses, Join Lens
rewrite, Mapping Save policy, known mapping-create failure, PR-06 tooling.

Review order: proposal → specs/query-workspace/spec.md → design → tasks.
