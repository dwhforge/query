# OpenCode Web / CLI ↔ DWHQuery (experimental, single-user)

This integration lets a user describe a **business data task in ordinary language**. OpenCode V2 decides which of the `dwhquery_*` tools to call; DWHQuery owns the project IR, Rust compilation, DuckDB preview and JOIN diagnostics. The same server-side plugin works in the OpenCode browser UI and terminal UI. There is no second agent runtime, no MCP server, and no DWHQuery-specific prompt required from the user.

## Prerequisites

- An installed **OpenCode 2.x** with a configured model provider (not bundled, configured or authenticated by this patch)
- Node.js 20+, npm dependencies for the existing DWHQuery CLI, built Rust Host, and access to the user's permitted CSV/Parquet/Postgres sources
- A **dedicated Linux user and business workspace**, separate from the DWHQuery source checkout. This is a one-user evaluation; OpenCode is not treated as a multi-tenant sandbox.

In the DWHQuery checkout (`feature/matching_redesign`):

```bash
npm ci
npm run cli:build
cargo build -p dwh-host --release
mkdir -p /tmp/dwhq-business-test
cp examples/opencode-sales/*.csv /tmp/dwhq-business-test/
node scripts/install-opencode-dwhquery.mjs /tmp/dwhq-business-test
```

The installer copies a **V2 server plugin** and a discoverable `dwhquery` skill into that business workspace under `.opencode/`. It writes `.opencode/dwhquery-adapter.json` with absolute CLI and Host paths. It refuses mismatched existing adapter files and symlinked `.opencode` paths. It does **not** install OpenCode or select a model. Override binary locations with `DWHQ_CLI_BIN` and `DWHQ_HOST_BIN` when installing.

## Start the browser UI securely

On the Linux server, run the following in the DWHQuery checkout. Enter the password interactively rather than putting it in shell history:

```bash
read -rsp 'OpenCode password (16+ chars): ' OPENCODE_PASSWORD; echo
export OPENCODE_PASSWORD
node scripts/run-opencode-dwhquery-web.mjs /tmp/dwhq-business-test
```

For the bundled CSV benchmark, set `DWHQ_ALLOW_SQL=1` in this server environment if you want the agent to author SQL-expression transformations (not a SQL sandbox). Raw row access requires the separate, deliberate `DWHQ_ALLOW_ROW_DATA=1` opt-in and a permission check.

This launcher checks that OpenCode **V2** is installed and runs its official `serve` mode on **127.0.0.1:4096 only**. It requires a password and does not print it. Override the port with `DWHQ_OPENCODE_PORT=4097` if necessary. The launcher has no automatic public binding, reverse proxy or multi-user mode. OpenCode's web UI is served by the same server as its terminal backend; the official documentation describes both `serve` and browser access: <https://opencode.ai/docs/cli/web/>.

From your laptop, create an SSH tunnel:

```bash
ssh -N -L 4096:127.0.0.1:4096 user@your-linux-server
```

Then open **http://127.0.0.1:4096** in the laptop browser and authenticate with the server password. Do not expose TCP 4096 directly to the public internet. If a real HTTPS deployment is later required, use a separately reviewed reverse proxy with authentication, TLS and per-user isolation. In particular, **do not expose the OpenCode API to untrusted users**: OpenCode still has powerful built-in shell and file tools.

Terminal users can use the same installed business workspace:

```bash
cd /tmp/dwhq-business-test
opencode
```

No Electron process is necessary to create the project. Open the resulting DWHQuery `.json` project later in the IDE, on a machine that can access its data paths (copy/rebind files as needed).

## First business-language test

Start a new OpenCode Web session and ask, without naming DWHQuery:

> Есть продажи (`sales.csv`) и справочник товаров (`products.csv`). Построй расчёт продаж по категориям, проверь, не теряются ли продажи из-за несовпадающих кодов. Не придумывай соответствия без доказательств. Сохрани воспроизводимый результат, укажи расхождения и ограничения проверки.

The fixture intentionally has an unmatched sale (see `examples/opencode-sales/README.md`). Expected outcomes are a **validated saved DWHQuery project**, an explanation of dropped/unmatched amounts and a clear distinction between established matches and assumptions. The agent may need to ask about business semantics; do not optimize for always reporting success. Record transcript, model/version, elapsed time, tool calls and result accuracy. Compare the same prompt with OpenCode **without** DWHQuery tools.

## Registered tools and boundaries

The V2 server plugin registers 14 tools under the `dwhquery` namespace: `capabilities`, `project_create`, `project_inspect`, `connection_add`, `query_add`, `query_derive`, `query_step`, `query_join`, `query_focus`, `query_describe`, `query_preview`, `join_diagnose`, `project_validate`, `project_export`. It follows the official `ctx.tool.transform` plugin API: <https://opencode.ai/docs/build/plugins/server/>.

Each tool calls `spawn(process.execPath, [cli, ...argv])` with **no shell**. Inputs use JSON Schemas; paths are constrained to the business workspace (including symlink resolution). No agent can call arbitrary Rust Host RPC through these tools. Results are bounded in size/time and operations support cancellation. IDs should be read from `project_inspect`; generated IDs must not be guessed.

- Project writes: only projects created by the CLI can be modified by default, via its UID ownership marker. Editing any other project requires **operator-set** `DWHQ_ALLOW_EXISTING_PROJECT_EDITS=1`. The CLI uses a file lock/checksum but does not provide a transaction against a concurrently open Electron session.
- SQL expressions: `Filter`, SQL-mode `DeriveColumn` etc. require **operator-set** `DWHQ_ALLOW_SQL=1`; that is an opt-in, **not** SQL sandboxing. Use read-only external database credentials.
- PostgreSQL connections: use a pre-provisioned environment variable name such as `DWHQ_PG_CONTRACTS_DSN`. Do not put DSNs or passwords into user prompts, source files or tool arguments.
- Rows: previews and JOIN diagnostics return summary counts without row values by default. `includeRows: true` requires both **operator-set** `DWHQ_ALLOW_ROW_DATA=1` and an OpenCode `dwhquery_row_data` permission check (`ask` unless a rule overrides it). This may transmit confidential data to the selected model. Avoid granting it for real sensitive datasets without reviewing model/privacy controls and other OpenCode permissions.
- Publishing: `project_export` creates dbt files in a new or empty directory; it does **not** run dbt build, modify external warehouse tables or confirm business correctness.

**This plugin does not confine OpenCode itself.** The agent still has other built-in tools such as `shell`, `read`, and `write`. For restrictive operation, use OpenCode `permissions`/`policies`, process-level OS isolation, dedicated credentials, and a dedicated Linux user; tool-scoped path validation alone is not a sandbox. See <https://opencode.ai/docs/permissions/>.

## Verification

```bash
node --test tests/opencode-dwhquery.spec.mjs
npm run cli:test
```

Adapter tests use a fake CLI and mock OpenCode V2 tool editor; web-launcher tests use a fake OpenCode binary. **They do not prove a real OpenCode V2 plugin load or a Rust/DuckDB E2E run**. Acceptance requires an installed OpenCode 2.x, model-provider credentials, real Host + CSV fixture, browser tool discovery, saved project, dbt export, and opening the project in Electron. These dependencies were not exercised by the adapter unit tests.

### Not implemented

No automatic Mapping correction, external database writes, `dbt build`, project-wide ChangeSet, cross-process atomic Save, multi-tenant server isolation, durable agent task state or MCP transport. Those require their own product/permission contracts and real E2E verification.
