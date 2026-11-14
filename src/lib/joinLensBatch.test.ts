import assert from "node:assert/strict";
import type { JoinTupleReport, ProjectRefContext } from "./bridge";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import { batchContextFingerprint, BATCH_FUZZY_ALTERNATIVES, BATCH_LLM_BUDGET,
  chooseBatchTarget, collectTupleBatch, mergeTupleBatchLlm, tupleBatchLlmPrompt, tupleBatchProposals } from "./joinLensBatch";
import { tupleIdentity } from "./joinLensTuple";

function fixture(n: number, groups = 2, targets = 3): JoinTupleReport {
  return {
    left_on: Array.from({ length: n }, (_, i) => `l${i}`), right_on: Array.from({ length: n }, (_, i) => `r${i}`),
    sources: Array.from({ length: groups }, (_, g) => ({ source: { parts: Array.from({ length: n }, (_, i) => `source ${g}/${i}`), occurrences: g + 1 },
      candidates: Array.from({ length: targets }, (_, i) => ({ right_index: i, score: i < 2 ? 0.97 : 0.1, field_scores: Array(n).fill(0.97) })) })),
    right_universe: Array.from({ length: targets }, (_, g) => ({ parts: Array.from({ length: n }, (_, i) => `target ${g}/${i}`), occurrences: g + 1 })),
    left_distinct_total: groups, left_occurrences_total: groups * 2, right_distinct_total: targets,
    right_occurrences_total: targets * 2, left_truncated: false, right_truncated: false, tuple_cap: 200,
  };
}

for (let n = 1; n <= 5; n++) {
  const report = fixture(n);
  const proposals = tupleBatchProposals(report, 0.85);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0]!.alternatives.length, 2, "ambiguous fuzzy alternatives retained");
  assert.equal(proposals[0]!.selected, null, "never auto-select fuzzy");
  const chosen = { ...chooseBatchTarget(proposals[0]!, 1), decision: "accepted" as const };
  const collected = collectTupleBatch(report, [chosen]);
  assert.ok(Array.isArray(collected));
  assert.deepEqual(collected[0]!.fromParts, report.sources[0]!.source.parts);
  assert.deepEqual(collected[0]!.outputValues, report.right_universe[1]!.parts);
  assert.deepEqual(collected[0]!.leftOn, report.left_on);
  assert.deepEqual(collected[0]!.rightOn, report.right_on);
  assert.equal(chooseBatchTarget(chosen, 2), chosen, "reviewed decisions are immutable until undo");
  const sent = tupleBatchLlmPrompt(report, proposals);
  assert.equal(sent.groups.length, 2);
  const response = JSON.stringify({ pairs: [
    { from_parts: report.sources[0]!.source.parts, to_parts: report.right_universe[2]!.parts, why: "complete evidence" },
    { from_parts: report.sources[1]!.source.parts, to_parts: report.right_universe[1]!.parts, why: "second group" },
    { from_parts: ["invented"], to_parts: report.right_universe[1]!.parts, why: "wrong source" },
    { from_parts: report.sources[0]!.source.parts, to_parts: ["invented"], why: "wrong target" },
    { from_parts: report.sources[0]!.source.parts.slice(1), to_parts: report.right_universe[2]!.parts, why: "partial" },
    { from_parts: report.sources[0]!.source.parts, to_parts: report.right_universe[2]!.parts, why: "" },
  ] });
  const merged = mergeTupleBatchLlm(report, proposals, response, sent);
  assert.equal(merged.added, 1);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.proposals[0]!.alternatives.at(-1)!.origins[0], "llm");
  assert.equal(merged.proposals[0]!.decision, "pending");
  assert.equal(merged.proposals[0]!.selected, null, "LLM never chooses/accepts");
  const conflict = mergeTupleBatchLlm(report, [chosen, proposals[1]!], response, sent);
  assert.equal(conflict.conflicts, 1);
  assert.deepEqual(conflict.proposals[0], chosen, "late LLM cannot overwrite accepted data");
  assert.ok("error" in collectTupleBatch(report, [chosen, chosen]), "duplicate/conflict source decision blocked");
  assert.equal(mergeTupleBatchLlm(report, proposals, "not json", sent).added, 0);
}

