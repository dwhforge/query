/** PoC contract test with a loopback fake Host (not an end-to-end DuckDB test). */
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const cli = resolve("dist/dwhq.mjs");
const fakeHostCode = `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const server = net.createServer(socket => {
  let data = Buffer.alloc(0);
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    while (data.length >= 4) {
      const len = data.readUInt32LE(0);
      if (data.length < len + 4) break;
      const msg = JSON.parse(data.subarray(4, len+4).toString('utf8'));
      data = data.subarray(len+4);
      let result;
      try {
        if (msg.cmd === 'save_project_tool') {
          fs.writeFileSync(msg.args.path, JSON.stringify(msg.args.project));
          result = msg.args.project;
        } else if (msg.cmd === 'load_project') {
          result = JSON.parse(fs.readFileSync(msg.args.path, 'utf8'));
        } else if (msg.cmd === 'describe_workspace') {
          result = {columns: [{name: 'contract_id', type: 'VARCHAR'}], rows: [], sql: ''};
        } else if (msg.cmd === 'preview_workspace') {
          result = {columns: [{name: 'contract_id', type: 'VARCHAR'}], rows: [['secret-row']], sql: 'SELECT 1'};
        } else if (msg.cmd === 'join_diagnostics') {
          result = {left_count: 5, right_count: 4, unmatched_left_count: 1, unmatched_left: {rows: [['secret-join-row']]}, unmatched_right: {rows: []}, fanout_pairs: {rows: []}, right_dup_keys: {rows: []}, sql_counts: ''};
        } else if (msg.cmd === 'export_dbt') {
          result = {path: msg.args.outputDir + '/example', files: ['dbt_project.yml']};
        } else throw Error('Unsupported mock command ' + msg.cmd);
        const payload = Buffer.from(JSON.stringify({id: msg.id, ok: true, result}));
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length, 0); payload.copy(frame, 4); socket.write(frame);
      } catch(e) {
        const payload = Buffer.from(JSON.stringify({id: msg.id, ok: false, error: e.message}));
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length, 0); payload.copy(frame, 4); socket.write(frame);
      }
    }
  });
});
server.listen(0, '127.0.0.1', () => console.log('DWH_HOST_READY tcp ' + server.address().port));
`;

function invokeWithEnv(host, overrides, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {encoding: "utf8", env: {...process.env, DWHQ_HOST_BIN: host, ...overrides}, timeout: 20_000});
  const output = JSON.parse(result.stdout.trim());
  return {status: result.status, output};
}

function invoke(host, ...args) { return invokeWithEnv(host, {}, ...args); }

