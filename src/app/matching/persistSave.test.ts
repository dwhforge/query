import assert from "node:assert/strict";
import type { KeyMapDef, KeyMapEntry } from "../../types/pipeline";
import type { KeyMapSaveResult } from "../../lib/bridge";
import { applyDecision, buildFinalDiff, summarizeFinalDiff } from "./reviewLogic";
import { emptyMatchingSession, mapKeyToken, type MatchingTabSession } from "./types";
import { classifyMatchingWrite, matchingSaveRevision, persistMatchingSession,
  type MatchingSaveContext, type MatchingSaveDependencies } from "./persistSave";

function draft() {
  const s = emptyMatchingSession({ id: "s1", targetMapId: "map", title: "Matching",
    entry: "mapping", scope: "cohort", instructionText: "Synthetic save evidence", plan: {
      sourceRef: "test_source", targetRef: "test_target", mapKeyFields: ["provider", "region"],
      targetIdentityFields: ["id"], comparisons: [], normalization: ["trim"], outputs: ["id"],
      ambiguity: "leave_for_manual", scope: "cohort", semanticRevision: 1, uiRevision: 0,
    },
    hasUnsavedDecisions: false, chatCollapsed: true });
  return applyDecision({ ...s, candidates: [{ candidateId: "cand:2", targetId: "2",
    outputValues: ["2"], fields: { id: "2" }, evidenceRevision: 1 }], proposals: [{
    proposalId: "prop:a1-eurpope", mapKey: ["a1", "Eurpope"], sourceValues: { provider: "a1", region: "Eurpope" },
    affectedSourceRows: 1, proposedCandidateId: "cand:2", alternativeCandidateIds: [], state: "proposed",
    provenance: "manual", semanticPlanRevision: 1, evidenceRevision: 1, searchIncomplete: false, evidence: [],
  }] },
    "prop:a1-eurpope", "choose_alternative", "cand:2");
}

const row: KeyMapEntry = { from: "a1", from_parts: ["a1", "Eurpope"], to: "2", output_values: ["2"] };
const seed = (): KeyMapDef => ({ id: "map", name: "Map", from_columns: ["provider", "region"],
  output_columns: ["id"], entries: [], storage: { kind: "seed" } });

/** Only the storage adapter is fake. Unit plan records its live input. Host gates
 * themselves are covered in commitSave tests and native matching suites. */
function harness() {
  let session = draft();
  let context: MatchingSaveContext = { owner: "project", map: seed(), externalSeed: false };
  let writes = 0;
  let reads = 0;
  let plannedSession: MatchingTabSession | undefined;
  let result: KeyMapSaveResult = { local: "saved", external: "skipped", message: "not exported yet — no seed CSV" };
  let sourceRows: KeyMapEntry[] = [];
  let current = true;
  let capturedDelta: Parameters<MatchingSaveDependencies["saveMap"]>[1];
  const deps: MatchingSaveDependencies = {
    context: () => context,
    isSessionCurrent: () => current,
    readSource: async (_map, keys) => { reads++; assert.deepEqual(keys, [row.from_parts]); return sourceRows; },
    plan: async (s) => {
      plannedSession = s;
      const existing = s.mapLive.find((r) => mapKeyToken(r.fromParts) === mapKeyToken(row.from_parts!));
      const baseline = s.mapBaseline.find((r) => mapKeyToken(r.fromParts) === mapKeyToken(row.from_parts!));
      if (JSON.stringify(existing?.outputValues) !== JSON.stringify(baseline?.outputValues)) {
        return { ok: false, session: s, reason: "stale_baseline" };
      }
      return { ok: true, session: s, acceptedKeys: [row.from_parts!],
        upserts: existing?.outputValues[0] === "2" ? [] : [{ fromParts: row.from_parts!, outputValues: ["2"] }],
        summary: summarizeFinalDiff(buildFinalDiff(s)) };
    },
    saveMap: async (map, delta) => {
      writes++; capturedDelta = delta;
      context = { ...context, map: map.storage?.kind === "source" ? { ...map, entries: [] } : map };
      return result;
    },
  };
  return { deps, get session() { return session; }, set session(v) { session = v; },
    get context() { return context; }, set context(v) { context = v; },
    get writes() { return writes; }, get reads() { return reads; }, get plannedSession() { return plannedSession; },
    get delta() { return capturedDelta; },
    set result(v: KeyMapSaveResult) { result = v; }, set current(v: boolean) { current = v; },
    set sourceRows(v: KeyMapEntry[]) { sourceRows = v; } };
}

