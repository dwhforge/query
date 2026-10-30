<div align="center">

# DWHForge Query

### Build visually. Verify on real data. Ship dbt.

A local desktop workbench for turning files and PostgreSQL data into reusable transformations and runnable dbt projects.

[![License: BSL 1.1](https://img.shields.io/badge/license-BSL_1.1-14b8a6)](LICENSE)
[![dbt Core 1.x](https://img.shields.io/badge/dbt_Core-1.x-ff694b)](docs/export-and-run.md)
[![Powered by DuckDB](https://img.shields.io/badge/powered_by-DuckDB-fff000)](docs/ARCHITECTURE.md)
[![Early development](https://img.shields.io/badge/status-early_development-64748b)](#project-status)

**[Get started](#get-started)** · **[Try the demo](#try-it-company-aliases-to-postgresql)** · **[Downloads](https://github.com/dwhforge/query/releases)** · **[Documentation](docs/GETTING_STARTED.md)** · **[Website](https://dwhforge.github.io/query/)**

<img src="docs/welcome.png" alt="DWHForge Query desktop: source explorer, connected query nodes, applied steps, and a data preview" width="1100" />

**Connect your sources. Inspect each step. Fix the joins. Publish your tables.**

</div>

## From messy inputs to a pipeline you can keep

Two feeds spell the same company differently. A join drops records. A business rule changes a week after the first export.

DWHForge Query gives you a visual place to investigate and edit those transformations—with SQL you can inspect and a dbt project you can run in your own infrastructure.

- **See the data behind the graph.** Select a query or an applied step to inspect its intermediate result.
- **Investigate joins where you build them.** Explore matched and unmatched keys, then turn corrections into reusable mappings.
- **Compute where it makes sense.** Use DuckDB to transform files and publish the result to PostgreSQL, or keep both data and execution in PostgreSQL.
- **Keep the result as code.** Export SQL models, dependencies, sources, and mapping seeds. Run them with dbt outside the app.
- **Come back and change it.** Edit the workspace and re-export; hash checks detect hand-edits to generator-owned files before overwriting them.

Built for small data teams, solo engineers, and consultants working with PostgreSQL, file deliveries, and dbt. Licensed under Business Source License 1.1 (converts to Apache-2.0 after four years). No DWHForge account or hosted service required.

## One workspace, from investigation to build

| Your task | In DWHForge Query |
|---|---|
| Bring inputs together | PostgreSQL tables, CSV, Parquet, S3-compatible storage, and DuckDB files |
| Build reusable transformations | Connected queries, applied steps, joins, append, filters, grouping, sorting, and calculated columns |
| Handle everyday calculations | Ready-made operations for common calculations, with an SQL mode for custom expressions |
| Understand a failed match | Join Lens with key investigation and unmatched-row samples |
| Fix inconsistent identifiers | Editable From → To KeyMaps, reusable across queries and exported as dbt seeds |
| Choose what to deliver | Mark output queries **Publish to destination** |
| Execute the exported project | **Export → Parse → Build**, with build progress and logs |

### Compute engine ≠ destination

Writing the result to PostgreSQL does not mean every transformation must execute there.

| Sources | Execution | Destination |
|---|---|---|
| PostgreSQL | dbt-postgres | PostgreSQL |
| Files / S3 | dbt-duckdb | DuckDB |
| Files / S3 | dbt-duckdb | PostgreSQL |
| DuckDB tables | dbt-duckdb | PostgreSQL |

For **files → PostgreSQL**, DuckDB reads and transforms the inputs; dbt builds the published tables through a PostgreSQL attachment. Raw files do not need to be loaded into PostgreSQL first. Staging, intermediate models, and mapping seeds stay in the DuckDB working database.

For **PostgreSQL → PostgreSQL**, dbt-postgres executes the transformations in PostgreSQL.

Custom SQL follows the **execution engine’s dialect**. See [export routes and materialization](docs/export-and-run.md).

## Try it: company aliases to PostgreSQL

The bundled **Key mapping** demo follows two feeds across **15 companies and 60 days**: sales and spending use different names for the same businesses.

1. **Open the problem.** Load **Help → Load demo → Key mapping** and inspect `dirty_join` to see names that do not match the company dimension.
2. **Investigate and map.** Use Join Lens and the KeyMap editor to connect source aliases to canonical company IDs. Reuse the mapping across both feeds.
3. **Inspect the result.** Follow the daily combined data into the monthly rollup; inspect intermediate rows and generated model SQL.
4. **Choose the outputs.** Set execution to **DuckDB**, destination to **PostgreSQL**, select your connection, and mark the daily and monthly queries **Publish to destination**.
5. **Build the tables.** Choose **File → Export dbt…**, then **File → Build export…**. Inspect the published tables in PostgreSQL.

To explore without a PostgreSQL connection, keep the destination set to **DuckDB**.

[Walk through the mapping workflow →](docs/keymap-workflows.md) · [Explore the other demos →](docs/DEMOS.md)

## The output is a dbt project

Export produces a familiar project layout:

```text
my_pipeline/
├── dbt_project.yml
├── profiles.yml
├── models/
│   ├── staging/          # Source models
│   ├── intermediate/     # Shared transformations
│   ├── marts/            # Published outputs
│   └── sources.yml
├── seeds/               # Seed-backed KeyMaps
└── macros/              # Route-specific helpers, when needed
```

Models use `ref()` and `source()` for dependencies. You can inspect the files, commit them to Git, and run the generated project from a terminal or your existing automation.

For a **DuckDB execution → PostgreSQL destination** export:

```bash
cd /path/to/export/my_pipeline
export DWH_PG_DSN='postgresql://user:password@localhost:5432/analytics'
dbt build --profiles-dir .
```

Use a dbt environment with the appropriate adapter installed. Inside the app, **Build export** supplies the destination connection automatically.

**Parse checks project structure. Build executes it.** A successful parse does not establish data correctness; inspect and test the resulting data.

## Get started

### Run from source

Prerequisites: **Git, Node.js 20+, npm, stable Rust, and Python 3 with venv support**. These commands use Bash.

```bash
git clone --branch feature/mapping_tools https://github.com/dwhforge/query.git
cd query

# One-time setup: preview extensions and a local dbt environment.
./scripts/fetch-duckdb-extensions.sh
./scripts/fetch-dbt-venv.sh

npm install
cargo build -p dwh-host --release
./scripts/sync-duckdb-lib.sh
npm run electron:dev
```

The branch above contains the workflow described here. The setup script installs dbt Core 1.x with the DuckDB and PostgreSQL adapters into `dbt-venv/`.

### Desktop packages

Check [GitHub Releases](https://github.com/dwhforge/query/releases) for available packages. Source-branch features may be ahead of packaged builds.

- **Linux x64:** unpack the Electron archive and run `./DWHForge-Query`.
- **Windows x64:** when available, unpack the Electron archive and run `DWHForge-Query.cmd`.

Linux packages target **glibc ≥ 2.28**. Preview engine extensions are bundled with desktop packages; dbt is a separate local environment needed for Parse / Build. See the [installation and troubleshooting guide](docs/GETTING_STARTED.md).

### Local by design

The desktop app connects directly to the files, databases, and storage you configure. Connection secrets are stored separately from project files, in `~/.dwhforge-query/secrets.json`. No DWHForge-hosted service is required to edit, preview, export, or build.

## Project status

**Early development.** The current focus is the complete edit → preview → export → build loop on DuckDB and PostgreSQL.

- **Available:** visual multi-query authoring, step previews, Join Lens, KeyMaps, ready-made calculated operations, dbt export, publish controls, and build execution.
- **Current dbt runtime:** Core **1.x**. dbt **2.0 compatibility is planned**, not yet supported.
- **Current boundary:** the workspace generates its dbt project. Importing and round-tripping arbitrary existing dbt repositories is not supported.
- **Later:** incremental and snapshot configuration, broader testing/profiling surfaces, and richer dbt project integration.

## Under the hood

| Layer | Technology |
|---|---|
| Desktop | Electron + Rust `dwh-host` sidecar |
| Interface | React, TypeScript, React Flow |
| Workspace and SQL generation | Rust `dwh-pipeline` |
| Local preview and investigation | DuckDB / `dwh-engine` |
| Pipeline execution | dbt Core with DuckDB or PostgreSQL adapters |

The workspace is the editable source for visual transformations. Generated SQL remains inspectable. Execution and destination are explicit choices.

## Documentation & contributing

[Getting started](docs/GETTING_STARTED.md) · [Export & run](docs/export-and-run.md) · [Demos](docs/DEMOS.md) · [Architecture](docs/ARCHITECTURE.md) · [Design](docs/DESIGN.md) · [Decisions](docs/adr/)

Real workflows are the most useful feedback: which inputs you used, where a join or mapping became difficult, whether the generated dbt ran, and what happened when you returned to change it.

**[Report a bug or share a workflow](https://github.com/dwhforge/query/issues/new)** · **[Browse issues](https://github.com/dwhforge/query/issues)**

Contributions to transformations, diagnostics, DuckDB/PostgreSQL compatibility, tests, docs, and desktop packaging are welcome. For a larger change, open an issue first to discuss the scope.

```bash
cargo test -p dwh-pipeline
npm run build
```

For engine integration checks and PostgreSQL prerequisites, see [getting started](docs/GETTING_STARTED.md) and [`scripts/ci-duckdb-pg-attach.sh`](scripts/ci-duckdb-pg-attach.sh).

## License

[Business Source License 1.1](LICENSE). Source is available; production use is allowed except competing hosted/SaaS offerings. Each version becomes [Apache License 2.0](LICENSE) four years after it is published.