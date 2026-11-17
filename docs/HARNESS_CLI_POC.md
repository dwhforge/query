# External Harness CLI PoC

Status: **experimental**. External coding agents use this as a tool; the user does not need to know DWHQuery terminology. This is a bounded CLI integration, not an autonomous agent or MCP server.

## Build

```sh
npm ci
npm run cli:build
cargo build -p dwh-host --release
node dist/dwhq.mjs tools
```

`dwh-host` path defaults to `./target/release/dwh-host` from the repository root; override with `DWHQ_HOST_BIN=/absolute/path/to/dwh-host`.

All commands produce one JSON object on stdout and set a nonzero exit code on failure. The CLI launches its own local Host process; Electron is not needed. A new process is used per command, so large projects may have noticeable initialization cost. `tools` returns machine-readable command descriptions for agent tool discovery. The agent owns language understanding, multi-step planning, and its own conversational state.

## Example: a request in business language

User: *“Я хочу увидеть поступления по договорам, проверить потерянные платежи и получить повторяемый расчёт.”*

A coding harness can discover `node dist/dwhq.mjs tools` and issue commands such as:

```sh
node dist/dwhq.mjs project create --project /tmp/receipts.json --name Receipts
node dist/dwhq.mjs query add --project /tmp/receipts.json --name Payments --csv /data/payments.csv
node dist/dwhq.mjs query add --project /tmp/receipts.json --name Contracts --csv /data/contracts.csv
node dist/dwhq.mjs project inspect --project /tmp/receipts.json
# Retrieve generated query IDs from the JSON output; never guess them.
node dist/dwhq.mjs query join --project /tmp/receipts.json --query q_payments --right q_contracts --on '[{"left":"contract_id","right":"contract_id"}]'
node dist/dwhq.mjs project validate --project /tmp/receipts.json
node dist/dwhq.mjs join diagnose --project /tmp/receipts.json --query q_payments --index 1
node dist/dwhq.mjs query preview --project /tmp/receipts.json --query q_payments
node dist/dwhq.mjs project export --project /tmp/receipts.json --output-dir /tmp/receipts_dbt
```

IDs are **illustrative**. The agent must discover generated IDs using `project inspect`. The user can open the saved `.json` project in the desktop IDE. The export writes dbt files but does not run `dbt build` or publish to an external database.

To add a transformation, use the typed query-edit service:

```sh
node dist/dwhq.mjs query step --project /tmp/receipts.json --query q_payments --step '{"type":"SelectColumns","payload":{"columns":["contract_id","amount"]}}'
```

Other commands: `query derive`, `query focus`, `query describe`, `connection add` (Postgres credentials supplied only through `--dsn-env ENV_VAR`). Read `tools` for supported operation names.

## Safety and correctness contract

- The CLI exposes a **fixed allowlist** of operations, not arbitrary Host RPC.
- The CLI writes the specified project file, a small `.dwhq-owned` ownership marker, a temporary `.dwhq.lock` lockfile, and an explicit export directory; Host may also persist connection secrets in its regular local secrets store. Existing export directories containing files are refused. External data writes and `dbt build` are not exposed.
- Project mutations pass through existing QueryEditingService where available. File creation and source-root insertion reuse existing `Project`/`syncSourcesFromQueries` types. Host owns project serialization, secrets and migrations via `save_project_tool`/`load_project`.
- Only CLI-created projects can be modified by default (matching project UID and `.dwhq-owned` sidecar). Editing a pre-existing project requires operator-provided `DWHQ_ALLOW_EXISTING_PROJECT_EDITS=1`. The project mutation lock and checksum detect CLI concurrency and many other writes, but are **not a cross-process atomic transaction** against simultaneous Electron saves. Do not edit the same project in Electron and CLI at once.
- Row values are omitted from previews and JOIN diagnostics by default. Both `--include-rows` and operator-provided `DWHQ_ALLOW_ROW_DATA=1` are required to return samples to an agent. Treat the external harness as a separate data recipient.
- SQL expressions in Filter, GroupBy and SQL-mode DeriveColumn require operator-provided `DWHQ_ALLOW_SQL=1`. This is opt-in, **not** SQL sandboxing; use read-only DB credentials and trusted sources. Arbitrary `CustomSql` and `SqlModel` authoring are not exposed in this PoC.
- Host `describe_workspace` provides actual column/schema checks. The project can still be semantically invalid before `project validate`; QueryEditingService validates graph edits but does not prove executable SQL. Always run validation and diagnosis before delivery.
- `project validate` validates each Query with a real Host call. External data content changes are not protected by Query definition fingerprints.
- `project export` only writes to an empty destination; it does not run parse/build. CLI results never include stored connection strings.

## Scope exclusions for the next iteration

No multi-command atomic ChangeSet; no project-level compare-and-swap commit; no external database mutation; no long-running durable agent task state; no autonomous tool approval policy; no automatic Mapping reconciliation or full-scale matching; no MCP transport. These require separate contracts and end-to-end validation.

## Tests

```sh
npm run cli:build
node --test tests/dwhq-cli.spec.mjs
```

The test uses a loopback fake Host to verify command flow, JSON replies and row suppression. **It is not a Rust/DuckDB E2E test.** For acceptance, run the commands above with the real Host against small CSV fixtures, open the generated project in Electron, validate the JOIN, check dbt export, and compare the output with direct SQL/dbt without DWHQuery.