for (const [external, expected] of [["synced", "saved"], ["none", "saved"],
  ["skipped", "refused"], ["conflict", "conflict"], ["error", "error"]] as const) {
  assert.equal(classifyMatchingWrite({ local: "saved", external, message: external }), expected);
}
assert.equal(classifyMatchingWrite({ local: "saved", external: "skipped", message: "no export" },
  { kind: "seed", externalSeed: false }), "saved");
assert.equal(classifyMatchingWrite({ local: "saved", external: "skipped", message: "refused" },
  { kind: "source", externalSeed: false }), "refused");

for (const missing of ["id", "map", "refusal", "query", "ref", "shape", "stale_session", "demo", "fixture"] as const) {
  const h = harness();
  if (missing === "id") h.session = { ...h.session, targetMapId: undefined };
  if (missing === "map") h.context = { ...h.context, map: undefined };
  if (missing === "refusal") h.context = { ...h.context, refusal: "read only" };
  if (missing === "query") h.context.map!.storage = { kind: "query", query_id: "q" };
  if (missing === "ref") h.context.map!.storage = { kind: "ref", model: "m" };
  if (missing === "shape") h.context.map!.output_columns = ["other", "extra"];
  if (missing === "stale_session") h.current = false;
  if (missing === "demo") h.session = { ...h.session, executionMode: "demo" };
  if (missing === "fixture") h.session = { ...h.session, proposals: h.session.proposals.map((p) => ({ ...p, provenance: "fixture" })) };
  if (missing === "demo" || missing === "fixture") {
    h.deps.context = () => { throw new Error("Must refuse before reading context"); };
    h.deps.plan = async () => { throw new Error("Must refuse before host planning"); };
  }
  const result = await persistMatchingSession(h.session, h.deps);
  assert.equal(result.status, "refused", missing);
  assert.equal(h.writes, 0);
  assert.equal(h.session.hasUnsavedDecisions, true);
}

for (const external of ["conflict", "error", "skipped"] as const) {
  const h = harness(); h.context = { ...h.context, externalSeed: true };
  h.result = { local: "saved", external, message: "seed failed" };
  const failed = await persistMatchingSession(h.session, h.deps);
  assert.equal(failed.status, external === "skipped" ? "refused" : external);
  assert.ok(failed.session);
  assert.equal(failed.session.hasUnsavedDecisions, true);
  assert.equal(failed.session.proposals.find((p) => p.proposalId === "prop:a1-eurpope")?.state, "confirmed_in_draft");
  h.session = failed.session;
  h.result = { local: "saved", external: "synced", message: "retry synced" };
  const retry = await persistMatchingSession(h.session, h.deps);
  assert.equal(retry.status, "saved", "local already_matches must still retry seed sync");
  assert.equal(h.writes, 2);
}

{
  const h = harness(); let release!: () => void;
  const normalSave = h.deps.saveMap;
  h.deps.saveMap = async (...args) => { await new Promise<void>((r) => { release = r; }); return normalSave(...args); };
  const pending = persistMatchingSession(h.session, h.deps);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.session.hasUnsavedDecisions, true, "dirty until the write resolves");
  assert.equal(h.writes, 0);
  release(); const result = await pending;
  assert.equal(result.status, "saved"); assert.ok(result.session);
  assert.equal(result.session.hasUnsavedDecisions, false);
  const repeated = await persistMatchingSession(result.session, h.deps);
  assert.equal(repeated.status, "no_changes"); assert.equal(h.writes, 1);
  assert.equal(h.context.map!.entries.length, 1);
  h.context.map!.entries = [{ ...row, to: "3", output_values: ["3"] }];
  assert.equal((await persistMatchingSession(result.session, h.deps)).status, "conflict");
}

{
  const h = harness();
  h.context.map!.entries = [{ ...row, to: "old", output_values: ["old"], attrs: { note: "keep" } }];
  h.session = { ...h.session, mapBaseline: [{ fromParts: row.from_parts!, outputValues: ["old"] }],
    explicitReplaceKeys: [mapKeyToken(row.from_parts!)] };
  assert.equal((await persistMatchingSession(h.session, h.deps)).status, "saved");
  assert.deepEqual(h.context.map!.entries[0].output_values, ["2"], "replacement is not fill-only");
  assert.deepEqual(h.context.map!.entries[0].attrs, { note: "keep" });
}

