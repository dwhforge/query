# PR-04A — Query preview owner

Extract only the Query Data preview scenario under Accepted ADR-0031/0032/0041,
preserving ADR-0044/0045/0046/0047 and all PR-00A/B/01/02/03 contracts. No new
product decision. Live starting HEAD: 8d00ead29d7ce8dd93296a9ac3fbec029456f4fb;
earlier slices are staged, including unrelated .gitignore edits. Do not touch the
index, reset or commit.

In scope: substantive frontend controller and small hook, auto-preview debounce,
request generations, snapshot/phase/loading, sample/full session cache, repeated
refresh, local/host cancel and replacement-only preview reset. App retains scope
construction, UI, client error banner adapter and Join diagnostics.

Out of scope: PR-04B diagnostics extraction, Join Lens rewrite, Compare, universal
DuckDB service, Rust, IPC, dependencies, persisted IR, Mapping/Matching ownership.

Review order: proposal → specs/query-preview/spec.md → design → tasks.
