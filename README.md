# DWH-RS-QUERY

Локальный desktop ETL/transform workbench: **Tauri + React/TS + Rust + DuckDB**.  
Пайплайн = AST шагов → CTE SQL → preview ≤50 строк. Сырые данные не уходят в облако.

## Docs

| Document | Contents |
|----------|----------|
| [docs/DESIGN.md](docs/DESIGN.md) | Product design, UX MVP, scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data flow, invariants |
| [docs/SPEC.md](docs/SPEC.md) | Contracts, Tauri commands, producers, DoD |
| [docs/TZ-EARLY.md](docs/TZ-EARLY.md) | Archived early design brief |

## Naming

| Layer | Name |
|-------|------|
| Product / UI / docs | **DWH-RS-QUERY** |
| Repo / npm / Cargo | `dwh-rs-query` |
| Tauri identifier | `com.dwhrsquery.app` |

## Prototype (vertical slice)

```
crates/dwh-pipeline   # TransformationStep + CTE compiler
crates/dwh-engine     # DuckDB session + preview + CLI dwh-preview
src/                  # React UI (History, Filter, virtual Preview)
src-tauri/            # thin Tauri IPC → dwh-engine
fixtures/sample.csv
```

### Commands

```bash
# Compiler unit tests (no GUI deps)
cargo test -p dwh-pipeline

# Headless smoke preview
cargo run -p dwh-engine --bin dwh-preview -- fixtures/sample.csv 'amount > 1000'

# Desktop app — Linux system deps (once):
sudo apt install -y \
  pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev \
  librsvg2-dev patchelf libssl-dev libgtk-3-dev \
  libayatana-appindicator3-dev

npm install
npm run tauri dev
```

### VS Code / Cursor

См. [`.vscode/launch.json`](.vscode/launch.json):

- **DWH-RS-QUERY: Tauri Dev** — LLDB + `ui:dev` (Vite :1420)
- **dwh-preview (sample.csv)** — headless DuckDB smoke
- **npm: tauri dev** — полный desktop без LLDB
- Tasks: `cargo: test dwh-pipeline`, `smoke: dwh-preview sample`

Рекомендуемые расширения: `.vscode/extensions.json` (rust-analyzer, CodeLLDB, Tauri).