test("agent creates a project, queries, a JOIN, aggregates, and previews without leaking rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "dwhq-agent-poc-"));
  try {
    const host = join(dir, "fake-host.cjs");
    writeFileSync(host, fakeHostCode); chmodSync(host, 0o700);
    const project = join(dir, "revenue.json");
    const csv = join(dir, "payments.csv");
    writeFileSync(csv, "contract_id,amount\na1,42\n");
    const create = invoke(host, "project", "create", "--project", project, "--name", "Monthly receipts");
    assert.equal(create.status, 0, JSON.stringify(create.output));
    assert.equal(create.output.created, true);
    assert.equal(invoke(host, "project", "create", "--project", project, "--name", "Another").status, 1);
    assert.equal(invoke(host, "query", "add", "--project", project, "--name", "Payments", "--csv", csv).status, 0);
    assert.equal(invoke(host, "query", "add", "--project", project, "--name", "Contracts", "--csv", csv).status, 0);
    const unsafe = invoke(host, "query", "step", "--project", project, "--query", "q_payments", "--step", JSON.stringify({type: "Filter", payload: {condition: "true"}}));
    assert.equal(unsafe.status, 1);
    const data = JSON.parse(readFileSync(project, "utf8"));
    assert.equal(data.workspace.queries.length, 2);
    const [left, right] = data.workspace.queries.map(q => q.id);
    const joined = invoke(host, "query", "join", "--project", project, "--query", left,
      "--right", right, "--on", JSON.stringify([{left: "contract_id", right: "contract_id"}]));
    assert.equal(joined.status, 0, JSON.stringify(joined.output));
    const schemas = invoke(host, "tools");
    assert.equal(schemas.status, 0);
    assert.deepEqual(schemas.output.stepSchemas.GroupBy.payload.required, ["dimensions", "aggregates"]);
    assert.deepEqual(schemas.output.stepSchemas.GroupBy.example.payload.aggregates, ["COUNT(*) AS n_sales", "SUM(amount) AS amount"]);
    const missingOptIn = invokeWithEnv(host, {DWHQ_ALLOW_SQL: ""}, "query", "group-by", "--project", project,
      "--query", left, "--dimensions", '["contract_id"]', "--aggregates", '["SUM(amount) AS amount"]');
    assert.equal(missingOptIn.status, 1);
    assert.equal(missingOptIn.output.code, "sql_opt_in_required");
    const badShape = invokeWithEnv(host, {DWHQ_ALLOW_SQL: "1"}, "query", "step", "--project", project,
      "--query", left, "--step", JSON.stringify({type: "GroupBy", payload: {group: ["contract_id"], measures: [{fn: "sum", column: "amount"}]}}));
    assert.equal(badShape.status, 1);
    assert.equal(badShape.output.code, "invalid_step_payload");
    const malformed = invokeWithEnv(host, {DWHQ_ALLOW_SQL: "1"}, "query", "group-by", "--project", project,
      "--query", left, "--dimensions", "not-json", "--aggregates", '["SUM(amount) AS amount"]');
    assert.equal(malformed.status, 1);
    assert.equal(malformed.output.code, "invalid_step_payload");
    const badAlias = invokeWithEnv(host, {DWHQ_ALLOW_SQL: "1"}, "query", "group-by", "--project", project,
      "--query", left, "--dimensions", '["contract_id"]', "--aggregates", '["SUM(amount)"]');
    assert.equal(badAlias.status, 1);
    assert.equal(badAlias.output.code, "invalid_step_payload");
    const unsupported = invoke(host, "query", "step", "--project", project,
      "--query", left, "--step", JSON.stringify({type: "Aggregate", payload: {}}));
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.output.code, "unsupported_step");
    const grouped = invokeWithEnv(host, {DWHQ_ALLOW_SQL: "1"}, "query", "group-by", "--project", project,
      "--query", left, "--dimensions", '["contract_id"]',
      "--aggregates", '["COUNT(*) AS n_sales","SUM(amount) AS amount"]');
    assert.equal(grouped.status, 0, JSON.stringify(grouped.output));
    const inspect = invoke(host, "project", "inspect", "--project", project);
    assert.equal(inspect.status, 0);
    assert.equal(inspect.output.summary.queries[0].steps[1].type, "Join");
    assert.equal(inspect.output.summary.queries[0].steps[2].type, "GroupBy");
    const preview = invoke(host, "query", "preview", "--project", project, "--query", left);
    assert.equal(preview.status, 0);
    assert.equal(preview.output.returnedRows, 1);
    assert.equal(JSON.stringify(preview.output).includes("secret-row"), false);
    const denied = invoke(host, "query", "preview", "--project", project, "--query", left, "--include-rows");
    assert.equal(denied.status, 1);
    const diag = invoke(host, "join", "diagnose", "--project", project, "--query", left, "--index", "1");
    assert.equal(diag.status, 0, JSON.stringify(diag.output));
    assert.equal(diag.output.metrics.unmatched_left_count, 1);
    assert.equal(JSON.stringify(diag.output).includes("secret-join-row"), false);
    const validate = invoke(host, "project", "validate", "--project", project);
    assert.equal(validate.status, 0, JSON.stringify(validate.output));
    assert.equal(validate.output.queries.length, 2);
    const exportResult = invoke(host, "project", "export", "--project", project, "--output-dir", join(dir, "dbt"));
    assert.equal(exportResult.status, 0, JSON.stringify(exportResult.output));
    assert.equal(exportResult.output.dbtBuildExecuted, false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
