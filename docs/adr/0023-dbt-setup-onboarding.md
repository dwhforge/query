# ADR-0023 — First-run / Options dbt setup

## Status

**Accepted** (implemented — OpenSpec `specs/dbt-setup-onboarding/`)

## Context

Export Parse/Build need dbt Core 1.x ([ADR-0017](0017-export-offline-dbt-parse.md), [ADR-0006](0006-dbt-version-matrix.md)). Today authors run `./scripts/fetch-dbt-venv.sh` manually; Options only points at an existing venv ([ADR-0021](0021-app-options-recent-projects.md)). Packaged desktop users often have no repo checkout and no `dbt` on PATH.

## Decision

1. **Suggested install location:** `~/.dwhforge-query/dbt-venv` (app home — writable for Electron builds). On success, set `settings.dbt_venv_path` to that root so resolution prefers it ([ADR-0021](0021-app-options-recent-projects.md)).
2. **First launch:** if no dbt binary is resolved and `dbt_setup_dismissed` is false, show a setup dialog:
   - **Install for me** — create venv + `pip install` dbt-core / dbt-duckdb / dbt-postgres (same pins as `scripts/fetch-dbt-venv.sh`);
   - **Copy install script** — put an equivalent shell/PowerShell snippet on the clipboard;
   - **Not now** — set `dbt_setup_dismissed=true` (can revisit from Options).
3. **Options:** same Install + Copy actions next to the venv path field (always available).
4. **Requirements:** system `python3` (or Windows `py`/`python`) must exist; otherwise show an error and keep the Copy path.
5. **Out of scope:** bundling a full Python runtime; silent background installs without consent; changing Parse/Build semantics.

## Consequences

- Soft-migrate: absent `dbt_setup_dismissed` → false.
- Dev checkout may still use `./dbt-venv` via auto-discovery; home venv is the guided default.
- OpenSpec: [`openspec/changes/dbt-setup-onboarding/`](../../openspec/changes/dbt-setup-onboarding/).

## References

- [ADR-0017](0017-export-offline-dbt-parse.md), [ADR-0021](0021-app-options-recent-projects.md), [ADR-0006](0006-dbt-version-matrix.md)
- Script: [`scripts/fetch-dbt-venv.sh`](../../scripts/fetch-dbt-venv.sh)
