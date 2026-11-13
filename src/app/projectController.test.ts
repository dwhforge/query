import assert from "node:assert/strict";
import { emptyProject, type Project } from "../types/pipeline";
import { emptyMatchingSession } from "./matching/types";
import { ProjectController, documentFingerprint, projectDocument, type ProjectControllerPorts } from "./projectController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const matchingDraft = () => emptyMatchingSession({ id: "s", title: "Draft", entry: "mapping",
  scope: "selected", instructionText: "", plan: null, hasUnsavedDecisions: true, chatCollapsed: true });

function harness() {
  let project: Project = { ...emptyProject("work"), root_path: "/work.dwhproj.json" };
  let drafts: ReturnType<ProjectControllerPorts["drafts"]> = { mappings: [], matching: [], mutationBusy: false };
  const calls = { saves: [] as Project[], loads: 0, labs: 0, resets: [] as (string | undefined)[], prunes: [] as string[], errors: [] as (string | null)[], choices: 0 };
  const ports: ProjectControllerPorts = {
    project: () => project,
    update: (fn) => { project = fn(project); },
    drafts: () => drafts,
    choose: async () => { calls.choices++; return "discard"; },
    pickSave: async () => "/copy.dwhproj.json",
    save: async (_path, p) => { calls.saves.push(p); return p; },
    load: async () => { calls.loads++; return emptyProject("loaded"); },
    loadLab: async () => { calls.labs++; return emptyProject("lab").workspace; },
    defaults: () => ({}), newUid: () => "fork-uid",
    remember: async () => {}, pruneRecent: async (path) => { calls.prunes.push(path); },
    reset: (_p, id) => { calls.resets.push(id); drafts = { mappings: [], matching: [], mutationBusy: false }; },
    refreshExport: async () => {}, syncMaps: async (workspace) => ({ workspace }),
    error: (e) => { calls.errors.push(e); }, message: () => {},
  };
  const controller = new ProjectController(ports);
  return { controller, ports, calls, get project() { return project; },
    edit: () => { project = { ...project, name: `${project.name} edited` }; },
    patch: (fn: (p: Project) => Project) => { project = fn(project); },
    get drafts() { return drafts; } };
}

// Deferred writes acknowledge only the submitted snapshot, for Save and Save As.
for (const as of [false, true]) {
  const h = harness();
  const write = deferred<Project>();
  let submitted!: Project;
  h.ports.save = async (_path, p) => { submitted = p; return write.promise; };
  h.edit();
  const uid = h.project.project_uid;
  const path = h.project.root_path;
  const saving = h.controller.save(as);
  await tick();
  assert.equal(h.controller.snapshot().busy, true);
  assert.equal(await h.controller.save(), false, "single flight");
  h.edit();
  write.resolve(submitted);
  assert.equal(await saving, false);
  assert.equal(h.project.project_uid, uid, "late Save As cannot reidentify newer work");
  assert.equal(h.project.root_path, path);
  assert.equal(h.project.name, "work edited edited");
  assert.equal(h.controller.isDirty(), true);
  assert.equal(h.calls.resets.length, 0);
  assert.match(h.calls.errors.at(-1)!, /newer edits/);
  assert.equal(h.controller.snapshot().busy, false);
}

// Edits during the picker are included; successful Save As forks, same-file does not.
for (const as of [false, true]) {
  const h = harness();
  h.patch((p) => ({ ...p, root_path: undefined }));
  const picker = deferred<string | null>();
  h.ports.pickSave = () => picker.promise;
  const saving = h.controller.save(as);
  h.edit();
  picker.resolve("/new.dwhproj.json");
  assert.equal(await saving, true);
  assert.equal(h.calls.saves[0].name, "new");
  assert.equal(h.project.root_path, "/new.dwhproj.json");
  assert.equal(h.controller.isDirty(), false);
  if (as) assert.equal(h.project.project_uid, "fork-uid");
}
{
  const h = harness();
  const uid = h.project.project_uid;
  h.ports.pickSave = async () => h.project.root_path!;
  assert.equal(await h.controller.save(true), true);
  assert.equal(h.project.project_uid, uid);
  h.patch((p) => ({ ...p, root_path: "C:\\Work.dwhproj.json" }));
  h.ports.pickSave = async () => "c:/work.dwhproj.json";
  assert.equal(await h.controller.save(true), true);
  assert.equal(h.project.project_uid, uid, "Windows path case normalization");
}

