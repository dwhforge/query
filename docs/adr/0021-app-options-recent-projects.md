# ADR-0021 — App Options, Recent projects, and dbt venv override

## Status

**Accepted**

## Context

Authors need VS Code–style **Open Recent** and a place for **app-global** preferences that are not part of a `.dwhproj.json`:

1. Optional path to a **dbt virtualenv** (not only repo-local `./dbt-venv` or PATH) — [ADR-0017](0017-export-offline-dbt-parse.md).
2. **Default execution engine** and **default destination** for *new* projects — distinct from the current project's Project menu ([ADR-0014](0014-query-execution-affinity.md)).
3. A short MRU list of project paths under File.

App defaults already live in `~/.dwhforge-query/settings.json` ([ADR-0016](0016-product-rename-dwhforge-query.md)); LLM keys and panel widths already use that file.

## Decision

1. **File → Options…** edits `settings.json` (not the open project).
2. New settings keys (serde-tolerant; missing = defaults):
   - `recent_projects: string[]` — absolute paths, MRU, max **10**.
   - `dbt_venv_path: string` — absolute path to a **venv root** (`bin/dbt` or Windows `Scripts/dbt.exe`). Empty = unset.
   - `default_execution_engine`, `default_destination_kind` — seed `emptyProject` only.
   - Keep `default_target_dialect` **synced** to `default_execution_engine` on write (legacy readers).
3. **dbt resolution:** when `dbt_venv_path` is set and the binary exists, it is tried **first**; then existing candidates (exe-relative, `~/.dwhforge-query/dbt-venv`, cwd/repo `dbt-venv`, PATH).
4. **File → Open Recent** lists MRU; Clear recently opened empties the list. Successful Open / Save / Save as / session restore updates MRU. Missing path → error + remove from list.
5. **Project menu** remains per-project only; it does **not** write engine/destination app defaults.

## Consequences

- Install docs mention Options for a custom venv location.
- OpenSpec change: `openspec/changes/app-options-recent/`.
- Out of scope: per-project dbt path; moving LLM UI into Options (Join Lens panel stays).

## References

- [ADR-0014](0014-query-execution-affinity.md), [ADR-0017](0017-export-offline-dbt-parse.md), [ADR-0016](0016-product-rename-dwhforge-query.md)
- OpenSpec: [`openspec/changes/app-options-recent/`](../../openspec/changes/app-options-recent/)
