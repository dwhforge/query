import assert from "node:assert/strict";
import { emptyProject, type PreviewResult } from "../../types/pipeline";
import type { JoinDiagnostics, JoinDiagSample, JoinPrepareResult, JoinPrepareStatus, JoinPrepareProgress } from "../../lib/bridge";
import { transitionQueryContext } from "../queryNavigation";
import { JoinDiagnosticsController, type JoinInput } from "./controller";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const sample: JoinDiagSample = { columns: [{ name: "id", type: "VARCHAR" }], rows: [["x"]], sample_rows: 1, total_count: 4 };
const diag: JoinDiagnostics = { host_query_id: "left", join_step_index: 1, right_query_id: "right", left_on: ["id"], right_on: ["rid"], sample_limit: 50,
  left_count: 10, right_count: 20, output_count: 30, unmatched_left_count: 4, unmatched_right_count: 0,
  fanout_left_count: 0, right_dup_key_group_count: 0, unmatched_left: sample, unmatched_right: sample, fanout_pairs: sample, right_dup_keys: sample, sql_counts: "" };
const prepared: JoinPrepareResult = { fingerprint: "fp", host_query_id: "left", join_step_index: 1, right_query_id: "right", left_on: ["id"], right_on: ["rid"],
  left_rows: 10, right_rows: 20, reused: false, left_expensive: true, right_expensive: false, left_materialized: true, right_materialized: false };
