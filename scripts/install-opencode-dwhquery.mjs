/** Install a local OpenCode V2 plugin + skill into a business workspace. */
import { existsSync, lstatSync } from "node:fs"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
if (argv.length !== 1 || argv[0] === "--help") {
  console.error("Usage: node scripts/install-opencode-dwhquery.mjs /path/to/business-workspace\nBuild first: npm run cli:build && cargo build -p dwh-host --release")
  process.exit(argv[0] === "--help" ? 0 : 2)
}
const destination = resolve(argv[0])
const cli = resolve(process.env.DWHQ_CLI_BIN || join(repo, "dist/dwhq.mjs"))
const host = resolve(process.env.DWHQ_HOST_BIN || join(repo, "target/release", process.platform === "win32" ? "dwh-host.exe" : "dwh-host"))
const plugin = join(repo, "integrations/opencode/plugins/dwhquery.js")
const skill = join(repo, "integrations/opencode/skills/dwhquery/SKILL.md")
for (const file of [cli, host, plugin, skill]) {
  if (!existsSync(file)) throw new Error(`Missing ${file}. Build CLI/Host before installing.`)
}
if (!existsSync(destination)) throw new Error(`Business workspace must already exist: ${destination}`)
// The user's workspace is an untrusted path: never follow symlinks while installing
// local executable plugin code or its configuration.
for (const part of [".opencode", ".opencode/plugins", ".opencode/skills", ".opencode/skills/dwhquery",
  ".opencode/plugins/dwhquery.js", ".opencode/skills/dwhquery/SKILL.md", ".opencode/dwhquery-adapter.json"]) {
  const file = join(destination, part)
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`)
}
const toolsPath = join(destination, ".opencode/plugins/dwhquery.js")
const skillPath = join(destination, ".opencode/skills/dwhquery/SKILL.md")
const configPath = join(destination, ".opencode/dwhquery-adapter.json")
const ownFile = async (path, expected) => {
  if (!existsSync(path)) return
  if ((await readFile(path, "utf8")) !== expected) {
    throw new Error(`Refusing to overwrite an existing custom file: ${path}`)
  }
}
await mkdir(dirname(toolsPath), { recursive: true })
await mkdir(dirname(skillPath), { recursive: true })
const cfg = `${JSON.stringify({ version: 1, cli: await realpath(cli), host: await realpath(host) }, null, 2)}\n`
await ownFile(configPath, cfg)
await ownFile(toolsPath, await readFile(plugin, "utf8"))
await ownFile(skillPath, await readFile(skill, "utf8"))
await copyFile(plugin, toolsPath)
await copyFile(skill, skillPath)
await writeFile(configPath, cfg, { mode: 0o600 })
console.log(JSON.stringify({ ok: true, workspace: destination, tools: toolsPath, skill: skillPath, config: configPath }))
