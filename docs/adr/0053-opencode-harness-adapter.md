# ADR-0053 — OpenCode V2 server adapter over DWHQuery CLI

Status: **Proposed** (2026-11-17). Extends [ADR-0052](0052-external-harness-tool-boundary.md) without superseding it.

## Context

The first business-language harness experiment must let a remote user create and validate a project **without learning DWHQuery**. The existing standalone CLI already offers safe project creation, bounded DuckDB operations and serialization. OpenCode 2.x has a web UI and server-side plugin API; writing a bespoke chat UI or agent runtime would delay validation without adding business value.

## Decision

- OpenCode owns natural-language understanding, planning, tool selection, dialogue and UI. Users do not need to name DWHQuery or technical operations.
- Implement one **OpenCode V2 server plugin** under `integrations/opencode/`, installed into `.opencode/plugins/` in an independent business workspace. Use official `ctx.tool.transform` and JSON Schema inputs; add a discoverable `dwhquery` skill under `.opencode/skills/`.
- Tools spawn the existing standalone CLI with positional `argv` and `shell: false`, never arbitrary Host RPC. Reuse the CLI's operation allowlist, state ownership checks and Host validation. Apply workspace path/symlink checks, output size/time limits and cancellation.
- The plugin supports both web and terminal clients. Deploy the first web evaluation as **one user, localhost only, authenticated**, accessed from another machine through SSH forwarding. The launcher checks OpenCode V2 and binds to `127.0.0.1`. No public/unauthenticated listener is added.
- Distinguish control-plane evidence from data-plane rows. Schema/counts are default; raw row disclosure requires operator opt-in **and** OpenCode's permission evaluation. SQL expression opt-in is not sandboxing. Use read-only data-source credentials.
- No user model/provider preferences are changed. DWHQuery does not implement a language-model runtime, agent planner or MCP transport as part of this experiment.

## Acceptance

One real OpenCode Web session from a business-language prompt creates two CSV source Queries, derives and joins them, checks missing matches, saves a valid project, exports dbt and reopens that project in Electron. Compare to the same model and prompt without DWHQuery. A mocked plugin test or successful startup is not a substitute for this acceptance test.

## Exclusions / threats

No automatic Mapping resolution, warehouse writes, `dbt build`, project-wide ChangeSet, cross-process atomic Save or multi-tenant isolation. A scoped plugin cannot control the agent's other tools, such as shell/filesystem. Run under a dedicated OS account and independently enforce resource permissions. A local project revision does not guarantee source data freshness. External model privacy policies remain relevant even when raw rows are suppressed.
