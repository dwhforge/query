# External Harness: OpenCode V2 Web + CLI adapter

Status: Proposed (experimental). ADR: `docs/adr/0053-opencode-harness-adapter.md`.

## Why

A user should be able to ask an OpenCode agent in **business language** to build and check a repeatable DWH analysis project, with no DWHQuery-specific knowledge. Avoid spending engineering resources on a second agent/chat runtime before validating whether a powerful coding model benefits from DWHQuery's deterministic IR and diagnostics.

## Scope

Add a server-side OpenCode V2 plugin over the existing standalone DWHQuery CLI, a discoverable skill, a conflict-safe installer into an independent business workspace, a **localhost-only password-protected Web UI launcher**, one small CSV benchmark, and mocked plugin/launcher tests. Preserve typed operations, ownership controls, workspace path boundaries, non-disclosure of raw rows by default and operator opt-ins.

## Out of scope

No direct Host RPC exposure, unsafe warehouse writes, automatic Mapping acceptance, multi-tenant hosting, persistent agent task orchestration, or completed MCP integration. Real model + Host + Electron acceptance is tracked separately and must not be asserted from mocked tests.
