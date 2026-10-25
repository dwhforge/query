# DWH-RS-QUERY

Local desktop ETL/transform workbench: **Tauri + React/TS + Rust + DuckDB**.  
Workspace AST → CTE SQL → preview ≤50 rows → **dbt export**. Sources: **CSV, Parquet, PostgreSQL (required)**. Raw data stays on-device.  
**Bundled DuckDB + sidecar `extensions/`:** no CDN install. After clone (once, needs network):

```bash
./scripts/fetch-duckdb-extensions.sh
```

DuckDB **v2.0** via `duckdb-rs` **prebuilt** shared lib (not the `bundled` Cargo feature — that recompiles C++ for ages). After first `cargo build -p dwh-engine`, run `./scripts/sync-duckdb-lib.sh` so `libduckdb.so` sits next to binaries. Layout at runtime: `<app>/extensions/{postgres_scanner,httpfs,aws}.duckdb_extension` — only `LOAD` from that folder ([ADR-0011](docs/adr/0011-offline-duckdb-extensions.md)). Local Parquet = core; **S3** needs `httpfs`.

**Licensing:** open-source is under consideration and **not decided**. Documentation is in English to stay OSS-ready.

## Docs

| Document | Contents |
|----------|----------|
| [docs/DESIGN.md](docs/DESIGN.md) | Product design, horizons (dbt → PQ → two-way), UX north star |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, Workspace IR, invariants |
| [docs/SPEC.md](docs/SPEC.md) | Contracts, commands, dbt DoD |
| [docs/DEMOS.md](docs/DEMOS.md) | Demo workspaces · dbt practice coverage (A/B/C) |
| [docs/COMPETITIVE.md](docs/COMPETITIVE.md) | Landscape, wedge, DE/DBA/developer positioning |
| [docs/adr/](docs/adr/) | ADRs (positioning, multi-query, join, two-way, UX) |
| [docs/TZ-EARLY.md](docs/TZ-EARLY.md) | Archived early design brief |

## Naming

| Layer | Name |
|-------|------|
| Product / UI / docs | **DWH-RS-QUERY** |
| Repo / npm / Cargo | `dwh-rs-query` |
| Tauri identifier | `com.dwhrsquery.app` |

## Layout

```
crates/dwh-pipeline   # Workspace, steps, GraphCompiler, DbtProducer, CLI dwh-export
crates/dwh-engine     # DuckDB session + preview + CLI dwh-preview
src/                  # React UI (queries, join, preview, export)
src-tauri/            # thin Tauri IPC
fixtures/
docs/
```

### Commands

```bash
# Compiler / dbt-producer unit tests
cargo test -p dwh-pipeline

# Headless preview
cargo run -p dwh-engine --bin dwh-preview -- fixtures/sample.csv 'amount > 1000'

# Join smoke
cargo run -p dwh-engine --bin dwh-preview -- --join fixtures/sample.csv fixtures/dim_region.csv region

# Export dbt from a saved .dwhproj.json (same IR as UI Export)
cargo run -p dwh-pipeline --bin dwh-export -- path/to/project.dwhproj.json /tmp/dwh-out

# Desktop app — Linux system deps (once), one line:
sudo apt update && sudo apt install -y pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev librsvg2-dev patchelf libssl-dev libgtk-3-dev libayatana-appindicator3-dev

npm install
npm run tauri dev
```

### VS Code / Cursor

See [`.vscode/launch.json`](.vscode/launch.json):

- **DWH-RS-QUERY: Tauri Dev** — LLDB + `ui:dev` (Vite :1420)
- **dwh-preview (sample.csv)** — headless DuckDB smoke
- **npm: tauri dev** — full desktop without LLDB
- Tasks: `cargo: test dwh-pipeline`, `smoke: dwh-preview sample`

Recommended extensions: `.vscode/extensions.json` (rust-analyzer, CodeLLDB, Tauri).
