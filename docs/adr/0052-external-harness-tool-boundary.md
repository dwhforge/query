# ADR-0052 — External Harness Tool Boundary (PoC)

Status: **Proposed** (November 2026). Scope: first experimental CLI vertical slice, not a general autonomous agent runtime.

## Context

Users express business goals without knowing DWHQuery, Workspace, JOIN, or dbt. External coding harnesses can plan tasks and call CLI tools. Reusing DWHQuery must add reliable inspection, execution and reproducible artifacts, rather than creating a second DWH engine inside an agent.

## Proposed decisions

1. The external harness owns language understanding and orchestration; DWHQuery owns typed project IR, domain edits, validation, SQL generation and persistence.
2. Provide a narrowly allowlisted standalone CLI (JSON-in args, JSON-out result) as the first transport, not raw `dwh:invoke`. MCP may later adapt the same application tools.
3. Reuse `emptyProject`, `QueryEditingService`, `syncSourcesFromQueries`, and Rust Host operations. A tool-specific `save_project_tool` must not change Electron's recent-project session.
4. The CLI must not execute external writes or dbt build. Reading source row samples or executing free-form SQL expressions require explicit operator opt-in.
5. The saved Project opens unchanged in the IDE. Existing Project schema/versioning and Rust Host serializer remain authoritative.
6. Multi-operation atomic change sets, project revisions, per-tool grants and durable agent tasks are later decisions; CLI file locks do not substitute for those guarantees.

## Acceptance gates

- Build and invoke the CLI with the real standalone Rust Host without Electron.
- Agent receives only a user business request, discovers the CLI tools, creates two source queries and a JOIN, validates and diagnoses it, saves the Project and exports dbt.
- Reopen the Project in the IDE and confirm repeatability on real data.
- Compare the agent with and without DWHQuery tools on the same dataset, recording correctness, coverage and human review time.
- Complete a security review before exposing raw row values to external LLM services.
