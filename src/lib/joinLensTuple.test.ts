import assert from "node:assert/strict";
import type { JoinTupleReport } from "./bridge";
import { confirmTupleMapping } from "./joinLensConfirm";
import { joinTupleLlmPrompt, parseSuggestedTuplePairs } from "./joinLensLlmPrompt";
import { findTupleSource, searchRightTuples, tupleCell, tupleCounts, tupleIdentity, tupleMappingBlock } from "./joinLensTuple";

const report: JoinTupleReport = {
  left_on: ["name", "region"], right_on: ["company", "area"],
  sources: [{ source: { parts: ["A · B", " EU "], occurrences: 3 }, candidates: [] }],
  right_universe: [
    { parts: ["A", "B · EU"], occurrences: 1 },
    { parts: ["A · B", " EU "], occurrences: 4 },
    { parts: [null, "EU"], occurrences: 2 },
    { parts: ["", "EU"], occurrences: 1 },
    { parts: ["∅", "EU"], occurrences: 1 },
  ],
  left_distinct_total: 1, left_occurrences_total: 3, right_distinct_total: 5,
  right_occurrences_total: 9, left_truncated: false, right_truncated: false, tuple_cap: 1200,
};
assert.notEqual(tupleIdentity(["a · b", "c"]), tupleIdentity(["a", "b · c"]));
assert.equal(new Set([null, "", "∅"].map((p) => tupleIdentity([p]))).size, 3);
assert.deepEqual([null, "", "∅"].map(tupleCell), ["NULL", '""', '"∅"']);
assert.match(tupleMappingBlock([null])!, /NULL/);
assert.match(tupleMappingBlock([""])!, /Empty/);
assert.equal(tupleMappingBlock(["∅", " literal "]), null);
assert.deepEqual(findTupleSource(report, ["A · B", " EU "])?.source.parts, ["A · B", " EU "]);
assert.equal(findTupleSource(report, ["A · B", "EU"]), undefined, "source equality is exact");
assert.deepEqual(searchRightTuples(report, "∅"), [4]);
assert.deepEqual(searchRightTuples(report, "null"), [2]);
assert.deepEqual(searchRightTuples(report, '""'), [3]);
assert.match(tupleCounts(report.right_universe[2]!), /2 rows · 1 duplicate rows · 1 NULL fields/);

for (let n = 1; n <= 5; n++) {
  const left = Array.from({ length: n }, (_, i) => `left_${i}`);
  const right = Array.from({ length: n }, (_, i) => `right_${i}`);
  const from = left.map((_, i) => ` from ${i} `);
  const to = right.map((_, i) => `to · ${i}`);
  const accepted = confirmTupleMapping(left, right, from, to);
  assert.ok(!("error" in accepted));
  assert.deepEqual(accepted.fromParts, from);
  assert.deepEqual(accepted.outputValues, to);
  const contextualReport: JoinTupleReport = {
    ...report, left_on: left, right_on: right,
    sources: [{ source: { parts: from, occurrences: 1 }, candidates: [] }],
    right_universe: [{ parts: to, occurrences: 1 }],
    left_distinct_total: 1, left_occurrences_total: 1,
    right_distinct_total: 1, right_occurrences_total: 1,
  };
  const contextualPrompt = joinTupleLlmPrompt(contextualReport, from);
  assert.ok(contextualPrompt.prompt.includes(JSON.stringify(from)), `complete ${n}-key LLM source`);
  assert.ok(contextualPrompt.prompt.includes(JSON.stringify(to)), `complete ${n}-key LLM candidate`);
  assert.deepEqual(parseSuggestedTuplePairs(JSON.stringify({ pairs: [
    { from_parts: from, to_parts: to, why: "all fields differ" },
    { from_parts: from, to_parts: to.map((v, i) => i === n - 1 ? "invented" : v), why: "invalid" },
    { from_parts: from.slice(1), to_parts: to, why: "partial source" },
  ] }), from, contextualPrompt.allowed).map((pair) => pair.to_parts), [to]);
}
assert.ok("error" in confirmTupleMapping(["a"], ["b"], [null], ["x"]));
assert.ok("error" in confirmTupleMapping(["a"], ["b"], ["x"], [""]));
assert.ok("error" in confirmTupleMapping(["a", "b"], ["c", "d"], ["x", "y"], ["z"]));
assert.ok("error" in confirmTupleMapping(["a", "A"], ["c", "d"], ["x", "x"], ["y", "z"]));

const from = ["A · B", " EU "];
const prompt = joinTupleLlmPrompt(report, from);
assert.ok(prompt.prompt.includes(JSON.stringify({ parts: [null, "EU"], occurrences: 2 })));
assert.ok(prompt.prompt.includes('"source_parts":["A · B"," EU "]'));
const raw = { pairs: [
  { from_parts: from, to_parts: ["∅", "EU"], why: "exact tuple evidence" },
  { from_parts: from, to_parts: ["∅", "EU"], why: "duplicate" },
  { from_parts: from, to_parts: ["invented", "EU"], why: "invented" },
  { from_parts: ["A · B", "EU"], to_parts: ["∅", "EU"], why: "trimmed source is wrong" },
  { from: "A · B · EU", to: "∅ · EU", why: "scalar leakage" },
  { from_parts: from, to_parts: ["∅"], why: "partial" },
  { from_parts: from, to_parts: [null, "EU"], why: "null stays null" },
  { from_parts: from, to_parts: ["", "EU"], why: "empty stays empty" },
  { from_parts: from, to_parts: ["A", "B · EU"], why: "" },
] };
const parsed = parseSuggestedTuplePairs(`Rationale\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``, from, prompt.allowed);
assert.deepEqual(parsed.map((p) => p.to_parts), [["∅", "EU"], [null, "EU"], ["", "EU"]]);
assert.deepEqual(parseSuggestedTuplePairs('{"pairs":[null,4,"bad"]}', from, prompt.allowed), []);
assert.deepEqual(parseSuggestedTuplePairs("not JSON", from, prompt.allowed), []);
const huge = { ...report, right_universe: [{ parts: ["x".repeat(12000), "EU"], occurrences: 1 }, ...report.right_universe] };
const bounded = joinTupleLlmPrompt(huge, from);
assert.ok(bounded.prompt.length <= 10500);
assert.equal(bounded.allowed.length, 5);
assert.deepEqual(parseSuggestedTuplePairs(JSON.stringify({ pairs: [{ from_parts: from, to_parts: huge.right_universe[0]!.parts, why: "not sent" }] }), from, bounded.allowed), []);
console.log("joinLensTuple.test.ts: ok");