// Picker cancellation/write failure do not publish new identity/path/baseline.
for (const fail of [false, true]) {
  const h = harness(); h.edit();
  const before = h.project;
  if (fail) h.ports.save = async () => { throw new Error("write refused"); };
  else h.ports.pickSave = async () => null;
  assert.equal(await h.controller.save(true), false);
  assert.equal(h.project, before);
  assert.equal(h.controller.isDirty(), true);
  assert.equal(h.calls.resets.length, 0);
}

// Both entry points use the same late project/draft guard and reset only on commit.
for (const lab of [false, true]) for (const drift of ["project", "mapping", "matching", "busy"]) {
  const h = harness(); h.edit();
  const load = deferred<Project>();
  h.ports.load = () => load.promise;
  h.ports.loadLab = async () => (await load.promise).workspace;
  const replacing = lab ? h.controller.loadLab("recon_ship_sales") : h.controller.open("/next.json");
  await tick();
  if (drift === "project") h.edit();
  if (drift === "mapping") h.drafts.mappings.push({ map: { id: "m", name: "draft", entries: [] }, localDraft: true });
  if (drift === "matching") h.drafts.matching.push(matchingDraft());
  if (drift === "busy") h.drafts.mutationBusy = true;
  const before = h.project;
  load.resolve(emptyProject("other"));
  assert.equal(await replacing, false);
  assert.equal(h.project, before);
  assert.equal(h.calls.resets.length, 0);
  assert.match(h.calls.errors.at(-1)!, /project changed/);
}

for (const lab of [false, true]) for (const decision of ["cancel", "discard", "save"] as const) {
  const h = harness(); h.edit();
  h.ports.choose = async () => decision;
  const originalUid = h.project.project_uid;
  assert.equal(await (lab ? h.controller.loadLab("recon_ship_sales") : h.controller.open("/next.json")), decision !== "cancel");
  assert.equal(h.calls.saves.length, decision === "save" ? 1 : 0);
  assert.equal(h.calls.resets.length, decision === "cancel" ? 0 : 1);
  if (decision === "cancel") assert.equal(h.project.project_uid, originalUid);
  else {
    assert.notEqual(h.project.project_uid, originalUid);
    assert.equal(h.controller.isDirty(), lab);
    assert.equal(h.project.root_path, lab ? undefined : "/next.json");
  }
}

// Separate owner drafts cannot be saved implicitly by Query Save-before-replace.
for (const owner of ["mapping", "matching"]) {
  const h = harness();
  if (owner === "mapping") h.drafts.mappings.push({ map: { id: "m", name: "m", entries: [] }, localDraft: true });
  else h.drafts.matching.push(matchingDraft());
  h.ports.choose = async () => "save";
  assert.equal(await h.controller.loadLab("recon_ship_sales"), false);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.labs, 0);
  assert.match(h.calls.errors.at(-1)!, /editors first/);
}

// A save racing a switch, map write, or editor-owned save blocks replacement.
for (const busy of ["map", "editor", "project"]) {
  const h = harness();
  const hold = deferred<Project>();
  let saving: Promise<boolean> | undefined;
  if (busy === "map") h.drafts.mutationBusy = true;
  if (busy === "editor") h.drafts.mappings.push({ map: { id: "m", name: "m", entries: [] }, saveInFlight: true });
  if (busy === "project") { h.ports.save = () => hold.promise; saving = h.controller.save(); }
  assert.equal(await h.controller.open("/next.json"), false);
  assert.equal(h.calls.loads, 0);
  assert.equal(h.calls.resets.length, 0);
  if (saving) { hold.resolve(h.project); await saving; }
}

