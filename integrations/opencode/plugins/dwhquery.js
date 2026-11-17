/** DWHQuery tools for OpenCode V2. Model-facing tools never execute shell strings. */
import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const CONFIG = join(ROOT, ".opencode", "dwhquery-adapter.json")
const MAX_OUTPUT = 1024 * 1024
const MAX_DURATION_MS = 180_000

const str = (description) => ({ type: "string", minLength: 1, description })
const optional = (definition) => definition
const includeRowsField = { type: "boolean", description: "Return bounded raw row values to the selected model. Requires operator DWHQ_ALLOW_ROW_DATA=1 and interactive OpenCode approval; default is false." }
function schema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false }
}
function toolSpec(editor, name, description, input, execute) {
  editor.add({ name, description, input, options: { namespace: "dwhquery", codemode: true }, execute })
}

function config() {
  if (!existsSync(CONFIG)) throw new Error("DWHQuery adapter is not installed. Run scripts/install-opencode-dwhquery.mjs against this workspace.")
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"))
  if (cfg.version !== 1 || typeof cfg.cli !== "string" || typeof cfg.host !== "string" || typeof cfg.node !== "string" ||
      !isAbsolute(cfg.cli) || !isAbsolute(cfg.host) || !isAbsolute(cfg.node) ||
      !existsSync(cfg.cli) || !existsSync(cfg.host) || !existsSync(cfg.node)) {
    throw new Error("DWHQuery CLI/Host missing. Rebuild and reinstall the OpenCode adapter.")
  }
  return cfg
}
function resolvedPath(value, label, kind = "file") {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a nonempty path`)
  const target = resolve(ROOT, value)
  const rel = relative(ROOT, target)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === "") {
    throw new Error(`${label} must be inside the active business workspace`)
  }
  if (rel === ".opencode" || rel.startsWith(`.opencode${sep}`)) throw new Error(`${label} cannot modify the OpenCode configuration`)
  // Resolve symlinks in both existing files and their nearest existing ancestor.
  let probe = target
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) throw new Error(`${label} has no existing parent`)
    probe = parent
  }
  const physical = realpathSync(probe)
  const physicalRoot = realpathSync(ROOT)
  const physicalRel = relative(physicalRoot, physical)
  if (physicalRel === ".." || physicalRel.startsWith(`..${sep}`) || isAbsolute(physicalRel)) {
    throw new Error(`${label} resolves outside the business workspace`)
  }
  if (physicalRel === ".opencode" || physicalRel.startsWith(`.opencode${sep}`)) {
    throw new Error(`${label} resolves to the OpenCode configuration`)
  }
  if (kind === "project" && extname(target).toLowerCase() !== ".json") throw new Error("Project path must end in .json")
  if (kind === "existing" && !existsSync(target)) throw new Error(`${label} does not exist`)
  if (kind === "directory" && existsSync(target) && !statSync(target).isDirectory()) throw new Error(`${label} must be a directory`)
  return target
}
function project(value, mustExist = true) {
  const result = resolvedPath(value, "project", mustExist ? "existing" : "project")
  if (extname(result).toLowerCase() !== ".json") throw new Error("Project path must end in .json")
  return result
}
function argsProject(cmd, projectFile) { return [...cmd.split(" "), "--project", projectFile] }
function encodeJson(value, key) {
  if (value === undefined || value === null || typeof value !== "object") throw new Error(`${key} must be a JSON object or array`)
  return JSON.stringify(value)
}
function run(argv, signal) {
  const cfg = config()
  return new Promise((done, fail) => {
    let stdout = "", stderr = "", finished = false
    const env = { ...process.env, DWHQ_HOST_BIN: cfg.host }
    // The OpenCode Web password is not a credential the CLI should ever receive.
    delete env.OPENCODE_PASSWORD
    const child = spawn(cfg.node, [cfg.cli, ...argv], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], signal,
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), MAX_DURATION_MS)
    const settle = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) fail(error)
      else done(result)
    }
    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8")
      if (stdout.length > MAX_OUTPUT) { child.kill("SIGKILL"); settle(new Error("DWHQuery result exceeds 1 MiB; narrow the query")) }
    })
    child.stderr.on("data", (buf) => { stderr = (stderr + buf.toString("utf8")).slice(-4096) })
    child.on("error", (e) => settle(e))
    child.on("close", (status, killed) => {
      if (signal?.aborted) return settle(new Error("DWHQuery operation cancelled"))
      let parsed
      try { parsed = JSON.parse(stdout.trim()) }
      catch { return settle(new Error(`DWHQuery returned invalid JSON (exit ${status}; ${killed ?? "no signal"})`)) }
      if (status !== 0 || parsed.ok !== true) return settle(new Error(`DWHQuery: ${parsed.message ?? "command failed"}`))
      settle(null, { content: JSON.stringify(parsed) })
    })
  })
}

export default Plugin.define({
  id: "dwhquery.harness",
  async setup(ctx) {
    async function rowsOptIn(a, c, argv) {
      if (a.includeRows !== true) return run(argv, c.signal)
      if (process.env.DWHQ_ALLOW_ROW_DATA !== "1") throw new Error("Operator must set DWHQ_ALLOW_ROW_DATA=1 before requesting raw row evidence")
      await ctx.permission.assert({
        sessionID: c.sessionID, agent: c.agent,
        source: { type: "tool", messageID: c.messageID, id: c.id },
        action: "dwhquery_row_data", resources: [project(a.project)], save: [],
      })
      return run([...argv, "--include-rows"], c.signal)
    }
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "dwhquery", description: "Build, inspect, validate and export reproducible data pipelines in DWHQuery. Use when the user asks for data integration, reconciliation or business calculations; users need not know DWHQuery." })
      toolSpec(editor, "capabilities", "Discover bounded DWHQuery operations and their descriptions. No project or database required.", schema({}), (_a, c) => run(["tools"], c.signal))
      toolSpec(editor, "project_create", "Create a new isolated DWH analysis project. Does not overwrite existing projects.",
        schema({ project: str("New .json path inside business workspace"), name: str("Business-oriented project name") }, ["project", "name"]),
        (a, c) => run([...argsProject("project create", project(a.project, false)), "--name", a.name], c.signal))
      toolSpec(editor, "project_inspect", "Inspect project queries, sources and IDs without returning row data or credentials. Always discover IDs before using them.",
        schema({ project: str("Existing .json project file") }, ["project"]),
        (a, c) => run(argsProject("project inspect", project(a.project)), c.signal))
      toolSpec(editor, "connection_add", "Register a PostgreSQL connection by an operator-provided environment variable, or a read-only DuckDB file. Never provide credential values.",
        schema({ project: str("Existing project"), name: str("Connection label"), kind: { type: "string", enum: ["postgres", "duckdb"] }, dsnEnv: optional(str("Name of a pre-existing environment variable containing PostgreSQL DSN")), dbPath: optional(str("Existing DuckDB file under business workspace")) }, ["project", "name", "kind"]),
        (a, c) => {
          const cmd = [...argsProject("connection add", project(a.project)), "--name", a.name, "--kind", a.kind]
          if (a.kind === "postgres") {
            if (!a.dsnEnv || !/^DWHQ_PG_[A-Z0-9_]+$/.test(a.dsnEnv)) throw new Error("dsnEnv must name a pre-provisioned DWHQ_PG_* environment variable")
            cmd.push("--dsn-env", a.dsnEnv)
          } else {
            if (!a.dbPath) throw new Error("dbPath is required")
            cmd.push("--db-path", resolvedPath(a.dbPath, "dbPath", "existing"))
          }
          return run(cmd, c.signal)
        })
      toolSpec(editor, "query_add", "Add a data source and Query to an existing project. CSV/Parquet files must be inside business workspace; PostgreSQL requires registered connection.",
        schema({ project: str("Existing project"), name: str("Business-oriented Query name"), sourceKind: { type: "string", enum: ["csv", "parquet", "postgres"] }, source: str("CSV/Parquet file path within workspace, or PostgreSQL schema.table"), connection: optional(str("Registered PostgreSQL connection ID")) }, ["project", "name", "sourceKind", "source"]),
        (a, c) => {
          const cmd = [...argsProject("query add", project(a.project)), "--name", a.name]
          if (a.sourceKind === "csv" || a.sourceKind === "parquet") cmd.push(`--${a.sourceKind}`, resolvedPath(a.source, "source", "existing"))
          else {
            if (!a.connection) throw new Error("PostgreSQL source requires connection ID; inspect project for the ID")
            cmd.push("--postgres", a.source, "--connection", a.connection)
          }
          return run(cmd, c.signal)
        })
      toolSpec(editor, "query_derive", "Create a new Query derived from an existing Query without rewriting the workspace.",
        schema({ project: str("Existing project"), query: str("Existing source Query ID, obtained from project_inspect") }, ["project", "query"]),
        (a, c) => run([...argsProject("query derive", project(a.project)), "--query", a.query], c.signal))
      toolSpec(editor, "query_step", "Append a typed transformation (Filter, SelectColumns, RenameColumn, DeriveColumn, GroupBy, SortBy, Limit, NormalizeKey). SQL expression steps need operator DWHQ_ALLOW_SQL=1. Never invent column names; describe them first.",
        schema({ project: str("Existing project"), query: str("Existing Query ID"), step: { type: "object", description: "DWHQuery TransformationStep with type and payload", required: ["type", "payload"], properties: { type: str("Transformation type"), payload: { type: "object", additionalProperties: true } }, additionalProperties: false } }, ["project", "query", "step"]),
        (a, c) => run([...argsProject("query step", project(a.project)), "--query", a.query, "--step", encodeJson(a.step, "step")], c.signal))
      toolSpec(editor, "query_join", "Create or replace a JOIN using exact inspected Query IDs and 1–5 field pairs; do not guess keys.",
        schema({ project: str("Existing project"), query: str("LEFT Query ID"), right: str("RIGHT Query ID"), pairs: { type: "array", minItems: 1, maxItems: 5, items: schema({ left: str("LEFT column"), right: str("RIGHT column") }, ["left", "right"]) }, joinType: { type: "string", enum: ["inner", "left", "right", "full"] } }, ["project", "query", "right", "pairs"]),
        (a, c) => run([...argsProject("query join", project(a.project)), "--query", a.query, "--right", a.right, "--on", encodeJson(a.pairs, "pairs"), "--join-type", a.joinType ?? "left"], c.signal))
      toolSpec(editor, "query_focus", "Set the project's focus Query used for default preview/export. Does not execute a database write.",
        schema({ project: str("Existing project"), query: str("Query ID") }, ["project", "query"]),
        (a, c) => run([...argsProject("query focus", project(a.project)), "--query", a.query], c.signal))
      toolSpec(editor, "query_describe", "Ask Rust Host to compile and describe Query schema without returning rows.",
        schema({ project: str("Existing project"), query: str("Query ID") }, ["project", "query"]),
        (a, c) => run([...argsProject("query describe", project(a.project)), "--query", a.query], c.signal))
      toolSpec(editor, "query_preview", "Execute a bounded preview (1–50 rows). Schema and counts by default; raw rows require explicit operator opt-in and user approval.",
        schema({ project: str("Existing project"), query: str("Query ID"), limit: { type: "integer", minimum: 1, maximum: 50 }, includeRows: includeRowsField }, ["project", "query"]),
        (a, c) => rowsOptIn(a, c, [...argsProject("query preview", project(a.project)), "--query", a.query, "--limit", String(a.limit ?? 50)]))
      toolSpec(editor, "join_diagnose", "Analyze real JOIN coverage, unmatched counts, fanout and duplicate keys. Counts only by default; raw samples require operator opt-in and user approval. Index is zero-based Query step index.",
        schema({ project: str("Existing project"), query: str("Query ID"), index: { type: "integer", minimum: 0 }, includeRows: includeRowsField }, ["project", "query", "index"]),
        (a, c) => rowsOptIn(a, c, [...argsProject("join diagnose", project(a.project)), "--query", a.query, "--index", String(a.index)]))
      toolSpec(editor, "project_validate", "Compile and describe all Queries via Rust Host; report any validation failures. Run before delivery.",
        schema({ project: str("Existing project") }, ["project"]),
        (a, c) => run(argsProject("project validate", project(a.project)), c.signal))
      toolSpec(editor, "project_export", "Generate dbt model files in an empty export directory within the business workspace. Does not run dbt build or write external warehouse tables.",
        schema({ project: str("Existing project"), outputDir: str("New or empty destination directory inside workspace") }, ["project", "outputDir"]),
        (a, c) => run([...argsProject("project export", project(a.project)), "--output-dir", resolvedPath(a.outputDir, "outputDir", "directory")], c.signal))
    })
  },
})
