/** Opt-in real Rust Host + DuckDB smoke test, not a fake-host/unit test. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runReal = process.env.DWHQ_RUN_REAL_E2E === "1";
const cli = resolve("dist/dwhq.mjs");
const host = resolve(process.env.DWHQ_HOST_BIN || "target/release/dwh-host");
function invoke(...argv) {
  const cmd = spawnSync(process.execPath, [cli, ...argv], {
    encoding: "utf8", timeout: 60_000,
    env: {...process.env, DWHQ_HOST_BIN: host, DWHQ_ALLOW_SQL: "1", DWHQ_ALLOW_ROW_DATA: "1"},
  });
  assert.equal(cmd.status, 0, `${argv.slice(0, 2).join(" ")} failed: ${cmd.stderr}\n${cmd.stdout}`);
  const result = JSON.parse(cmd.stdout.trim());
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test("real Rust Host + DuckDB: CSV → JOIN → GroupBy → preview → dbt export", {skip: !runReal}, () => {
  assert.ok(existsSync(cli), "Build CLI first: npm run cli:build");
  assert.ok(existsSync(host), "Build Rust Host first: cargo build -p dwh-host --release");
  const temp = mkdtempSync(join(tmpdir(), "dwhq-sales-real-e2e-"));
  try {
    for (const name of ["sales.csv", "products.csv"])
      copyFileSync(resolve("examples/opencode-sales", name), join(temp, name));
    const project = join(temp, "sales.json");
    invoke("project", "create", "--project", project, "--name", "Sales by category");
    invoke("query", "add", "--project", project, "--name", "Sales", "--csv", join(temp, "sales.csv"));
    invoke("query", "add", "--project", project, "--name", "Products", "--csv", join(temp, "products.csv"));
    const p = invoke("project", "inspect", "--project", project).summary.queries;
    const sales = p.find(q => q.name === "Sales")?.id;
    const products = p.find(q => q.name === "Products")?.id;
    assert.ok(sales && products, "Query IDs must be inspected, not guessed");
    invoke("query", "join", "--project", project, "--query", sales,
      "--right", products, "--on", JSON.stringify([{left: "sku", right: "sku"}]), "--join-type", "left");
    const coverage = invoke("join", "diagnose", "--project", project, "--query", sales, "--index", "1");
    assert.equal(coverage.metrics.unmatched_left_count, 1);
    invoke("query", "group-by", "--project", project, "--query", sales,
      "--dimensions", JSON.stringify(["category"]),
      "--aggregates", JSON.stringify(["COUNT(*) AS n_sales", "SUM(units) AS units", "SUM(amount) AS amount"]));
    const validated = invoke("project", "validate", "--project", project);
    assert.equal(validated.valid, true);
    const preview = invoke("query", "preview", "--project", project, "--query", sales, "--include-rows");
    const columns = preview.columns.map(col => typeof col === "string" ? col : col.name);
    const objects = preview.rows.map(row => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
    assert.equal(objects.length, 3, JSON.stringify(objects));
    assert.equal(objects.reduce((sum, row) => sum + Number(row.amount), 0), 510);
    assert.equal(Number(objects.find(row => row.category === "Beverages")?.amount), 270);
    assert.equal(Number(objects.find(row => row.category === "Groceries")?.amount), 80);
    assert.equal(Number(objects.find(row => row.category == null)?.amount), 160);
    assert.equal(objects.reduce((sum, row) => sum + Number(row.n_sales), 0), 4);
    const exported = invoke("project", "export", "--project", project, "--output-dir", join(temp, "dbt_export"));
    assert.equal(exported.dbtBuildExecuted, false);
    assert.ok(exported.files.length > 0, "dbt export should produce models");
    const saved = JSON.parse(readFileSync(project, "utf8"));
    assert.equal(saved.workspace.queries.find(q => q.id === sales)?.steps.at(-1).type, "GroupBy");
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});
