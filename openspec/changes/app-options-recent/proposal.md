# Proposal: App Options + Recent projects

## Why

Users expect **Open Recent** (VS Code-style) and a way to point Parse/Build at a **custom dbt venv** without cloning next to the app. New projects also need app-level defaults for execution engine and destination, separate from the open project's Project menu ([ADR-0021](../../../docs/adr/0021-app-options-recent-projects.md)).

## What changes

| In scope | Out of scope |
|----------|--------------|
| `settings.json`: `recent_projects`, `dbt_venv_path`, `default_execution_engine`, `default_destination_kind` | Per-project dbt path |
| File → Open Recent (MRU ≤10, clear, prune missing) | Rework LLM into Options |
| File → Options… dialog | Changing Export/Parse/Build UX beyond binary resolution |
| Host prepends custom venv to dbt candidates | |
| `emptyProject` seeded from Options defaults; Project menu does not write those defaults | |

## Capabilities

1. **app-settings** — settings keys, Options dialog, dbt resolve order, new-project defaults
2. **recent-projects** — File → Open Recent MRU behavior

## Success

- User can open a project from File → Open Recent; list updates on open/save; Clear empties it.
- Options saves a custom venv path; Parse/Build prefer `{venv}/bin/dbt` when present.
- New untitled projects use Options engine/destination defaults; opening an existing project leaves its IR unchanged.

## References

- [ADR-0021](../../../docs/adr/0021-app-options-recent-projects.md)
- [ADR-0014](../../../docs/adr/0014-query-execution-affinity.md), [ADR-0017](../../../docs/adr/0017-export-offline-dbt-parse.md)
