# Proposal: First-run / Options dbt setup

## Why

New users hit “dbt not found” on Export. We already have a fetch script and Options venv path ([ADR-0021](../../../docs/adr/0021-app-options-recent-projects.md)); we need an in-app path to create the venv or copy the install commands ([ADR-0023](../../../docs/adr/0023-dbt-setup-onboarding.md)).

## What changes

| In scope | Out of scope |
|----------|--------------|
| First-launch dialog when dbt missing | Bundled Python runtime |
| Install → `~/.dwhforge-query/dbt-venv` + set `dbt_venv_path` | Silent auto-install without consent |
| Copy install script to clipboard | Changing dbt pin matrix (ADR-0006) |
| Options: Install / Copy again | Per-project dbt path |

## Success

- Fresh machine without dbt: dialog offers Install or Copy; Install leaves a working `dbt --version` under app home and Options shows the path.
- Dismissed users can re-run from Options.

## References

- [ADR-0023](../../../docs/adr/0023-dbt-setup-onboarding.md)
