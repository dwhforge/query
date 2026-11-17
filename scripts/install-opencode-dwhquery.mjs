/** Install a local OpenCode V2 plugin + skill into a business workspace. */
import { existsSync, lstatSync } from "node:fs"
import { createHash } from "node:crypto"
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
// The installer runs under Node; OpenCode itself runs under Bun and must never be reused as the CLI runtime.
const node = resolve(process.env.DWHQ_NODE_BIN || process.execPath)
const plugin = join(repo, "integrations/opencode/plugins/dwhquery.js")
const skill = join(repo, "integrations/opencode/skills/dwhquery/SKILL.md")
for (const file of [node, cli, host, plugin, skill]) {
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
// Allow upgrades only from published, byte-for-byte pinned adapters, never custom plugins.
// The first entry is the original Bun runtime adapter, the second is its Node runtime fix.
const previousSkillSha256 = "b405245599424093349cd0ff2a0478821701de1658b281ab4e36cc61b2fd6217"
const publishedPluginSha256 = new Set([
  "a21b30fdfb42509e74e2a702311c84e6d6f4415ca5ec02c93b2414b75c2b9b48",
  "eb7a3052909d54a0019a06909b3ea41616794394afdd74ca5e55fb241ade40cf",
])
const cliPath = await realpath(cli)
const hostPath = await realpath(host)
const nodePath = await realpath(node)
const legacyCfg = `${JSON.stringify({ version: 1, cli: cliPath, host: hostPath }, null, 2)}\n`
const cfg = `${JSON.stringify({ version: 1, cli: cliPath, host: hostPath, node: nodePath }, null, 2)}\n`
const ownFile = async (path, expected) => {
  if (!existsSync(path)) return
  const current = await readFile(path, "utf8")
  if (current === expected) return
  if (path === configPath && current === legacyCfg) return
  if (path === toolsPath && publishedPluginSha256.has(createHash("sha256").update(current).digest("hex"))) return
  if (path === skillPath && createHash("sha256").update(current).digest("hex") === previousSkillSha256) return
  throw new Error(`Refusing to overwrite an existing custom file: ${path}`)
}
await mkdir(dirname(toolsPath), { recursive: true })
await mkdir(dirname(skillPath), { recursive: true })
await ownFile(configPath, cfg)
await ownFile(toolsPath, await readFile(plugin, "utf8"))
await ownFile(skillPath, await readFile(skill, "utf8"))
await copyFile(plugin, toolsPath)
await copyFile(skill, skillPath)
await writeFile(configPath, cfg, { mode: 0o600 })
console.log(JSON.stringify({ ok: true, workspace: destination, tools: toolsPath, skill: skillPath, config: configPath }))
