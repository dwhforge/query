/** DWHQuery harness PoC: business-language agents discover tools here; no LLM runtime is embedded. */
import { readFile, writeFile, stat, mkdir, open, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { LocalHost } from "./host";
import {
  emptyProject, newQueryId, newConnectionId, syncSourcesFromQueries,
  type Project, type QueryDef, type TransformationStep, type JoinType,
} from "../../src/types/pipeline";
import { createQueryEditingService } from "../../src/app/queryEditing/service";

type Dict = Record<string, string | boolean>;
type Result = Record<string, unknown>;

const tools = [
  {command: "project create", about: "Create an empty, openable DWHQuery project", required: ["project", "name"]},
  {command: "project inspect", about: "Inspect source/query graph without credentials or row data", required: ["project"]},
  {command: "project validate", about: "Run real Rust describe/compile for each query", required: ["project"]},
  {command: "project export", about: "Export SQL/dbt without executing dbt build", required: ["project", "output-dir"]},
  {command: "connection add", about: "Register PostgreSQL or DuckDB connection; secret only from env", required: ["project", "name", "kind"]},
  {command: "query add", about: "Create query with a CSV, Parquet or PostgreSQL root", required: ["project", "name"]},
  {command: "query derive", about: "Create a derived query using existing Query Editing service", required: ["project", "query"]},
  {command: "query step", about: "Append a typed transformation step through Query Editing service", required: ["project", "query", "step"]},
  {command: "query join", about: "Add a JOIN through validated Query Editing service", required: ["project", "query", "right", "on"]},
  {command: "query focus", about: "Select focus Query for previews and default output", required: ["project", "query"]},
  {command: "query describe", about: "Describe query result schema with the Rust compiler", required: ["project", "query"]},
  {command: "query preview", about: "Execute bounded preview; rows suppressed unless explicitly allowed", required: ["project", "query"]},
  {command: "join diagnose", about: "Run live JOIN diagnostics; sample rows suppressed by default", required: ["project", "query", "index"]},
];

function argsOf(argv: string[]): {command: string; opts: Dict} {
  const parts: string[] = [];
  const opts: Dict = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!/^[a-z][a-z0-9-]*$/.test(key) || key in opts) throw new Error(`Invalid/repeated option: ${arg}`);
      if (i+1 < argv.length && !argv[i+1]!.startsWith("--")) opts[key] = argv[++i]!;
      else opts[key] = true;
    } else if (Object.keys(opts).length === 0 && parts.length < 2) parts.push(arg);
    else throw new Error(`Unexpected positional argument: ${arg}`);
  }
  return {command: parts.join(" "), opts};
}
function required(o: Dict, name: string): string {
  const value = o[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${name}`);
  return value;
}
function optional(o: Dict, name: string, fallback = ""): string {
  const value = o[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`--${name} requires a value`);
  return value;
}
function flag(o: Dict, name: string): boolean {
  if (o[name] === undefined) return false;
  if (o[name] !== true) throw new Error(`--${name} does not take a value`);
  return true;
}
function projectPath(o: Dict): string { return resolve(required(o, "project")); }
function asJson(o: Dict, key: string): unknown {
  try { return JSON.parse(required(o, key)) as unknown; }
  catch { throw new Error(`--${key} must be valid JSON`); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stableHash(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }
function safeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) throw new Error("Name must be 1–120 characters");
  return name;
}
function scope(p: Project, queryId: string): Project["workspace"] {
  if (!p.workspace.queries.some(q => q.id === queryId)) throw new Error(`Unknown Query: ${queryId}`);
  return {...p.workspace, focus_query_id: queryId};
}
function refArgs(p: Project, projectFile: string): Record<string, unknown> {
  return {projectFile, projectUid: p.project_uid, references: p.references ?? [],
    connectionBindings: p.connection_bindings ?? [], executionEngine: p.execution_engine};
}
function context(p: Project, projectFile: string, focus?: string): Record<string, unknown> {
  return {workspace: focus ? scope(p, focus) : p.workspace,
    sources: p.sources, connections: p.connections, ...refArgs(p, projectFile)};
}
function publicProject(p: Project): Result {
  return {id: p.id, name: p.name, projectUid: p.project_uid, formatVersion: p.format_version,
    executionEngine: p.execution_engine, destination: {kind: p.destination?.kind},
    connections: p.connections.map(c => ({id: c.id, name: c.name, kind: c.kind})),
    sources: p.sources.map(s => ({id: s.id, name: s.name, kind: s.kind, path: s.path,
      connectionId: s.connection_id, schema: s.schema, table: s.table_name})),
    focusQuery: p.workspace.focus_query_id, outputs: p.outputs ?? [],
    queries: p.workspace.queries.map(q => ({id: q.id, name: q.name,
      steps: q.steps.map((s, index) => ({index, type: s.type}))}))};
}
function ensureEdit(result: ReturnType<ReturnType<typeof createQueryEditingService>["appendStep"]>): Project {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}
async function withHost<T>(fn: (host: LocalHost) => Promise<T>): Promise<T> {
  const host = new LocalHost();
  try { await host.start(); return await fn(host); }
  finally { host.close(); }
}
async function load(host: LocalHost, path: string): Promise<Project> {
  return host.call<Project>("load_project", {path, remember: false});
}
async function save(host: LocalHost, path: string, project: Project): Promise<Project> {
  // This Host RPC is intentionally independent of Electron's last-opened project.
  return host.call<Project>("save_project_tool", {path, project});
}
/** Prevent two CLI writers from overwriting each other; checksum catches outside changes. */
async function mutate(path: string, fn: (host: LocalHost, project: Project) => Promise<Project>): Promise<Result> {
  const ownerFile = `${path}.dwhq-owned`;
  const owner = await readFile(ownerFile, "utf8").catch(() => "");
  if (!owner && process.env.DWHQ_ALLOW_EXISTING_PROJECT_EDITS !== "1")
    throw new Error("Refusing edit of a project not created by this CLI. Operator opt-in: DWHQ_ALLOW_EXISTING_PROJECT_EDITS=1");
  const lockFile = `${path}.dwhq.lock`;
  const lock = await open(lockFile, "wx", 0o600).catch(() => { throw new Error(`Project is locked for CLI editing: ${lockFile}`); });
  try {
    const initialBytes = await readFile(path);
    const baseline = stableHash(initialBytes);
    return await withHost(async host => {
      const before = await load(host, path);
      if (owner && owner.trim() !== before.project_uid)
        throw new Error("Project owner marker does not match project identity");
      const after = await fn(host, before);
      if (baseline !== stableHash(await readFile(path))) throw new Error("Project file changed concurrently; no changes written");
      const saved = await save(host, path, after);
      return {project: path, changed: true, summary: publicProject(saved)};
    });
  } finally { await lock.close(); await unlink(lockFile).catch(() => {}); }
}
function parseRoot(o: Dict): TransformationStep {
  const names = ["csv", "parquet", "postgres"].filter(name => o[name] !== undefined);
  if (names.length !== 1) throw new Error("Specify exactly one of --csv, --parquet, --postgres");
  if (names[0] === "csv") return {type: "LoadCsv", payload: {path: resolve(required(o, "csv")), path_kind: "absolute"}};
  if (names[0] === "parquet") return {type: "LoadParquet", payload: {path: resolve(required(o, "parquet")), path_kind: "absolute"}};
  const table = required(o, "postgres");
  const parts = table.split(".");
  if (parts.length !== 2 || parts.some(part => !/^[a-zA-Z_][\w$]*$/.test(part)))
    throw new Error("--postgres requires schema.table (simple identifiers)");
  return {type: "LoadPostgres", payload: {schema: parts[0]!, table_name: parts[1]!, connection_id: required(o, "connection")}};
}
function parseStep(value: unknown): TransformationStep {
  if (!object(value) || typeof value.type !== "string" || !object(value.payload)) throw new Error("Step requires {type,payload}");
  const allowed = ["Filter", "SelectColumns", "RenameColumn", "DeriveColumn", "GroupBy", "SortBy", "Limit", "NormalizeKey"];
  if (!allowed.includes(value.type)) throw new Error(`Unsupported step ${value.type}; use query join for JOIN and query add for sources`);
  // Expressions are executable SQL snippets. An operator must explicitly opt in.
  if ((["Filter", "GroupBy"].includes(value.type) ||
    (value.type === "DeriveColumn" && typeof value.payload.expression === "string")) &&
    process.env.DWHQ_ALLOW_SQL !== "1") throw new Error("SQL expressions require DWHQ_ALLOW_SQL=1 (operator opt-in)");
  return value as TransformationStep;
}
async function run(command: string, o: Dict): Promise<Result> {
  if (command === "help" || command === "tools" || command === "")
    return {name: "dwhq", version: 1, examples: [
      "project create --project /tmp/work.json --name Receipts",
      "query add --project /tmp/work.json --name Payments --csv /data/payments.csv",
      "query add --project /tmp/work.json --name Contracts --postgres public.contracts --connection conn_main",
      "query join --project /tmp/work.json --query q_payments --right q_contracts --on '[{\"left\":\"contract_id\",\"right\":\"id\"}]'",
      "query step --project /tmp/work.json --query q_payments --step '{\"type\":\"Limit\",\"payload\":{\"n\":50}}'",
      "project validate --project /tmp/work.json",
      "join diagnose --project /tmp/work.json --query q_payments --index 1",
      "project export --project /tmp/work.json --output-dir /tmp/empty_export_dir",
    ], policy: {externalWrites: false, rowData: "opt-in DWHQ_ALLOW_ROW_DATA=1",
      rawSql: "opt-in DWHQ_ALLOW_SQL=1"}, tools};
  const path = projectPath(o);
  if (command === "project create") {
    if (existsSync(path)) throw new Error(`Project already exists: ${path}`);
    const name = safeName(required(o, "name"));
    const engine = optional(o, "engine", "duckdb");
    if (engine !== "duckdb" && engine !== "postgres") throw new Error("--engine must be duckdb or postgres");
    const p = emptyProject(name, {default_execution_engine: engine, default_destination_kind: engine});
    await mkdir(dirname(path), {recursive: true});
    // A second creator must not clobber the same project path.
    const claim = await open(`${path}.dwhq.lock`, "wx", 0o600).catch(() => {throw new Error("Project creation in progress");});
    try {
      if (existsSync(path)) throw new Error(`Project already exists: ${path}`);
      const saved = await withHost(host => save(host, path, p));
      await writeFile(`${path}.dwhq-owned`, `${saved.project_uid}\n`, {flag: "wx", mode: 0o600});
      return {project: path, created: true, summary: publicProject(saved)};
    } finally { await claim.close(); await unlink(`${path}.dwhq.lock`).catch(() => {}); }
  }
  if (command === "project inspect") return withHost(async host => ({project: path, summary: publicProject(await load(host, path))}));
  if (command === "connection add") return mutate(path, async (_host, p) => {
    const kind = optional(o, "kind", "postgres");
    if (kind !== "postgres" && kind !== "duckdb") throw new Error("Only PostgreSQL and DuckDB connections are supported in PoC");
    const name = safeName(required(o, "name"));
    const id = newConnectionId(name, p.connections.map(c => c.id));
    if (kind === "postgres") {
      const envKey = required(o, "dsn-env");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(envKey) || !process.env[envKey]) throw new Error("--dsn-env must name a non-empty environment variable");
      return {...p, connections: [...p.connections, {id, name, kind: "postgres", postgres: {connection_string: process.env[envKey]!}}]};
    }
    return {...p, connections: [...p.connections, {id, name, kind: "duckdb", duckdb: {path: resolve(required(o, "db-path")), read_only: true}}]};
  });
  if (command === "query add") return mutate(path, async (_host, p) => {
    const name = safeName(required(o, "name"));
    const root = parseRoot(o);
    if (root.type === "LoadPostgres" && !p.connections.some(c => c.id === root.payload.connection_id && c.kind === "postgres"))
      throw new Error("PostgreSQL connection not found; add it first");
    const id = newQueryId(name, p.workspace.queries.map(q => q.id));
    const q: QueryDef = {id, name, steps: [root]};
    const queries = [...p.workspace.queries, q];
    return {...p, sources: syncSourcesFromQueries(p.sources, queries),
      workspace: {...p.workspace, queries, focus_query_id: p.workspace.focus_query_id || id}};
  });
  if (command === "query derive") return mutate(path, async (_host, p) => ensureEdit(createQueryEditingService(p).deriveQuery({queryId: required(o, "query")})));
  if (command === "query step") return mutate(path, async (_host, p) =>
    ensureEdit(createQueryEditingService(p).appendStep({queryId: required(o, "query"), step: parseStep(asJson(o, "step"))})));
  if (command === "query join") return mutate(path, async (_host, p) => {
    const pairs = asJson(o, "on");
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 5 ||
      !pairs.every(x => object(x) && typeof x.left === "string" && x.left.trim() && typeof x.right === "string" && x.right.trim()))
      throw new Error("--on must be JSON array of 1–5 {left,right} pairs");
    const joinType = optional(o, "join-type", "left");
    if (!["inner", "left", "right", "full"].includes(joinType)) throw new Error("Invalid --join-type");
    return ensureEdit(createQueryEditingService(p).applyJoin({queryId: required(o, "query"), right: required(o, "right"),
      pairs: pairs as {left: string; right: string}[], joinType: joinType as JoinType}));
  });
  if (command === "query focus") return mutate(path, async (_host, p) => ({...p, workspace: scope(p, required(o, "query"))}));
  if (command === "project validate" || command === "query describe" || command === "query preview" || command === "join diagnose" || command === "project export") {
    return withHost(async host => {
      const p = await load(host, path);
      if (command === "project export") {
        const outputDir = resolve(required(o, "output-dir"));
        if (existsSync(outputDir) && (await stat(outputDir)).isFile()) throw new Error("Export output must be a directory");
        const engine = p.execution_engine ?? "duckdb";
        const dest = p.destination?.kind ?? engine;
        // A non-empty export folder is deliberately refused in this initial agent API.
        if (existsSync(outputDir) && (await (await import("node:fs/promises")).readdir(outputDir)).length)
          throw new Error("Export output directory is not empty; choose a fresh path");
        const result = await host.call<{path: string; files: string[]; dbt_parse_ok: boolean}>("export_dbt", {
          pipelineName: p.name, workspace: p.workspace, outputDir,
          dbtTarget: p.dbt_target, targetDialect: engine, connections: p.connections, sources: p.sources,
          executionEngine: engine, destinationKind: dest, destinationConnectionId: p.destination?.connection_id,
          destinationSchema: p.destination?.schema || "public", outputs: p.outputs ?? [], skipParse: true,
          ...refArgs(p, path),
        });
        return {export: result.path, files: result.files, dbtBuildExecuted: false};
      }
      if (command === "project validate") {
        const queries = p.workspace.queries;
        if (!queries.length) return {project: path, valid: true, empty: true};
        const results: Result[] = [];
        for (const q of queries) {
          const schema = await host.call<{columns: unknown[]}>("describe_workspace", context(p, path, q.id));
          results.push({queryId: q.id, columns: schema.columns});
        }
        return {project: path, valid: true, queries: results};
      }
      const queryId = required(o, "query");
      if (command === "query describe") {
        const res = await host.call<{columns: unknown[]}>("describe_workspace", context(p, path, queryId));
        return {queryId, columns: res.columns};
      }
      if (command === "query preview") {
        const rowLimit = Number(optional(o, "limit", "50"));
        if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 50) throw new Error("--limit must be 1–50");
        const res = await host.call<{columns: unknown[]; rows: unknown[][]; sql: string}>("preview_workspace", {
          ...context(p, path, queryId), rowLimit, fullPreview: false,
        });
        const includeRows = flag(o, "include-rows");
        if (includeRows && process.env.DWHQ_ALLOW_ROW_DATA !== "1") throw new Error("Row data requires DWHQ_ALLOW_ROW_DATA=1");
        return {queryId, columns: res.columns, returnedRows: res.rows.length,
          ...(includeRows ? {rows: res.rows} : {}),
          ...(flag(o, "include-sql") ? {sql: res.sql} : {})};
      }
      const index = Number(required(o, "index"));
      const query = p.workspace.queries.find(q => q.id === queryId);
      if (!query || !Number.isInteger(index) || index < 0 || query.steps[index]?.type !== "Join")
        throw new Error("--index must identify an existing Join step (zero-based)");
      const result = await host.call<Record<string, unknown>>("join_diagnostics", {
        ...context(p, path), hostQueryId: queryId, joinStepIndex: index,
      });
      const {unmatched_left, unmatched_right, fanout_pairs, right_dup_keys, sql_counts, ...metrics} = result;
      const includeRows = flag(o, "include-rows");
      if (includeRows && process.env.DWHQ_ALLOW_ROW_DATA !== "1") throw new Error("Row data requires DWHQ_ALLOW_ROW_DATA=1");
      return {queryId, joinIndex: index, metrics,
        ...(includeRows ? {samples: {unmatched_left, unmatched_right, fanout_pairs, right_dup_keys}} : {})};
    });
  }
  throw new Error(`Unknown command: ${command}. Run 'dwhq tools' for available commands`);
}

async function main(): Promise<void> {
  const {command, opts} = argsOf(process.argv.slice(2));
  try {
    const result = await run(command, opts);
    process.stdout.write(`${JSON.stringify({ok: true, ...result})}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ok: false, code: "tool_error", message: error instanceof Error ? error.message : "Unknown error"})}\n`);
    process.exitCode = 1;
  }
}
void main();
