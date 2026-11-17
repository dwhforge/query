# External Harness Tools PoC

Status: Proposed. ADR: `docs/adr/0052-external-harness-tool-boundary.md`.

A user should be able to describe a data-analysis job in everyday terms to an external agent. The agent discovers and uses DWHQuery through a standalone machine-readable CLI to create a project, add real sources/queries, diagnose results and export a reproducible artifact, without Electron UI automation. The first increment is not an LLM integration or an autonomous write agent.

Scope: basic project creation; CSV/Parquet/PostgreSQL source-backed queries; existing typed Query edits; project/schema inspect; bounded preview, JOIN diagnostics; dbt file export; no external mutations; operator consent for raw samples and SQL expressions. Do not expose arbitrary Host RPC. Future iterations add review/apply to existing projects, Mapping-specific agent tools, durable tasks and/or MCP.
