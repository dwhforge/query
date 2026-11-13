import assert from "node:assert/strict";
import { emptyProject } from "../types/pipeline";
import { labProject, projectFingerprint, replaceProject, type SwitchDecision } from "./projectLifecycle";

const original = { ...emptyProject("work"), root_path: "/work/p.json", last_dbt_export_path: "/export" };
assert.equal(projectFingerprint(original), projectFingerprint({ ...original, connections: [], root_path: "/moved.json" }));
assert.notEqual(projectFingerprint(original), projectFingerprint({ ...original, name: "edited" }));
const lab = labProject("recon_ship_sales", { queries: [], focus_query_id: "" }, original,
  { default_execution_engine: "postgres", default_destination_kind: "postgres" });
assert.notEqual(lab.project_uid, original.project_uid);
assert.notEqual(lab.id, original.id);
assert.equal(lab.root_path, undefined);
assert.equal(lab.last_dbt_export_path, undefined);
assert.equal(lab.execution_engine, "duckdb");
assert.equal(lab.destination?.kind, "duckdb");
assert.deepEqual(lab.references, []);
assert.equal(lab.connections, original.connections);
assert.equal(labProject("keymap_pg_seed", lab.workspace, original, {}).destination?.kind, "postgres");
for (const id of ["keymap_pg", "keymap_pg_dual"]) {
  const pg = labProject(id, lab.workspace, original, {});
  assert.equal(pg.execution_engine, "postgres");
  assert.equal(pg.destination?.connection_id, "conn_postgres");
}
assert.notEqual(projectFingerprint(original), projectFingerprint({ ...original,
  workspace: { ...original.workspace, key_maps: [{ id: "map", name: "draft", entries: [] }] } }));

async function scenario(decision: SwitchDecision, saveResult: boolean, drift = false, failLoad = false) {
  let committed = false, saved = false, loaded = false;
  let token = "work";
  const result = await replaceProject({
    read: () => ({ token, drafts: "", busy: false }), dirty: () => true,
    choose: async () => decision,
    save: async () => { saved = true; return saveResult; },
    load: async () => { loaded = true; if (failLoad) throw new Error("load failed"); if (drift) token = "edited"; return "lab"; },
    commit: () => { committed = true; },
  }).catch((e: Error) => e.message);
  return { result, committed, saved, loaded };
}
assert.deepEqual(await scenario("cancel", true), { result: false, committed: false, saved: false, loaded: false });
assert.deepEqual(await scenario("save", false), { result: false, committed: false, saved: true, loaded: false });
assert.deepEqual(await scenario("save", true), { result: true, committed: true, saved: true, loaded: true });
assert.deepEqual(await scenario("discard", true), { result: true, committed: true, saved: false, loaded: true });
assert.equal((await scenario("discard", true, true)).committed, false);
assert.equal((await scenario("save", true, false, true)).committed, false);
await assert.rejects(replaceProject({ read: () => ({ token: "", drafts: "", busy: true }), dirty: () => true,
  choose: async () => "discard", save: async () => true, load: async () => "lab", commit: () => assert.fail("busy commit") }), /save is still in progress/);
let cleanCommitted = false;
await replaceProject({ read: () => ({ token: "work", drafts: "", busy: false }), dirty: () => false,
  choose: async () => assert.fail("Clean saved projects do not prompt"),
  save: async () => assert.fail("Clean saved projects do not save"), load: async () => "lab",
  commit: () => { cleanCommitted = true; } });
assert.ok(cleanCommitted);
let drafts = "matching decision A";
await assert.rejects(replaceProject({ read: () => ({ token: "same", drafts, busy: false }), dirty: () => true,
  choose: async () => "discard", save: async () => true,
  load: async () => { drafts = "matching decision B"; return "lab"; },
  commit: () => assert.fail("Changed drafts must survive a late lab load") }), /project changed/);
console.log("projectLifecycle tests passed");