function harness() {
  const project = emptyProject("Join test");
  project.workspace.queries = [{ id: "left", name: "Left", steps: [
    { type: "CustomSql", payload: { raw_sql: "select 1 as id" } },
    { type: "Join", payload: { right_query_id: "right", left_on: ["id"], right_on: ["rid"], join_type: "left" } },
  ] }, { id: "right", name: "Right", steps: [{ type: "CustomSql", payload: { raw_sql: "select 1 as rid" } }] }];
  let input: JoinInput = { project, context: transitionQueryContext(null, { projectUid: project.project_uid,
    queryId: "left", stepIndex: 1, view: "query:data", mode: "lens", workspace: project.workspace }), skipStatus: false };
  const prepares: ReturnType<typeof deferred<JoinPrepareResult>>[] = [];
  const diagnostics: ReturnType<typeof deferred<JoinDiagnostics>>[] = [];
  const statuses: ReturnType<typeof deferred<JoinPrepareStatus>>[] = [];
  const progresses: ReturnType<typeof deferred<JoinPrepareProgress>>[] = [];
  const previews: ReturnType<typeof deferred<PreviewResult>>[] = [];
  const ticks = new Set<() => void>();
  let cancelled = 0, preempted = 0, shown = 0;
  const owner = new JoinDiagnosticsController({ current: () => input, isCurrent: (c) => c === input.context,
    preemptPreview: () => { preempted++; }, sampleWorkspace: (i) => i.project.workspace, showData: () => { shown++; },
    interval: (tick) => { ticks.add(tick); return () => { ticks.delete(tick); }; },
    host: {
      prepare: async (...args) => { assert.equal(args[1], "left"); assert.equal(args[2], 1); const d = deferred<JoinPrepareResult>(); prepares.push(d); return d.promise; },
      diagnostics: async () => { const d = deferred<JoinDiagnostics>(); diagnostics.push(d); return d.promise; },
      status: async () => { const d = deferred<JoinPrepareStatus>(); statuses.push(d); return d.promise; },
      progress: async () => { const d = deferred<JoinPrepareProgress>(); progresses.push(d); return d.promise; },
      preview: async () => { const d = deferred<PreviewResult>(); previews.push(d); return d.promise; },
      cancel: async () => { cancelled++; },
    } });
  function change(patch: Partial<JoinInput["context"]> = {}) {
    input = { ...input, context: transitionQueryContext(input.context, { ...input.context, ...patch }, true) };
  }
  return { owner, prepares, diagnostics, statuses, progresses, previews, ticks, change,
    tick: () => ticks.forEach((t) => t()), input: () => input,
    counts: () => ({ cancelled, preempted, shown }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const progress = (fraction: number): JoinPrepareProgress => ({ active: true, fraction, stage: "left", message: "Held progress" });

// Same-context preparation supersession and old status/error/finally cannot finish B.
{
  const h = harness();
  const status = h.owner.refreshStatus();
  const a = h.owner.run("prepare"), b = h.owner.run("prepare");
  h.statuses[0].resolve({ prepared: false, stale: true }); await status;
  h.prepares[0].reject(new Error("old failure")); await a;
  assert.equal(h.owner.getSnapshot().prepareLoading, true);
  assert.equal(h.owner.getSnapshot().error, null);
  assert.equal(h.ticks.size, 1);
  h.prepares[1].resolve(prepared); await b;
  assert.match(h.owner.getSnapshot().prepareLabel!, /^Loaded/);
  assert.equal(h.ticks.size, 0);
  assert.deepEqual(h.counts(), { cancelled: 2, preempted: 2, shown: 0 });
}
// Numeric polling, latest poll order, finite/clamped values, completion cleanup.
{
  const h = harness(); const run = h.owner.run("prepare");
  h.tick(); h.progresses[0].resolve(progress(0.426)); await flush();
  assert.equal(h.owner.getSnapshot().progress?.percent, 43);
  h.tick(); h.tick(); h.progresses[2].resolve(progress(1.5)); await flush();
  h.progresses[1].resolve(progress(0.1)); await flush();
  assert.equal(h.owner.getSnapshot().progress?.percent, 100);
  h.tick(); h.progresses[3].resolve(progress(NaN)); await flush();
  assert.equal(h.owner.getSnapshot().progress?.percent, 100);
  h.tick(); h.prepares[0].resolve(prepared); await run;
  h.progresses[4].resolve(progress(0.7)); await flush();
  assert.equal(h.owner.getSnapshot().progress, null);
}
// Held success/error/status/poll across query, step, project, view ABA and graph edits.
for (const reason of ["query", "step", "project", "view", "same-target", "graph"]) {
  for (const fail of [false, true]) {
    const h = harness();
    const oldContext = h.input().context;
    const status = h.owner.refreshStatus();
    const run = h.owner.run("diagnostics"); h.tick();
    h.change(reason === "query" ? { queryId: "right" } : reason === "step" ? { stepIndex: 0 }
      : reason === "project" ? { projectUid: "replacement" } : reason === "view" ? { view: "help_lab" }
      : reason === "graph" ? { workspace: { ...oldContext.workspace } } : {});
    // Before effect cleanup: freshness alone must reject the reply.
    if (fail) h.diagnostics[0].reject(new Error("old diagnostics")); else h.diagnostics[0].resolve(diag);
    h.statuses[0].resolve({ prepared: true, stale: false });
    h.progresses[0].resolve(progress(0.8)); await run; await status; await flush();
    h.owner.syncContext();
    h.change({ ...oldContext }); h.owner.syncContext();
    assert.equal(h.owner.getSnapshot().diag, null, reason);
    assert.equal(h.owner.getSnapshot().error, null, reason);
    assert.equal(h.owner.getSnapshot().progress, null, reason);
    assert.equal(h.owner.getSnapshot().prepareLabel, null, reason);
  }
}
// Cancel/reset invalidates replies even without a context change.
for (const reset of [false, true]) {
  const h = harness(); const run = h.owner.run("prepare"); h.tick();
  if (reset) h.owner.reset(); else h.owner.cancel();
  h.prepares[0].resolve(prepared); h.progresses[0].resolve(progress(0.8)); await run; await flush();
  assert.equal(h.owner.getSnapshot().prepareLoading, false);
  assert.equal(h.owner.getSnapshot().prepareLabel, null);
  assert.equal(h.owner.getSnapshot().progress, null);
  assert.equal(h.ticks.size, 0);
}
// Lens callback leases prevent an old same-context finally from ending new work.
{
  const h = harness(), c = h.input().context;
  const a = h.owner.lensPrepareBusy(c, true); h.tick();
  const b = h.owner.lensPrepareBusy(c, true);
  h.owner.lensPrepareBusy(c, false, a);
  assert.equal(h.owner.getSnapshot().lensBusy, true);
  h.owner.lensPrepareBusy(c, false, b);
  h.progresses[0].resolve(progress(0.9)); await flush();
  assert.equal(h.owner.getSnapshot().progress, null);
  h.change(); h.owner.syncContext();
  h.owner.lensPrepareBusy(c, true);
  assert.equal(h.owner.getSnapshot().lensBusy, false);
}
// Exact diagnostic target, newest sample wins, embedded samples and stale errors.
{
  const h = harness(); const run = h.owner.run("diagnostics");
  h.diagnostics[0].resolve(diag); await run;
  assert.equal(h.owner.getSnapshot().diag, diag);
  const a = h.owner.openSample("left", null, "A");
  const b = h.owner.openSample("right", null, "B");
  h.previews[1].resolve({ columns: sample.columns, rows: [["B"]] } as PreviewResult); await b;
  h.previews[0].resolve({ columns: sample.columns, rows: [["A"]] } as PreviewResult); await a;
  assert.equal(h.owner.getSnapshot().sample?.label, "B");
  assert.deepEqual(h.owner.getSnapshot().sample?.highlightKeys, ["rid"]);
  assert.equal(h.owner.getSnapshot().sample?.totalCount, 20);
  const c = h.owner.openSample("left", null, "C"); h.owner.clearSample();
  h.previews[2].reject(new Error("stale sample")); await c;
  assert.equal(h.owner.getSnapshot().error, null);
  await h.owner.openSample("unmatched_left", sample, "Unmatched");
  assert.equal(h.owner.getSnapshot().sample?.mapSide, "left");
  assert.equal(h.owner.getSnapshot().sample?.totalCount, 4);
  const d = h.owner.openSample("left", null, "D"); h.change(); h.owner.syncContext();
  h.previews[3].resolve({ columns: [], rows: [] } as unknown as PreviewResult); await d;
  assert.equal(h.owner.getSnapshot().sample, null);
  assert.equal(h.counts().shown, 2);
}
// Error/cancel classification stays local to Join, never project lifecycle errors.
for (const error of [new Error("cancelled"), new Error("real failure")]) {
  const h = harness(); const run = h.owner.run("diagnostics");
  h.diagnostics[0].reject(error); await run;
  assert.equal(h.owner.getSnapshot().error, error.message === "cancelled" ? null : "real failure");
  assert.equal(h.owner.getSnapshot().diagnosticsLoading, false);
}
console.log("Join diagnostics controller tests passed (supersede/status/poll/cancel/context/sample/Lens)");
