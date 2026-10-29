# DWHForge Query

**Visual pipelines → real dbt → your warehouse.**

A local desktop workbench for data engineers: multi-source transforms with a Power Query–like mental model, instant DuckDB preview, and export of a **runnable dbt project**—not a proprietary runtime lock-in.

Raw data and secrets stay on your machine. No cloud account required.

<p align="center">
  <img src="docs/welcome.png" alt="DWHForge Query — visual workspace" width="900" />
</p>

```text
  CSV · Parquet · S3 · PostgreSQL · DuckDB files
                    │
                    ▼
         Visual workspace  (queries · Join · KeyMap · Derive)
                    │
                    ▼
         DuckDB preview  (structural, fast)
                    │
                    ▼
         dbt project   staging / intermediate / marts
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    local.duckdb         PostgreSQL
    (working)            (published marts)
```

## Why this exists

Most visual ETL tools stop at a proprietary graph. DWHForge Query treats the graph as an IR and ships **dbt** as the artifact: layered models, seeds, `sources.yml`, `profiles.yml`—ready for Git, CI, and `dbt build`.

- **Power Query path** (multi-query, Applied Steps, Merge)—not Power BI reports, not M.
- **Engine ≠ destination** — author SQL for DuckDB while landing **published** marts in PostgreSQL via ATTACH (no forced CSV landing).
- **Return-and-edit** — re-export safely; generator-owned files are hash-tracked.

## Highlights

| Capability | What you get |
|------------|----------------|
| **Multi-query workspace** | Sources as queries; Join / Append / Filter / GroupBy / Derive / free SQL |
| **Join lens & KeyMap** | Diagnose unmatched keys; alias tables as dbt seeds |
| **Four export routes** | DuckDB↔DuckDB, Files→PG (ATTACH), DuckDB→PG, PG→PG |
| **Publish controls** | Mark queries **Publish to destination** → `mart_*` in the warehouse |
| **Export → Parse → Build** | Progress UI; Build runs `dbt build` with DSN from your connection |
| **Secrets off-project** | `~/.dwhforge-query/secrets.json` — not inside `.dwhproj.json` |
| **Offline DuckDB** | Bundled engine + `extensions/` (no CDN at runtime) |

## Quick start

**From source**

```bash
./scripts/fetch-duckdb-extensions.sh   # once (network)
./scripts/fetch-dbt-venv.sh            # once — local dbt Core 1.x + duckdb/postgres adapters
npm install
cargo build -p dwh-host --release
./scripts/sync-duckdb-lib.sh
npm run electron:dev
```

**After the window opens**

1. Help → Load demo (e.g. **Key mapping**).
2. Project → set **execution engine** and **destination** (for Files→Postgres: engine DuckDB, destination PostgreSQL + connection).
3. Inspector → **Publish to destination** on marts you want in the warehouse.
4. File → **Export dbt…** → **Build export…**.

Full post-install guide (where dbt lives, DSN, portable layout, troubleshooting):

→ **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**  
→ **[docs/export-and-run.md](docs/export-and-run.md)** (routes, marts vs stg/int, ATTACH)

### Headless / CI

```bash
cargo test -p dwh-pipeline
cargo test -p dwh-engine --lib

# IR export + optional offline parse
cargo run -p dwh-pipeline --bin dwh-export -- \
  path/to/project.dwhproj.json /tmp/dwh-out --validate

# DuckDB→Postgres ATTACH smoke (needs DWH_PG_DSN + dbt-venv)
DWH_PG_DSN='postgresql://…' ./scripts/ci-duckdb-pg-attach.sh
```

## Architecture (short)

| Layer | Choice |
|-------|--------|
| Shell | Electron + Rust `dwh-host` sidecar |
| UI | React · TypeScript · Vite |
| IR / export | `dwh-pipeline` |
| Preview | DuckDB (`dwh-engine`) |
| Artifact | dbt Core 1.x project |

```text
crates/dwh-pipeline   Workspace IR, emit, DbtProducer
crates/dwh-engine     DuckDB session, preview, join lens
crates/dwh-host       JSON-RPC sidecar (export / parse / build)
electron/             Desktop shell
src/                  React UI
docs/                 Product + ADRs + getting started
```

## Docs map

| Doc | Contents |
|-----|----------|
| [GETTING_STARTED](docs/GETTING_STARTED.md) | Install → dbt-venv → first Export/Build |
| [export-and-run](docs/export-and-run.md) | Routes, publish/marts, ATTACH, progress ops |
| [DESIGN](docs/DESIGN.md) | Product horizons & DoD |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Modules & IR |
| [DEMOS](docs/DEMOS.md) | Demo workspaces |
| [adr/](docs/adr/) | Decisions (0014 engine×destination, 0017 parse gate, 0018 return-and-edit, 0020 KeyMap, …) |

## Download

- Site: [dwhforge.github.io/query](https://dwhforge.github.io/query/)
- Releases: [github.com/dwhforge/query/releases](https://github.com/dwhforge/query/releases)

| Package | Platform |
|---------|----------|
| `*-electron-linux-x64.tar.gz` | Linux — unpack, `./DWHForge-Query` |
| `*-electron-windows-x64.zip` | Windows — unpack, `DWHForge-Query.cmd` |

Linux **glibc ≥ 2.28**. After unpack, run `./scripts/fetch-dbt-venv.sh` in the tree (or ship `dbt-venv/`) so Parse/Build find dbt.

## License

[MIT](LICENSE)