{
  const h = harness(); h.context.map!.storage = { kind: "source", source: "postgres", table: "public.map" };
  h.result = { local: "saved", external: "synced", message: "written" };
  assert.equal((await persistMatchingSession(h.session, h.deps)).status, "saved");
  assert.equal(h.reads, 1);
  assert.deepEqual(h.delta?.baselines?.[0].fromParts, row.from_parts);
  assert.equal(h.delta?.baselines?.[0].existed, false);
  assert.deepEqual(h.delta?.upserts[0].output_values, ["2"]);
}

{
  const h = harness();
  h.context.map!.entries = [row];
  h.session = { ...h.session, mapBaseline: [{ fromParts: row.from_parts!, outputValues: ["2"] }] };
  const result = await persistMatchingSession(h.session, h.deps);
  assert.equal(result.status, "no_changes");
  assert.ok(result.session);
  assert.equal(result.session.hasUnsavedDecisions, false);
  assert.equal(h.writes, 0, "verified current-map no-op needs no local write");
}

{
  const h = harness();
  h.context = { ...h.context, externalSeed: true };
  h.context.map!.storage = { kind: "source", source: "postgres", table: "public.map" };
  h.sourceRows = [row];
  h.session = { ...h.session, mapBaseline: [{ fromParts: row.from_parts!, outputValues: ["2"] }] };
  assert.equal((await persistMatchingSession(h.session, h.deps)).status, "no_changes");
  assert.equal(h.writes, 0, "a project export target does not turn a source no-op into a seed write");
}

for (const external of ["conflict", "error", "skipped"] as const) {
  const h = harness();
  h.context.map!.storage = { kind: "source", source: "postgres", table: "public.map" };
  h.result = { local: "saved", external, message: "warehouse write failed" };
  const result = await persistMatchingSession(h.session, h.deps);
  assert.equal(result.status, external === "skipped" ? "refused" : external);
  assert.equal(h.session.hasUnsavedDecisions, true);
  assert.equal(h.reads, 1);
  assert.equal(result.session, undefined, "warehouse failure must not invent a new baseline");
}

{
  const h = harness();
  h.context.map!.storage = { kind: "source", source: "postgres", table: "public.map" };
  h.sourceRows = [row];
  assert.equal((await persistMatchingSession(h.session, h.deps)).status, "conflict",
    "empty project entries do not imply that a warehouse key is absent");
  assert.equal(h.writes, 0);
  assert.equal(h.plannedSession?.mapLive.length, 1);
}

for (const phase of ["read_error", "cancel", "planning_edit", "late_decision", "late_project", "live_conflict"] as const) {
  const h = harness();
  if (phase === "read_error") {
    h.context.map!.storage = { kind: "source", source: "postgres", table: "public.map" };
    h.deps.readSource = async () => { throw new Error("warehouse unavailable"); };
  }
  if (phase === "cancel") h.deps.saveMap = async () => { throw new Error("cancelled"); };
  if (phase === "planning_edit") {
    const plan = h.deps.plan!;
    h.deps.plan = async (...args) => { const result = await plan(...args); h.context.map!.name = "edited"; return result; };
  }
  if (phase === "late_decision") {
    const save = h.deps.saveMap;
    h.deps.saveMap = async (...args) => { const result = await save(...args); h.current = false; return result; };
  }
  if (phase === "late_project") {
    const save = h.deps.saveMap;
    h.deps.saveMap = async (...args) => { const result = await save(...args); h.context = { ...h.context, owner: "other" }; return result; };
  }
  if (phase === "live_conflict") h.context.map!.entries = [row];
  const result = await persistMatchingSession(h.session, h.deps);
  assert.ok(result.status === "conflict" || result.status === "error", phase);
  assert.equal(h.session.hasUnsavedDecisions, true);
  if (phase === "planning_edit" || phase === "live_conflict") assert.equal(h.writes, 0);
}

{
  const s = draft();
  assert.equal(matchingSaveRevision(s), matchingSaveRevision({ ...s, pageIndex: 2, reviewFilter: "all" }));
  assert.notEqual(matchingSaveRevision(s), matchingSaveRevision({ ...s, decisions: [] }));
  assert.notEqual(matchingSaveRevision(s), matchingSaveRevision({ ...s, executionMode: "demo" }));
}
console.log("matching persistence acknowledgement tests ok");
