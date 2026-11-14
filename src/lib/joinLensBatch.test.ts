import assert from "node:assert/strict";
import type { JoinTupleReport, ProjectRefContext } from "./bridge";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import { batchContextFingerprint, BATCH_FUZZY_ALTERNATIVES, BATCH_LLM_BUDGET,
  BATCH_HIGH_CONFIDENCE_SCORE, BATCH_AMBIGUITY_GAP, acceptHighConfidenceTupleBatch,
  chooseBatchTarget, collectTupleBatch, mergeTupleBatchLlm, parseSuggestedBatchTuplePairs,
  tupleBatchHighConfidenceTarget, tupleBatchLlmPrompt, tupleBatchProposals } from "./joinLensBatch";
import { tupleIdentity } from "./joinLensTuple";
import { parseSuggestedTuplePairs } from "./joinLensLlmPrompt";

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

// Batch-specific prompt: one alignment/schema, complete group allowlists, one response.
const batchReport = fixture(3, 4, 4);
const batchQueue = tupleBatchProposals(batchReport, 0.88);
const batchSent = tupleBatchLlmPrompt(batchReport, batchQueue);
assert.equal(batchSent.prompt.split('"left_on"').length - 1, 1);
assert.equal(batchSent.prompt.split('Schema:').length - 1, 1);
assert.ok(batchSent.prompt.includes("exactly ONE JSON object"));
assert.ok(batchSent.prompt.includes("untrusted data"));
for (const g of batchSent.groups) {
  assert.ok(batchSent.prompt.includes(JSON.stringify(g.source)));
  for (const target of g.allowed) assert.ok(batchSent.prompt.includes(JSON.stringify(target)));
}
const batchResponse = JSON.stringify({ pairs: batchSent.groups.map((g, i) => ({
  from_parts: g.source, to_parts: g.allowed[i], why: ` all fields ${i} `,
})) });
assert.equal(parseSuggestedBatchTuplePairs(batchResponse, batchSent).length, 4);
assert.equal(parseSuggestedBatchTuplePairs(`Reasoning.\n\`\`\`json\n${batchResponse}\n\`\`\``, batchSent).length, 4);
assert.equal(parseSuggestedBatchTuplePairs(`Reasoning. ${batchResponse}`, batchSent).length, 4);
for (const response of [
  `${batchResponse}\n${batchResponse}`,
  `\`\`\`json\n${batchResponse}\n\`\`\`\n\`\`\`json\n${batchResponse}\n\`\`\``,
  `\`\`\`json\n${batchResponse}\n\`\`\`\n${batchResponse}`,
  `${batchResponse}\n\`\`\`json\n${batchResponse}\n\`\`\``,
  `\`\`\`json\n${batchResponse}\n${batchResponse}\n\`\`\``,
  `${batchResponse}\n{"pairs":`, `${batchResponse}\n[]`, "{bad json}",
  JSON.stringify({ pairs: {} }), JSON.stringify([{ pairs: [] }]),
]) {
  assert.deepEqual(parseSuggestedBatchTuplePairs(response, batchSent), [], "multiple/malformed payloads rejected as a whole");
  assert.equal(mergeTupleBatchLlm(batchReport, batchQueue, response, batchSent).added, 0);
}

// Exact validation parity, including null/empty/whitespace identity and rationale rules.
const exactSent = { prompt: "", omittedSources: 0, omittedCandidates: 0, groups: [
  { source: [" A ", null, "∅"], allowed: [[" B ", "", "x{}[]\\\""]] },
  { source: ["A", null, "∅"], allowed: [["B", " ", "y"]] },
] };
const exactPair = { from_parts: exactSent.groups[0]!.source, to_parts: exactSent.groups[0]!.allowed[0], why: '  braces {} and quote " in evidence  ' };
const invalidPairs = [
  { ...exactPair, from_parts: ["A", null, "∅"] }, // target only belongs to other source
  { ...exactPair, to_parts: ["B", "", "x{}[]\\\""] },
  { ...exactPair, from_parts: [" A ", "", "∅"] },
  { ...exactPair, from_parts: [" A ", null] },
  { ...exactPair, to_parts: [" B ", ""] },
  { ...exactPair, to_parts: [" B ", "", 1] },
  { ...exactPair, why: " \n " }, { ...exactPair, why: null }, null,
];
const exactParsed = parseSuggestedBatchTuplePairs(JSON.stringify({ pairs: [exactPair, exactPair, ...invalidPairs] }), exactSent);
assert.deepEqual(exactParsed, [{ ...exactPair, why: exactPair.why.trim() }]);
for (const group of exactSent.groups) {
  const text = JSON.stringify({ pairs: [exactPair, exactPair, ...invalidPairs] });
  assert.deepEqual(parseSuggestedBatchTuplePairs(text, { ...exactSent, groups: [group] }),
    parseSuggestedTuplePairs(text, group.source, group.allowed), "exact validation matches unchanged Suggest Right parser");
}
const originalParse = JSON.parse;
let parseCalls = 0;
try {
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => { parseCalls++; return originalParse(...args); };
  assert.equal(parseSuggestedBatchTuplePairs(batchResponse, batchSent).length, 4);
} finally { JSON.parse = originalParse; }
assert.equal(parseCalls, 1, "one overall JSON parse, not one parse per source group");

