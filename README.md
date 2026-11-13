<div align="center">

# DWHForge Query

### Find the join gap. Keep the correction. Ship SQL/dbt.

A local desktop workbench for investigating mismatched identifiers, editing reusable mappings, and checking the resulting calculation before exporting SQL/dbt.

[![License: BSL 1.1](https://img.shields.io/badge/license-BSL_1.1-14b8a6)](LICENSE)
[![dbt Core 1.x](https://img.shields.io/badge/dbt_Core-1.x-ff694b)](docs/export-and-run.md)
[![Powered by DuckDB](https://img.shields.io/badge/powered_by-DuckDB-fff000)](docs/ARCHITECTURE.md)
[![Early development](https://img.shields.io/badge/status-early_development-64748b)](#project-status)

**[Try the offline lab](#try-it-offline-shipments--sales)** · **[Get started](#get-started)** · **[Downloads](https://github.com/dwhforge/query/releases)** · **[Documentation](docs/GETTING_STARTED.md)** · **[Development notes](docs/RELEASE_NOTES.md)**

<img src="docs/stabilization/flagship-join-lens.png" alt="Actual offline Shipments ↔ sales lab: task card, original Join, No match keys, partial mapping, and a labelled sample preview" width="1100" />

**Different SKU codes → inspect unmatched keys → save a mapping → recompute the example and reconciliation.**

</div>

*Actual Electron development-build screenshot, not a mockup. Task card, opt-in
hints and preview-state polish describe this reviewed development checkout;
downloaded releases and main may be older until these commits are published.
See [build status and boundaries](docs/RELEASE_NOTES.md).*

## From messy inputs to a pipeline you can keep

Two feeds spell the same company differently. A join drops records. A business rule changes a week after the first export.

DWHForge Query gives you a visual place to investigate and edit those transformations—with SQL you can inspect and a dbt project you can run in your own infrastructure.

- **Know what you are looking at.** Data labels the query result or selected Join scope, sample/full mode, and running/cancelled/error states.
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
| Fix inconsistent identifiers | Editable From → To Mappings, reusable across queries and exported as dbt seeds |
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

## Try it offline: shipments ↔ sales

Sales uses commercial SKU codes; the plant reference uses product IDs. A plain
Join leaves keys unmatched. The bundled **Shipments ↔ sales** lab lets you inspect
the evidence, extend a partial mapping and compare the actual query outputs.

1. Open **Help → Help Lab… → Shipments ↔ sales → Open lab**. Save current work or cancel if prompted; the lab is a separate unsaved project.
2. Read **Why don't these SKUs match?** and choose **Show me where to start**, or manually select the original Join and **Data → Join Lens → No match**. The optional hint stops at No match.
3. Use **Inspect mapped example** and **Inspect monthly reconciliation**. The mapped pipeline is a **pre-existing, partial example**, not a fix performed for you.
4. In **Mappings → Commercial SKU → plant product**, add **COM-AMM → AMM-A** using **Add row**, then **Save map**. Reopen the mapped example and **Recompute**; inspect the changed rows, then the monthly gaps. Do not guess a mapping for NEW-BLEND without a reference product.
5. **File → Save as…** keeps your own project. Export/Parse/Build are optional next steps, not requirements for trying the lab.

**No PostgreSQL, LLM provider, account, fixture-generation script or dbt build is
needed for this offline lab.** A clean sample is not full-input proof. On an older
build without the task card, the same queries and manual Lens path remain the starting point.

[Offline walkthrough →](docs/GETTING_STARTED.md#2-first-launch--offline-lab) · [Other labs and prerequisites →](docs/DEMOS.md) · [Publish to PostgreSQL later →](docs/export-and-run.md)

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
├── seeds/               # Seed-backed Mappings
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

Prerequisites: **Git, Node.js 20+, npm, stable Rust and a working native linker**.
The commands below use Linux/Bash. First-time package, Rust and extension downloads
need network access; the prepared flagship runs locally afterward. Python/venv
and dbt are needed only when you choose Parse/Build.

```bash
git clone --branch main https://github.com/dwhforge/query.git
cd query

# One-time preview extension setup; not a cloud service at runtime.
./scripts/fetch-duckdb-extensions.sh

npm ci
cargo build -p dwh-host --release
./scripts/sync-duckdb-lib.sh
npm run electron:dev
```

The remote default branch is **main**, a development baseline—not a promise that
it matches a released package. For a release-matched source build, check out that
release's tag. The screenshot UX was validated on **feature/matching**; use the
reviewed checkout containing these commits for the exact new card/hints/preview
behavior. This documentation does not claim unpublished local commits can be
downloaded from main or an older tag.

Optional later: [install dbt](docs/GETTING_STARTED.md#3-install-dbt-required-for-parse--build)
for Parse/Build; it is not needed for the offline preview walkthrough.

### Desktop packages

Check [GitHub Releases](https://github.com/dwhforge/query/releases) for available packages. Source-branch features may be ahead of packaged builds.

- **Linux x64:** unpack the Electron archive and run `./DWHForge-Query`.
- **Windows x64:** when available, unpack the Electron archive and run `DWHForge-Query.cmd`.

Linux packages target **glibc ≥ 2.28**. Preview engine extensions are bundled with desktop packages; dbt is a separate local environment needed for Parse / Build. See the [installation and troubleshooting guide](docs/GETTING_STARTED.md).

### Local by design

The desktop app connects directly to the files, databases, and storage you configure. Connection secrets are stored separately from project files, in `~/.dwhforge-query/secrets.json`. No DWHForge-hosted service is required to edit, preview, export, or build.

## Project status

**Early development.** The current focus is the complete edit → preview → export → build loop on DuckDB and PostgreSQL.

- **Available in the reviewed checkout:** visual multi-query authoring, Join Lens key/row evidence, existing Mapping editor, offline flagship task + opt-in hints, honest comparison navigation, labelled preview states, dbt export and build controls. Release availability depends on the selected tag.
- **In progress / limited preview:** broader Join Debugger investigation and contextual Matching, including optional LLM-assisted paths. They are not a universal debugger, automatic reconciliation, or a durable resumable Matching workplace. The flagship walkthrough makes no LLM calls.
- **Not available as a finished workflow:** arbitrary dbt repository round-trip. General IDE guidance and automatic cloud/LLM graph editing are outside this batch, not promises implied by the local lab hints.
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