// Save-before-replace stops if either persistence or its MRU await sees newer edits.
for (const phase of ["write", "recent"]) {
  const h = harness(); h.edit(); h.ports.choose = async () => "save";
  const hold = deferred<void>();
  if (phase === "write") h.ports.save = async (_path, p) => { await hold.promise; return p; };
  else h.ports.remember = () => hold.promise;
  const replacing = h.controller.loadLab("recon_ship_sales");
  await tick(); h.edit(); hold.resolve();
  assert.equal(await replacing, false);
  assert.equal(h.calls.labs, 0);
  assert.equal(h.controller.isDirty(), true);
}

// Failed Recent load prunes only after permission/load, never cancellation/save failure.
for (const decision of ["cancel", "save", "discard"] as const) {
  const h = harness(); h.edit(); h.ports.choose = async () => decision;
  h.ports.load = async () => { throw new Error("missing file"); };
  if (decision === "save") h.ports.save = async () => { throw new Error("write failed"); };
  const before = h.project;
  assert.equal(await h.controller.open("/missing.json", true), false);
  assert.equal(h.project, before);
  assert.deepEqual(h.calls.prunes, decision === "discard" ? ["/missing.json"] : []);
  assert.equal(h.calls.resets.length, 0);
}
{
  const h = harness(); h.edit(); h.ports.choose = async () => "save";
  h.ports.loadLab = async () => { throw new Error("lab failed"); };
  assert.equal(await h.controller.loadLab("recon_ship_sales"), false);
  assert.equal(h.controller.isDirty(), false, "successful save survives failed load");
  assert.equal(h.calls.resets.length, 0);
}

// Global connection updates survive both slow persistence and replacement.
{
  const h = harness();
  const write = deferred<Project>();
  h.ports.save = () => write.promise;
  const saving = h.controller.save();
  const connections = [{ id: "global", name: "Global", kind: "postgres" as const }];
  h.patch((p) => ({ ...p, connections }));
  write.resolve(h.project);
  assert.equal(await saving, true);
  assert.deepEqual(h.project.connections, connections);
  assert.equal(await h.controller.open("/next.json"), true);
  assert.deepEqual(h.project.connections, connections);
}

// Staged loads are single-flight; obsolete writes/refreshes cannot publish into replacements.
{
  const h = harness(); const hold = deferred<Project>(); h.ports.load = () => hold.promise;
  const first = h.controller.open("/one.json");
  assert.equal(await h.controller.open("/two.json"), false);
  hold.resolve(emptyProject("one")); assert.equal(await first, true);
}
for (const drift of ["edit", "replace"]) {
  const h = harness(); const hold = deferred<{ workspace: Project["workspace"] }>();
  h.ports.syncMaps = () => hold.promise;
  h.controller.applyLoaded({ ...emptyProject("exported"), last_dbt_export_path: "/export" });
  if (drift === "edit") h.edit(); else h.controller.applyLoaded(emptyProject("replacement"));
  const before = h.project;
  hold.resolve({ workspace: emptyProject("late").workspace }); await tick();
  assert.equal(h.project, before);
}
{
  const h = harness(); const hold = deferred<Project>(); h.ports.save = () => hold.promise;
  const saving = h.controller.save();
  h.controller.applyLoaded(emptyProject("forced replacement"));
  const before = h.project;
  hold.resolve(emptyProject("late save")); assert.equal(await saving, false);
  assert.equal(h.project, before);
  assert.equal(h.controller.isDirty(), false);
}
{
  const h = harness();
  assert.equal(documentFingerprint(h.project), documentFingerprint({ ...h.project, root_path: "elsewhere", connections: [] }));
  assert.ok(projectDocument(h.project).canvas);
  assert.equal(await h.controller.loadLab("mapping_quality"), true);
  assert.ok(h.project.mapping_checks?.length);
}
{
  const h = harness();
  const startup = h.controller.snapshot();
  assert.equal(h.controller.unchangedSince(startup), true);
  h.edit();
  assert.equal(h.controller.unchangedSince(startup), false);
  assert.equal(h.calls.resets.length, 0);
}
console.log("projectController tests passed (slow Save/SaveAs/Open/lab, drafts, guards, acknowledgement and refresh)");