// Budget can reduce the candidate axis; no value/row is cut to fit.
const wide = fixture(1, 1, 12);
wide.right_universe.forEach((r, i) => { r.parts = [`${i}:${"x".repeat(1_400)}`]; });
const wideSent = tupleBatchLlmPrompt(wide, tupleBatchProposals(wide, 0.88));
assert.equal(wideSent.groups.length, 1);
assert.ok(wideSent.groups[0]!.allowed.length > 0 && wideSent.groups[0]!.allowed.length < 12);
assert.equal(wideSent.omittedCandidates, 12 - wideSent.groups[0]!.allowed.length);
assert.ok(wideSent.prompt.length <= BATCH_LLM_BUDGET);
const oversizedAlignment = fixture(1);
oversizedAlignment.left_on = ["field".repeat(3_000)];
const noAlignment = tupleBatchLlmPrompt(oversizedAlignment, tupleBatchProposals(oversizedAlignment, 0.88));
assert.equal(noAlignment.groups.length, 0);
assert.ok(noAlignment.prompt.length <= BATCH_LLM_BUDGET);

// Explicit high-confidence action: Rust cutoff >= .88, ties or gaps < .03 ambiguous.
assert.equal(BATCH_HIGH_CONFIDENCE_SCORE, 0.88);
assert.equal(BATCH_AMBIGUITY_GAP, 0.03);
function confidenceFixture(n = 3, targets = 3) {
  const report = fixture(n, 1, targets);
  report.sources[0]!.candidates.forEach((c, i) => { c.score = i === 0 ? 0.96 : 0.5; c.field_scores.fill(c.score); });
  return report;
}
for (let n = 1; n <= 5; n++) {
  const r = confidenceFixture(n);
  const q = tupleBatchProposals(r, 0.88);
  assert.equal(q[0]!.selected, null);
  assert.equal(q[0]!.decision, "pending");
  const before = structuredClone(q);
  assert.equal(tupleBatchHighConfidenceTarget(r, q[0]!), 0);
  const accepted = acceptHighConfidenceTupleBatch(r, q);
  assert.equal(accepted.accepted, 1);
  assert.equal(accepted.proposals[0]!.decision, "accepted");
  assert.equal(accepted.proposals[0]!.selected, 0);
  assert.deepEqual(q, before, "pure helpers do not mutate the queue");
  assert.equal(acceptHighConfidenceTupleBatch(r, accepted.proposals).accepted, 0);
  assert.ok(Array.isArray(collectTupleBatch(r, accepted.proposals)), "accepted tuple is representable");
}
const single = confidenceFixture(1, 1);
single.sources[0]!.candidates[0]!.score = 0.88;
assert.equal(tupleBatchHighConfidenceTarget(single, tupleBatchProposals(single, 0.88)[0]!), 0, "cutoff inclusive");
single.sources[0]!.candidates[0]!.score = 0.879;
assert.equal(tupleBatchHighConfidenceTarget(single, tupleBatchProposals(single, 0.8)[0]!), null);
const boundary = confidenceFixture();
boundary.sources[0]!.candidates[0]!.score = 0.98;
boundary.sources[0]!.candidates[1]!.score = 0.95;
assert.equal(tupleBatchHighConfidenceTarget(boundary, tupleBatchProposals(boundary, 0.88)[0]!), 0, "gap >= .03 allowed (same floating comparison as Rust)");
boundary.sources[0]!.candidates[0]!.score = 0.88;
boundary.sources[0]!.candidates[1]!.score = 0.87;
assert.equal(tupleBatchHighConfidenceTarget(boundary, tupleBatchProposals(boundary, 0.88)[0]!), null,
  "conservatively compare even a runner below the fuzzy display cutoff");

