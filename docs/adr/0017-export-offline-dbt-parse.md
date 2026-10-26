# ADR-0017: Offline `dbt parse` on Export (author-first)

## Status

Accepted (2026-10-26)

## Context

Export writes a real dbt project that users often `dbt run` on another machine or in CI. Authors still need a local check that the generated project is structurally valid without requiring warehouse credentials.

Official dbt Core:

- `dbt parse` — no warehouse; validates project / Jinja / YAML and builds a manifest without compiled SQL.
- `dbt debug` / `dbt compile` / `dbt run` — need a data-platform connection.

Turning Export into a hidden `dbt run` materializer would blur the product into a local orchestrator ([COMPETITIVE.md](../COMPETITIVE.md) — we stay thinner: author → export).

## Decision

1. **UI Export** always: write tree → `dbt parse --no-partial-parse` with `--project-dir` and `--profiles-dir` = export root.
2. **Do not** run `debug` / `compile` / `run` on Export.
3. Files remain on disk if parse fails or `dbt` is missing (`dbt_parse_ok` + log in `ExportResult`).
4. **CLI** `dwh-export --validate` opts into the same parse; default off for headless without dbt.
5. Prefer managed venv via `scripts/fetch-dbt-venv.sh` (`src-tauri/dbt-venv`), else `PATH`.

## Consequences

- Install docs mention fetch-dbt-venv alongside DuckDB extensions.
- Full DoD remains `dbt run` elsewhere; parse is an author gate only.
- Optional “Materialize via dbt” (local run) stays a future Hybrid gesture, not default Export.
