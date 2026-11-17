/** One-user localhost OpenCode V2 Web UI launcher for an installed DWHQuery workspace. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { resolve, join } from "node:path"

const workspaceArg = process.argv[2]
if (process.argv.includes("--help") || !workspaceArg || process.argv.length !== 3) {
  console.error("Usage: OPENCODE_PASSWORD='strong-secret' node scripts/run-opencode-dwhquery-web.mjs /path/to/business-workspace")
  process.exit(process.argv.includes("--help") ? 0 : 2)
}

const workspace = resolve(workspaceArg)
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  console.error(`Business workspace does not exist: ${workspace}`)
  process.exit(2)
}
const cfgPath = join(workspace, ".opencode/dwhquery-adapter.json")
let cfg
try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) }
catch { console.error(`DWHQuery is not installed in ${workspace}. Run scripts/install-opencode-dwhquery.mjs first.`); process.exit(2) }
if (cfg.version !== 1 || !existsSync(cfg.cli ?? "") || !existsSync(cfg.host ?? "")) {
  console.error("DWHQuery CLI/Host configuration is incomplete. Reinstall the adapter after building.")
  process.exit(2)
}
const password = process.env.OPENCODE_PASSWORD
if (!password || password.length < 16) {
  console.error("Set OPENCODE_PASSWORD to a strong secret of at least 16 characters (do not put it in command history).")
  process.exit(2)
}
const port = Number(process.env.DWHQ_OPENCODE_PORT ?? "4096")
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("DWHQ_OPENCODE_PORT must be an unprivileged TCP port (1024–65535).")
  process.exit(2)
}
const bin = process.env.OPENCODE_BIN || "opencode"
const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 })
const match = (version.stdout ?? "").match(/\b(?:v)?(\d+)\.\d+\.\d+\b/)
if (version.error || version.status !== 0 || !match || Number(match[1]) !== 2) {
  console.error("OpenCode V2 is required. Install OpenCode 2.x and ensure OPENCODE_BIN or PATH is correct.")
  process.exit(2)
}
console.log(`DWHQuery workspace: ${realpathSync(workspace)}`)
console.log(`OpenCode Web: http://127.0.0.1:${port}`)
console.log(`Remote access: ssh -L ${port}:127.0.0.1:${port} <your-linux-server>`)
console.log("Open the local URL in your browser and authenticate. Server remains bound to loopback.")
const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: workspace,
  env: { ...process.env },
  stdio: "inherit",
  shell: false,
})
let launchFailed = false
const forward = (signal) => { if (!child.killed) child.kill(signal) }
process.on("SIGINT", () => forward("SIGINT"))
process.on("SIGTERM", () => forward("SIGTERM"))
child.on("error", (err) => { launchFailed = true; console.error(`Failed to start OpenCode: ${err.message}`); process.exitCode = 1 })
child.on("close", (code, signal) => {
  if (launchFailed) { process.exitCode = 1; return }
  if (signal && signal !== "SIGINT" && signal !== "SIGTERM") process.exitCode = 1
  else process.exitCode = code ?? 0
})