type ConfidenceReport = ReturnType<typeof confidenceFixture>;
const reportBlocks: [string, (r: ConfidenceReport) => void][] = [
  ["tie", r => { r.sources[0]!.candidates[1]!.score = 0.96; }],
  ["close runner", r => { r.sources[0]!.candidates[1]!.score = 0.94; }],
  ["unknown competitor", r => { r.sources[0]!.candidates[2]!.score = null; }],
  ["NaN competitor", r => { r.sources[0]!.candidates[2]!.score = NaN; }],
  ["infinite competitor", r => { r.sources[0]!.candidates[2]!.score = Infinity; }],
  ["invalid score", r => { r.sources[0]!.candidates[2]!.score = -1; }],
  ["unknown field", r => { r.sources[0]!.candidates[2]!.field_scores[0] = null; }],
  ["partial fields", r => { r.sources[0]!.candidates[2]!.field_scores.pop(); }],
  ["missing competitor", r => { r.sources[0]!.candidates.pop(); }],
  ["duplicate candidate", r => { r.sources[0]!.candidates[2]!.right_index = 0; }],
  ["invented candidate", r => { r.sources[0]!.candidates[2]!.right_index = 99; }],
  ["truncated right", r => { r.right_truncated = true; }],
  ["inconsistent right total", r => { r.right_distinct_total++; }],
  ["null source", r => { r.sources[0]!.source.parts[0] = null; }],
  ["blank source", r => { r.sources[0]!.source.parts[0] = "  "; }],
  ["null target", r => { r.right_universe[0]!.parts[0] = null; }],
  ["empty target", r => { r.right_universe[0]!.parts[0] = ""; }],
  ["blank target", r => { r.right_universe[0]!.parts[0] = " \n "; }],
  ["partial target", r => { r.right_universe[0]!.parts.pop(); }],
  ["duplicate destination", r => { r.left_on[1] = r.left_on[0]!; }],
  ["duplicate source", r => { r.sources.push(structuredClone(r.sources[0]!)); }],
];
for (const [reason, change] of reportBlocks) {
  const r = confidenceFixture();
  change(r);
  const q = tupleBatchProposals(r, 0.88);
  assert.equal(tupleBatchHighConfidenceTarget(r, q[0]!), null, reason);
  assert.equal(acceptHighConfidenceTupleBatch(r, q).accepted, 0, reason);
}
const confident = confidenceFixture();
const untouched = tupleBatchProposals(confident, 0.88)[0]!;
for (const p of [
  { ...untouched, decision: "accepted" as const }, { ...untouched, decision: "skipped" as const },
  { ...untouched, selected: 0 }, { ...untouched, userTouched: true },
  { ...chooseBatchTarget(untouched, 0), selected: null },
  { ...untouched, alternatives: [...untouched.alternatives, { rightIndex: 1, origins: ["manual" as const] }] },
  { ...untouched, alternatives: [...untouched.alternatives, { rightIndex: 1, origins: ["llm" as const] }] },
  { ...untouched, id: "stale" }, { ...untouched, sourceIndex: 99 },
]) assert.equal(tupleBatchHighConfidenceTarget(confident, p), null, "decisions/manual/user touches/LLM conflicts excluded");
assert.equal(acceptHighConfidenceTupleBatch(confident, [untouched, untouched]).accepted, 0, "duplicate queue decisions blocked");
const corroborated = mergeTupleBatchLlm(confident, [untouched], JSON.stringify({ pairs: [{
  from_parts: confident.sources[0]!.source.parts, to_parts: confident.right_universe[0]!.parts, why: "same target",
}] }), tupleBatchLlmPrompt(confident, [untouched]));
assert.equal(tupleBatchHighConfidenceTarget(confident, corroborated.proposals[0]!), 0, "same-target LLM provenance is not conflict");
confident.left_truncated = true;
assert.equal(tupleBatchHighConfidenceTarget(confident, untouched), 0, "left retrieval limits scope, not per-source right coverage");
const hiddenRunner = confidenceFixture(1, 12);
hiddenRunner.sources[0]!.candidates.forEach((c, i) => { c.score = i === 0 ? 0.96 : 0.9; });
hiddenRunner.sources[0]!.candidates[11]!.score = 0.95;
assert.equal(tupleBatchProposals(hiddenRunner, 0.88)[0]!.alternatives.some(a => a.rightIndex === 11), false);
assert.equal(tupleBatchHighConfidenceTarget(hiddenRunner, tupleBatchProposals(hiddenRunner, 0.88)[0]!), null, "competitor outside initial eight still blocks");
const reordered = confidenceFixture();
reordered.sources[0]!.candidates.reverse();
assert.equal(tupleBatchHighConfidenceTarget(reordered, tupleBatchProposals(reordered, 0.88)[0]!), 0, "ranking does not assume report order");
const exactValues = confidenceFixture(2);
exactValues.sources[0]!.source.parts = [" source ", "∅"];
exactValues.right_universe[0]!.parts = [" target ", "∅"];
const exactAccepted = acceptHighConfidenceTupleBatch(exactValues, tupleBatchProposals(exactValues, 0.88));
assert.equal(exactAccepted.accepted, 1);
assert.deepEqual(exactValues.sources[0]!.source.parts, [" source ", "∅"], "confidence authoring preserves significant whitespace and literal null marker");
console.log("joinLensBatch: arities 1–5, bounded batch prompt, single-payload parser, exact allowlists, and explicit conservative confidence acceptance passed");
