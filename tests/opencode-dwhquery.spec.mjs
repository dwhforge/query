/** OpenCode V2 adapter contract against a fake CLI and a mock tool registry. */
import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"

const root = resolve(import.meta.dirname, "..")
const install = join(root, "scripts/install-opencode-dwhquery.mjs")
const fakeCli = `#!/usr/bin/env node
console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2), host: process.env.DWHQ_HOST_BIN, userSqlEnabled: process.env.DWHQ_ALLOW_SQL === '1' }))
`
function fixture() {
  const work = mkdtempSync(join(tmpdir(), "dwhq-opencode-"))
  const business = join(work, "customer")
  mkdirSync(business)
  writeFileSync(join(business, "sales.csv"), "id,amount\na,2\n")
  writeFileSync(join(business, "exists.json"), "{}")
  const cli = join(work, "mock-cli.mjs")
  writeFileSync(cli, fakeCli)
  const host = join(work, "mock-host")
  writeFileSync(host, "fake")
  const result = spawnSync(process.execPath, [install, business], { env: { ...process.env, DWHQ_CLI_BIN: cli, DWHQ_HOST_BIN: host }, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return { work, business, cli, host }
}
async function loadPlugin(business) {
  // OpenCode's runtime provides @opencode/plugin; fake only the registration API here.
  // Preserve plugin file layout so import.meta.url-based workspace paths are real.
  const source = readFileSync(join(business, ".opencode/plugins/dwhquery.js"), "utf8")
  const mock = source.replace('import { Plugin } from "@opencode/plugin"', "const Plugin = { define: (d) => d }")
  assert.notEqual(mock, source)
  const pluginPath = join(business, ".opencode/plugins/dwhquery.mjs")
  writeFileSync(pluginPath, mock)
  const module = await import(pathToFileURL(pluginPath).href)
  const tools = new Map()
  const editor = {
    namespace(def) { assert.equal(def.name, "dwhquery") },
    add(def) { assert.equal(def.options.namespace, "dwhquery"); tools.set(def.name, def) },
  }
  const permissions = []
  await module.default.setup({
    tool: { async transform(fn) { fn(editor) } },
    permission: { async assert(input) { permissions.push(input) } },
  })
  tools.permissions = permissions
  return tools
}
function call(tools, name, args) {
  const spec = tools.get(name)
  assert.ok(spec, `missing tool ${name}`)
  return spec.execute(args, { signal: new AbortController().signal })
}

test("installer installs into an independent workspace and refuses conflicting overwrite", async () => {
  const f = fixture()
  try {
    const config = JSON.parse(readFileSync(join(f.business, ".opencode/dwhquery-adapter.json"), "utf8"))
    assert.equal(config.cli, f.cli)
    assert.equal(config.host, f.host)
    assert.match(readFileSync(join(f.business, ".opencode/skills/dwhquery/SKILL.md"), "utf8"), /natural-language|business/i)
    writeFileSync(join(f.business, ".opencode/plugins/dwhquery.js"), "// keep existing file\n")
    const second = spawnSync(process.execPath, [install, f.business], { env: { ...process.env, DWHQ_CLI_BIN: f.cli, DWHQ_HOST_BIN: f.host }, encoding: "utf8" })
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /Refusing to overwrite/)
  } finally { rmSync(f.work, { recursive: true, force: true }) }
})

test("OpenCode V2 tools use exact typed CLI argv with no shell and suppress row-data flags", async () => {
  const f = fixture()
  try {
    const tools = await loadPlugin(f.business)
    assert.equal(tools.size, 14)
    const res = await call(tools, "query_add", { project: "exists.json", name: "Sales; rm -rf /", sourceKind: "csv", source: "sales.csv" })
    const output = JSON.parse(res.content)
    assert.deepEqual(output.argv.slice(0, 6), ["query", "add", "--project", join(f.business, "exists.json"), "--name", "Sales; rm -rf /"])
    assert.equal(output.argv.at(-1), join(f.business, "sales.csv"))
    assert.equal(output.host, f.host)
    const inspect = JSON.parse((await call(tools, "project_inspect", { project: "exists.json" })).content)
    assert.deepEqual(inspect.argv, ["project", "inspect", "--project", join(f.business, "exists.json")])
    const joinRes = JSON.parse((await call(tools, "query_join", {project: "exists.json", query: "q_sales", right: "q_products", pairs: [{ left: "customer_id", right: "id" }]})).content)
    assert.deepEqual(JSON.parse(joinRes.argv[joinRes.argv.indexOf("--on")+1]), [{ left: "customer_id", right: "id" }])
    const preview = JSON.parse((await call(tools, "query_preview", {project: "exists.json", query: "q_sales"})).content)
    assert.equal(preview.argv.includes("--include-rows"), false)
    const caps = JSON.parse((await call(tools, "capabilities", {})).content)
    assert.deepEqual(caps.argv, ["tools"])
  } finally { rmSync(f.work, { recursive: true, force: true }) }
})

test("path controls reject traversal, symlink escape, and .opencode writes", async () => {
  const f = fixture()
  try {
    symlinkSync(f.work, join(f.business, "escape"), "dir")
    const tools = await loadPlugin(f.business)
    for (const project of ["../outside.json", ".opencode/plugins/evil.json", "escape/evil.json"]) {
      assert.throws(() => call(tools, "project_create", { project, name: "Unexpected" }), /workspace|OpenCode configuration/)
    }
    assert.throws(() => call(tools, "query_add", {project:"exists.json",name:"Bad",sourceKind:"csv",source:"../private.csv"}), /workspace/)
    assert.throws(() => call(tools, "connection_add", {project:"exists.json",name:"PG",kind:"postgres",dsnEnv:"NOT-AN-ENV-VAR"}), /dsnEnv/)
  } finally { rmSync(f.work, { recursive: true, force: true }) }
})


test("raw row evidence requires operator opt-in and an OpenCode permission assertion", async () => {
  const f = fixture()
  const old = process.env.DWHQ_ALLOW_ROW_DATA
  try {
    const tools = await loadPlugin(f.business)
    delete process.env.DWHQ_ALLOW_ROW_DATA
    await assert.rejects(call(tools, "query_preview", { project: "exists.json", query: "q_sales", includeRows: true }), /DWHQ_ALLOW_ROW_DATA/)
    assert.equal(tools.permissions.length, 0)
    process.env.DWHQ_ALLOW_ROW_DATA = "1"
    const output = JSON.parse((await call(tools, "query_preview", { project: "exists.json", query: "q_sales", includeRows: true, limit: 10 })).content)
    assert.ok(output.argv.includes("--include-rows"))
    assert.equal(tools.permissions.length, 1)
    assert.equal(tools.permissions[0].action, "dwhquery_row_data")
    assert.deepEqual(tools.permissions[0].resources, [join(f.business, "exists.json")])
    const diag = JSON.parse((await call(tools, "join_diagnose", {project:"exists.json",query:"q_sales",index:1,includeRows:true})).content)
    assert.ok(diag.argv.includes("--include-rows"))
    assert.equal(tools.permissions.length, 2)
  } finally {
    if (old === undefined) delete process.env.DWHQ_ALLOW_ROW_DATA
    else process.env.DWHQ_ALLOW_ROW_DATA = old
    rmSync(f.work, { recursive: true, force: true })
  }
})

test("installer refuses symlinked OpenCode configuration directories", () => {
  const f = fixture()
  try {
    rmSync(join(f.business, ".opencode"), { recursive: true })
    symlinkSync(f.work, join(f.business, ".opencode"), "dir")
    const result = spawnSync(process.execPath, [install, f.business], { env: {...process.env, DWHQ_CLI_BIN:f.cli, DWHQ_HOST_BIN:f.host}, encoding:"utf8" })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Refusing symlink/)
  } finally { rmSync(f.work, { recursive: true, force: true }) }
})

