# Proposal: execution-lifecycle

## Why

Make DuckDB session ownership, cancel, and stale-result rules explicit and enforceable (ADR-0031).

## In scope

- Document host lanes / cancel / correlation
- Structured cancel errors
- Renderer stale-reply guard helper for preview + check

## Out of scope

- Workflow engine / multi-session DuckDB
- api.rs / App.tsx full decomposition
