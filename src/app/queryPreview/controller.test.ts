import assert from "node:assert/strict";
import { emptyProject, type PreviewResult, type Workspace } from "../../types/pipeline";
import type { previewWorkspace } from "../../lib/bridge";
import { QueryPreviewController, type PreviewClock, type QueryPreviewInput } from "./controller";
import { heavyPreviewCacheKey } from "../../lib/previewTransport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = (value: string): PreviewResult => ({ columns: [{ name: "value", type: "VARCHAR" }], rows: [[value]], sql: "select value" });
function harness(heavy = false) {
  const project = emptyProject("test");
  project.workspace = { focus_query_id: "a", queries: [
    { id: "a", name: "A", steps: [{ type: "LoadCsv", payload: { path: "a.csv" } },
      ...(heavy ? [{ type: "ApplyKeyMap" as const, payload: { column: "value", map_id: "m" } }] : [])] },
    { id: "b", name: "B", steps: [{ type: "LoadCsv", payload: { path: "b.csv" } }] },
  ], key_maps: [{ id: "m", name: "M", entries: Array.from({ length: 5000 }, (_, i) => ({ from: `${i}`, to: `${i}` })) }] };
  let current: QueryPreviewInput = { project, workspace: project.workspace, enabled: true, surface: "query" };
  const calls: { args: Parameters<typeof previewWorkspace>; reply: ReturnType<typeof deferred<PreviewResult>> }[] = [];
  const errors: (string | null)[] = [];
  let cancels = 0;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const clock: PreviewClock = {
    set: (fn, delay) => { assert.equal(delay, 150); timers.set(++timerId, fn); return timerId; },
    clear: (id) => { timers.delete(id as number); },
  };
  const owner = new QueryPreviewController({
    current: () => current,
    preview: (...args) => { const reply = deferred<PreviewResult>(); calls.push({ args, reply }); return reply.promise; },
    cancel: async () => { cancels++; },
    clientError: (error) => errors.push(error),
  }, clock);
  return {
    owner, calls, errors, project, timers,
    get current() { return current; }, get cancels() { return cancels; },
    change(patch: Partial<QueryPreviewInput>) { current = { ...current, ...patch }; },
    restore(input: QueryPreviewInput) { current = input; },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

// Fast query/step selection clears debounce, transport and results are scope-owned.
{
  const h = harness();
  h.owner.autoPreview();
  assert.equal(h.owner.getSnapshot().phase, "queued");
  h.change({ workspace: { ...h.project.workspace, focus_query_id: "b" } });
  h.owner.autoPreview();
  h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args[0].focus_query_id, "b");
  assert.equal(h.calls[0].args[0].key_maps![0].entries.length, 0, "unused maps stripped, not mutated");
  assert.equal(h.project.workspace.key_maps![0].entries.length, 5000);
  const stepScope: Workspace = { ...h.project.workspace, queries: h.project.workspace.queries.slice(0, 1) };
  h.change({ workspace: stepScope });
  h.owner.autoPreview(); h.tick();
  h.calls[0].reply.resolve(result("old-query")); await settle();
  assert.equal(h.owner.getSnapshot().loading, true, "stale completion cannot stop current loading");
  assert.equal(h.owner.getSnapshot().result, null);
  h.calls[1].reply.resolve(result("step")); await settle();
  assert.deepEqual(h.owner.getSnapshot().result, result("step"));
}
// Render/effect gap: even without effect invalidation, old errors cannot publish.
{
  const h = harness();
  const pending = h.owner.run();
  h.change({ workspace: { ...h.project.workspace } });
  h.calls[0].reply.reject("late error"); await pending;
  assert.deepEqual(h.errors, []);
}
// Tab ABA, including restoring the exact same input object, still uses generations.
for (const failure of [false, true]) {
  const h = harness();
  const original = h.current;
  const pending = h.owner.run();
  h.change({ enabled: false, surface: "help_lab" }); h.owner.autoPreview();
  h.restore(original); h.owner.autoPreview(); h.tick();
  if (failure) h.calls[0].reply.reject("ABA stale error");
  else h.calls[0].reply.resolve(result("ABA stale success"));
  await pending;
  assert.equal(h.owner.getSnapshot().loading, true);
  assert.equal(h.owner.getSnapshot().result, null);
  assert.deepEqual(h.errors, []);
  h.calls[1].reply.resolve(result("current")); await settle();
  assert.deepEqual(h.owner.getSnapshot().result, result("current"));
}
// Explicit same-target re-entry preempts before the post-render auto request.
{
  const h = harness();
  const pending = h.owner.run();
  h.owner.preempt(); h.owner.autoPreview();
  h.calls[0].reply.resolve(result("same-target stale")); await pending;
  assert.equal(h.owner.getSnapshot().phase, "queued");
  assert.equal(h.owner.getSnapshot().result, null);
  h.tick(); assert.equal(h.calls.length, 2);
}
// Cancel clears debounce and calls host even when another surface owns heavy work.
{
  const h = harness(); h.owner.autoPreview(); h.owner.cancel(); h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.cancels, 1);
  assert.equal(h.owner.getSnapshot().phase, "cancelled");
  const pending = h.owner.run(); h.owner.cancel();
  h.calls[0].reply.resolve(result("cancelled")); await pending;
  assert.equal(h.cancels, 2); assert.equal(h.owner.getSnapshot().loading, false);
  assert.equal(h.owner.getSnapshot().result, null);
  h.owner.autoPreview(); h.owner.invalidate(); h.tick();
  assert.equal(h.calls.length, 1, "cleanup/unmount drops pending debounce");
}
// Errors/cancelled are terminal; retry is a real request, ready-empty stays ready.
{
  const h = harness(); let pending = h.owner.run();
  h.calls[0].reply.reject("broken"); await pending;
  assert.equal(h.owner.getSnapshot().phase, "error"); assert.deepEqual(h.errors, ["broken"]);
  pending = h.owner.refresh();
  h.calls[1].reply.resolve({ ...result(""), rows: [] }); await pending;
  assert.equal(h.owner.getSnapshot().phase, "ready"); assert.equal(h.errors.at(-1), null);
  pending = h.owner.run(); h.calls[2].reply.reject("Preview cancelled."); await pending;
  assert.equal(h.owner.getSnapshot().phase, "cancelled");
  assert.deepEqual(h.errors, ["broken", null], "host cancel is quiet, not a client error");
  assert.equal(h.owner.getSnapshot().loading, false);
}
// Sample/full caches are distinct; refresh repeatedly bypasses cache in current mode.
{
  const h = harness(true);
  let pending = h.owner.run();
  assert.deepEqual(h.calls[0].args[4], { rowLimit: 50 });
  assert.equal(h.calls[0].args[0].key_maps![0].entries.length, 5000);
  h.calls[0].reply.resolve(result("sample")); await pending;
  await h.owner.run(); assert.equal(h.calls.length, 1);
  pending = h.owner.run("full");
  assert.deepEqual(h.calls[1].args[4], { fullPreview: true });
  h.calls[1].reply.resolve(result("full")); await pending;
  await h.owner.run("sample"); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.owner.getSnapshot().result, result("sample"));
  await h.owner.run("full"); assert.equal(h.calls.length, 2);
  for (let i = 0; i < 2; i++) {
    pending = h.owner.refresh(); assert.equal(h.calls.length, 3 + i);
    assert.deepEqual(h.calls[2 + i].args[4], { fullPreview: true });
    h.calls[2 + i].reply.resolve(result(`refresh-${i}`)); await pending;
  }
  // Cache hit is also a new generation, superseding another in-flight mode.
  pending = h.owner.run("sample");
  await h.owner.run("full");
  h.calls[4].reply.reject("superseded by cache"); await pending;
  assert.equal(h.owner.getSnapshot().phase, "ready"); assert.equal(h.errors.at(-1), null);
}
// Edits outside cheap fingerprint samples must clear the cache; replacement resets once.
{
  const h = harness(true); let pending = h.owner.run("full");
  h.calls[0].reply.resolve(result("old")); await pending;
  h.change({ project: { ...h.project, sources: [] } });
  pending = h.owner.run("full"); assert.equal(h.calls.length, 2);
  h.owner.reset();
  assert.deepEqual(h.owner.getSnapshot(), { input: null, result: null, phase: "idle", mode: "sample", loading: false });
  h.change({ project: { ...h.project, project_uid: "replacement" } }); h.owner.autoPreview(); h.tick();
  h.calls[1].reply.reject("previous project error"); await pending;
  assert.equal(h.owner.getSnapshot().loading, true);
  assert.deepEqual(h.calls[2].args[4], { rowLimit: 50 });
  assert.deepEqual(h.errors, [null]);
  h.calls[2].reply.resolve(result("new project")); await settle();
  assert.deepEqual(h.owner.getSnapshot().result, result("new project"));
}
// Every authoritative cache owner edit invalidates even when the cheap key agrees.
for (const edit of ["map-body", "connections", "sources", "path", "uid", "references", "bindings"] as const) {
  const h = harness(true);
  let pending = h.owner.run(); h.calls[0].reply.resolve(result("cached")); await pending;
  const project = { ...h.project };
  if (edit === "map-body") {
    const maps = h.project.workspace.key_maps!;
    project.workspace = { ...h.project.workspace, key_maps: maps.map((map) => ({ ...map,
      entries: map.entries.map((entry, i) => i === 100 ? { ...entry, to: "edited beyond fingerprint" } : entry),
    })) };
    assert.equal(heavyPreviewCacheKey(project.workspace, "a"), heavyPreviewCacheKey(h.project.workspace, "a"));
  } else if (edit === "connections") project.connections = [...(project.connections ?? [])];
  else if (edit === "sources") project.sources = [...(project.sources ?? [])];
  else if (edit === "path") project.root_path = "/different/project.json";
  else if (edit === "uid") project.project_uid = "other";
  else if (edit === "references") project.references = [];
  else project.connection_bindings = [];
  h.change({ project, workspace: project.workspace });
  pending = h.owner.run(); assert.equal(h.calls.length, 2, edit);
  h.calls[1].reply.resolve(result("fresh")); await pending;
}
// Refresh can supersede refresh; old completion must not end the latest progress.
{
  const h = harness();
  const first = h.owner.run("full");
  const second = h.owner.refresh();
  const third = h.owner.refresh();
  h.calls[1].reply.reject("old refresh error"); await second;
  h.calls[0].reply.resolve(result("old refresh result")); await first;
  assert.equal(h.owner.getSnapshot().phase, "running");
  assert.equal(h.owner.getSnapshot().loading, true);
  assert.deepEqual(h.errors, []);
  h.calls[2].reply.resolve(result("latest refresh")); await third;
  assert.equal(h.owner.getSnapshot().mode, "full");
  assert.deepEqual(h.owner.getSnapshot().result, result("latest refresh"));
}
// Modal/foreign-surface availability never invokes the Query preview lane.
{
  const h = harness(); h.change({ enabled: false }); h.owner.autoPreview(); h.tick();
  assert.equal(h.calls.length, 0);
  h.change({ enabled: true }); h.owner.autoPreview(); h.tick();
  assert.equal(h.calls.length, 1);
}
console.log("queryPreview controller tests passed");