test("web launcher binds OpenCode V2 to localhost with explicit password", () => {
  const f = fixture()
  try {
    const capture = join(f.work, "web-capture.json")
    const mock = join(f.work, "fake-opencode.mjs")
    writeFileSync(mock, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";
if(process.argv[2]==="--version") console.log("2.4.0");
else {writeFileSync(process.env.OPENCODE_CAPTURE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),hasPassword:Boolean(process.env.OPENCODE_PASSWORD)}));}
`)
    chmodSync(mock, 0o755)
    const launcher = join(root, "scripts/run-opencode-dwhquery-web.mjs")
    const baseEnv = {...process.env, OPENCODE_BIN: mock, OPENCODE_CAPTURE: capture}
    const unauth = spawnSync(process.execPath, [launcher, f.business], { env: {...baseEnv, OPENCODE_PASSWORD:""}, encoding:"utf8" })
    assert.notEqual(unauth.status, 0)
    assert.match(unauth.stderr, /OPENCODE_PASSWORD/)
    const result = spawnSync(process.execPath, [launcher, f.business], { env: {...baseEnv, OPENCODE_PASSWORD:"a-secret-password-for-test", DWHQ_OPENCODE_PORT:"4097"}, encoding:"utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /a-secret-password-for-test/)
    assert.deepEqual(JSON.parse(readFileSync(capture,"utf8")), {argv:["serve","--hostname","127.0.0.1","--port","4097"],cwd:f.business,hasPassword:true})
    const badPort = spawnSync(process.execPath, [launcher, f.business], { env: {...baseEnv, OPENCODE_PASSWORD:"a-secret-password-for-test", DWHQ_OPENCODE_PORT:"80"}, encoding:"utf8" })
    assert.notEqual(badPort.status, 0)
  } finally { rmSync(f.work, { recursive: true, force: true }) }
})
