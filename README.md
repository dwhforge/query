# DWHForge Query

**Visual transforms → real dbt.** A local desktop workbench for data engineers: multi-source pipelines, instant DuckDB preview, export a project you can `dbt run` without hand-edits.

Raw data stays on your machine. No cloud account required.

<p align="center">
  <img src="docs/welcome.png" alt="DWHForge Query — visual workspace" width="900" />
</p>

```text
  CSV · Parquet · PostgreSQL
            │
            ▼
   Visual workspace (PQ-like queries + Join)
            │
            ▼
   DuckDB preview  ≤50 rows
            │
            ▼
   dbt project  (staging / intermediate / marts)
```

## Why

Most “visual ETL” tools stop at a proprietary graph. DWHForge Query treats the graph as an IR and ships **dbt** as the artifact: `sources.yml`, layered models, `profiles.yml`, ready for your warehouse.

Power Query *mental model* (multi-query, Applied Steps, Merge) — not Power BI reports, not M.

## Features

- **Multi-query workspace** — sources as queries, Join / Append / Filter / GroupBy / free SQL
- **Structural preview** — DuckDB in-process; catch bad joins before you leave the editor
- **dbt export** — runnable project for DuckDB or Postgres target dialect
- **PostgreSQL sources** — first-class (ATTACH + catalog picker); CSV / Parquet / S3 paths
- **Secrets + settings off-project** — `~/.dwhforge-query/secrets.json` and `settings.json` (defaults / last Export dialect); not inside `.dwhproj.json`
- **Offline DuckDB** — bundled engine + sidecar `extensions/` (no CDN install at runtime)

## Quick start

```bash
# Once: DuckDB extensions (needs network)
./scripts/fetch-duckdb-extensions.sh

# Once: local dbt Core 1.x venv for offline `dbt parse` on Export
./scripts/fetch-dbt-venv.sh

# Linux desktop deps (once)
sudo apt update && sudo apt install -y \
  pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev librsvg2-dev \
  patchelf libssl-dev libgtk-3-dev libayatana-appindicator3-dev

npm install
npm run tauri dev
```

After the first `cargo build -p dwh-engine`, sync the shared lib next to binaries:

```bash
./scripts/sync-duckdb-lib.sh
```

DuckDB **v2** via `duckdb-rs` **prebuilt** lib (not Cargo `bundled` — that rebuilds C++ for a long time). Runtime layout: `<app>/extensions/{postgres_scanner,httpfs,aws}.duckdb_extension` — only `LOAD` from that folder ([ADR-0011](docs/adr/0011-offline-duckdb-extensions.md)).

### Headless / CI

```bash
cargo test -p dwh-pipeline

cargo run -p dwh-engine --bin dwh-preview -- fixtures/sample.csv 'amount > 1000'

cargo run -p dwh-engine --bin dwh-preview -- --join \
  fixtures/sample.csv fixtures/dim_region.csv region

# Same IR as UI Export (optional offline parse — needs dbt on PATH or fetch-dbt-venv.sh)
cargo run -p dwh-pipeline --bin dwh-export -- \
  path/to/project.dwhproj.json /tmp/dwh-out --validate
```

UI **Export** always writes the tree then runs offline `dbt parse` (no warehouse). `dbt run` stays on the target machine / CI:

```bash
cd /tmp/dwh-out/<project_name> && dbt run --profiles-dir ./
```

### VS Code / Cursor

[`.vscode/launch.json`](.vscode/launch.json) — **DWHForge Query: Tauri Dev** (LLDB + Vite), headless `dwh-preview`, tasks for pipeline tests. Extensions: [`.vscode/extensions.json`](.vscode/extensions.json).

## Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri 2 |
| UI | React + TypeScript + Vite |
| IR / export | Rust (`dwh-pipeline`) |
| Preview | DuckDB (`dwh-engine`) |
| Artifact | dbt Core project |

```text
crates/dwh-pipeline   Workspace, steps, compiler, DbtProducer, dwh-export
crates/dwh-engine     DuckDB session, preview, dwh-preview
src/                  React UI
src-tauri/            Tauri IPC
fixtures/  docs/
```

## Naming

| | |
|--|--|
| Product | **DWHForge Query** |
| Secrets / settings | `~/.dwhforge-query/` (`secrets.json`, `settings.json`) |
| App id | `com.dwhforge.query` |
| Repo (legacy path) | `dwh-rs-query` |

## Docs

| | |
|--|--|
| [DESIGN](docs/DESIGN.md) | Product horizons, UX north star |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Modules, Workspace IR |
| [SPEC](docs/SPEC.md) | Contracts, commands, dbt DoD |
| [DEMOS](docs/DEMOS.md) | Demo workspaces · practice coverage |
| [COMPETITIVE](docs/COMPETITIVE.md) | Landscape & wedge |
| [adr/](docs/adr/) | Decisions |

## Download

- Site: [dwhforge.github.io/query](https://dwhforge.github.io/query/) (latest AppImage / `.deb` / `.rpm`)
- GitHub Releases: [dwhforge/query/releases](https://github.com/dwhforge/query/releases)

| Package | Use on |
|---------|--------|
| `.tar.gz` | **No sudo** — unpack, `./DWHForge-Query` |
| `.deb` | Debian / Ubuntu |
| `.rpm` | RHEL / Rocky / Alma / Fedora (`sudo` required to install) |

Linux builds ship **offline**: bundled DuckDB shared lib + `extensions/` (no CDN at runtime).

## License

[MIT](LICENSE)