const report = fixture(2);
report.sources[0]!.source.parts = ["ABC", "UK"];
report.sources[1]!.source.parts = ["ABC", "US"];
assert.notEqual(tupleBatchProposals(report, 0.85)[0]!.id, tupleBatchProposals(report, 0.85)[1]!.id);
assert.notEqual(tupleIdentity(["a · b", "c"]), tupleIdentity(["a", "b · c"]));
assert.equal(new Set([[null], [""], ["∅"], [" x "], ["x"]].map(tupleIdentity)).size, 5);
const empty = fixture(5, 1, 0);
assert.equal(tupleBatchProposals(empty, 0.85).length, 1, "no-candidate source stays in queue");
assert.equal(tupleBatchLlmPrompt(empty, tupleBatchProposals(empty, 0.85)).groups.length, 0);
assert.deepEqual(collectTupleBatch(empty, []), []);

const capped = fixture(5, 200, 200);
capped.sources.forEach(s => s.candidates.forEach(c => { c.score = 1; }));
const queue = tupleBatchProposals(capped, 0.85);
assert.equal(queue[0]!.alternatives.length, BATCH_FUZZY_ALTERNATIVES);
assert.equal(queue[0]!.omittedFuzzy, 192);
const sent = tupleBatchLlmPrompt(capped, queue);
assert.ok(sent.prompt.length <= BATCH_LLM_BUDGET);
assert.ok(sent.groups.length > 0 && sent.groups.length <= 4);
assert.ok(sent.groups.every(g => g.allowed.length <= 12));
assert.equal(sent.omittedSources, 200 - sent.groups.length);
assert.equal(sent.omittedCandidates, sent.groups.length * 188);
const focused = tupleBatchLlmPrompt(capped, queue, queue[190]!.id);
assert.deepEqual(focused.groups[0]!.source, capped.sources[190]!.source.parts, "any retrieved source can be prioritized within the bounded request");
assert.equal(queue[0]!.sourceIndex, 0, "prompt prioritization never reorders the review queue");
const omitted = JSON.stringify({ pairs: [{ from_parts: capped.sources[0]!.source.parts, to_parts: capped.right_universe[199]!.parts, why: "not sent" }] });
assert.equal(mergeTupleBatchLlm(capped, queue, omitted, sent).added, 0, "not retrieved-prompt allowlisted");
capped.sources[0]!.source.parts = Array(5).fill("x".repeat(20_000));
assert.ok(tupleBatchLlmPrompt(capped, tupleBatchProposals(capped, 0.85)).prompt.length <= BATCH_LLM_BUDGET, "oversized source omitted, never sliced into fake tuples");

const ws = { focus_query_id: "q", queries: [], key_maps: [] } as unknown as Workspace;
const fingerprint = (w = ws, c: ConnectionDef[] = [], s: SourceDef[] = [], ref?: ProjectRefContext) => batchContextFingerprint(w, "q", 1, c, s, ref);
assert.equal(fingerprint(ws), fingerprint(JSON.parse(JSON.stringify(ws))));
assert.equal(fingerprint(ws), fingerprint({ key_maps: [], queries: [], focus_query_id: "q" } as unknown as Workspace));
assert.notEqual(fingerprint(), batchContextFingerprint(ws, "q", 2, [], []));
assert.notEqual(fingerprint(), batchContextFingerprint(ws, "other", 1, [], []));
assert.notEqual(fingerprint(), fingerprint({ ...ws, key_maps: [{ id: "map", entries: [] }] } as unknown as Workspace));
assert.notEqual(fingerprint(), fingerprint({ ...ws, queries: [{ id: "upstream", steps: [] }] } as unknown as Workspace));
assert.notEqual(fingerprint(), fingerprint(ws, [{ id: "conn", password: "private" }] as unknown as ConnectionDef[]));
assert.notEqual(fingerprint(), fingerprint(ws, [], [{ id: "source", path: "new.csv" }] as unknown as SourceDef[]));
assert.notEqual(fingerprint(ws, [], [], { projectUid: "A" }), fingerprint(ws, [], [], { projectUid: "B" }));
assert.ok(!sent.prompt.includes("private"), "local context and credentials never enter tuple prompts");

const invalid = fixture(1);
invalid.right_universe[0]!.parts = [null];
const bad = { ...chooseBatchTarget(tupleBatchProposals(invalid, 0.85)[0]!, 0), decision: "accepted" as const };
assert.ok("error" in collectTupleBatch(invalid, [bad]));
console.log("joinLensBatch: tuple arities 1–5, context isolation, caps, allowlists, ambiguity, duplicate/conflict safety passed");
