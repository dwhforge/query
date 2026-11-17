import assert from "node:assert/strict";
import type { JoinTupleReport } from "../../lib/bridge";
import { acknowledgeBasicReceipt, adaptBasicReport, basicHighConfidenceIds, basicPrompt, collectBasicDecisions, mergeBasicLlm, reconcileBasicContext } from "./basic";
import { applyBulkConfirm, applyDecision, buildFinalDiff, confirmReviewedSelection, deriveMatchingReview,
  previewBulkConfirm, previewReviewedConfirm, undoMatchingBulk } from "./reviewLogic";
import { emptyMatchingSession, mapKeyToken } from "./types";
import { buildLensMatchingPlan } from "./planDefaults";

function example(width: number) {
  const left = Array.from({ length: width }, (_, i) => `left${i}`), right = left.map((_, i) => `right${i}`);
  const from = left.map((_, i) => `source ${i}`), to = left.map((_, i) => `target ${i}`);
  const report: JoinTupleReport = { left_on: left, right_on: right, tuple_cap: 200,
    left_distinct_total: 1, left_occurrences_total: 7, right_distinct_total: 2, right_occurrences_total: 5,
    left_truncated: false, right_truncated: false,
    sources: [{ source: { parts: from, occurrences: 7 }, candidates: [
      { right_index: 0, score: .95, field_scores: left.map(() => .95) },
      { right_index: 1, score: .2, field_scores: left.map(() => .2) },
    ] }], right_universe: [{ parts: to, occurrences: 3 }, { parts: left.map(() => "competitor"), occurrences: 2 }] };
  const seed = emptyMatchingSession({ id: "test", title: "Basic", entry: "lens", scope: "cohort", instructionText: "review",
    hasUnsavedDecisions: false, chatCollapsed: false,
    joinBinding: { projectIdentity: "project:0", contextFingerprint: "local-only", hostQueryId: "host", joinStepIndex: 1,
      leftOn: left, rightOn: right, rightQueryId: "target" },
    plan: buildLensMatchingPlan({ leftOn: left, rightOn: right, sourceRef: "host", targetRef: "target", targetColumns: ["target_id", ...right], scope: "cohort" }) });
  return { session: adaptBasicReport(seed, report, "test:1"), report, seed, from, to };
}

for (const width of [1, 2, 3, 4, 5, 8]) {
  const { session, report, from, to } = example(width);
  assert.deepEqual(session.plan?.outputs, report.right_on);
  assert.deepEqual(session.plan?.targetIdentityFields, ["target_id"]);
  assert.equal(session.decisions.length, 0, "retrieval never confirms");
  assert.equal(session.hasUnsavedDecisions, false);
  assert.strictEqual(deriveMatchingReview(session).proposals, session.proposals, "presentation-only review retains sparse index dependencies");
  assert.deepEqual(session.proposals[0].mapKey, from);
  assert.deepEqual(session.candidates[0].outputValues, to);
  assert.equal(session.candidates[0].occurrences, 3);
  assert.equal(session.proposals[0].affectedSourceRows, 7);
  assert.equal(session.proposals[0].edges?.length, 2, "below-cutoff competitor retained");
  assert.deepEqual(session.proposals[0].edges?.[0].fieldScores, report.sources[0].candidates[0].field_scores);
  assert.equal(basicHighConfidenceIds(session).length, 1);
  const preview = previewBulkConfirm(session, "filter", []);
  assert.equal(preview.keyCount, 1); assert.equal(preview.affectedSourceRows, 7);
  const accepted = applyBulkConfirm(session, preview);
  assert.equal(previewReviewedConfirm(session, [session.proposals[0].proposalId]).affectedSourceRows, 7);
  assert.equal(previewReviewedConfirm(accepted, [session.proposals[0].proposalId]).keyCount, 0);
  assert.equal(previewReviewedConfirm(session, ["old-source-id"]).keyCount, 0, "old checkbox ids do not contribute to counted preview");
  assert.equal(accepted.decisions.length, 1);
  assert.equal(accepted.decisions[0].expectedRunId, "test:1");
  assert.equal(deriveMatchingReview(accepted).proposals[0].state, "confirmed_in_draft");
  assert.deepEqual(collectBasicDecisions(accepted), [{ leftOn: report.left_on, rightOn: report.right_on, fromParts: from, outputValues: to }]);
  assert.equal(buildFinalDiff(accepted)[0].kind, "add");
  const undone = undoMatchingBulk(accepted);
  assert.equal(undone.decisions.length, 0);
  assert.equal(undone.proposals[0].userTouched, true);
  assert.equal(basicHighConfidenceIds(undone).length, 0, "undo cannot silently requalify touched evidence");
  assert.equal(collectBasicDecisions({ ...accepted, plan: { ...accepted.plan!, semanticRevision: 2 } }).hasOwnProperty("error"), true);
  assert.equal(collectBasicDecisions({ ...accepted, plan: { ...accepted.plan!, outputs: ["target_id"] } }).hasOwnProperty("error"), true);
}

assert.notEqual(mapKeyToken(["a\0b", "c"]), mapKeyToken(["a", "b\0c"]));
assert.notEqual(mapKeyToken([null]), mapKeyToken([""]));
assert.notEqual(mapKeyToken([" a "]), mapKeyToken(["a"]));
{
  const { seed, report } = example(3);
  report.sources[0].source.parts = [null, "", " a\0b "];
  report.right_universe[0].parts = ["NULL", "∅", "a\0b"];
  const s = adaptBasicReport(seed, report, "test:null");
  assert.deepEqual(s.proposals[0].mapKey, [null, "", " a\0b "]);
  assert.deepEqual(s.candidates[0].outputValues, ["NULL", "∅", "a\0b"]);
  assert.equal(basicHighConfidenceIds(s).length, 0);
  assert.equal(applyDecision(s, s.proposals[0].proposalId, "confirm_proposed", s.candidates[0].candidateId).decisions.length, 0);
}
for (const mutate of [
  (r: JoinTupleReport) => { r.right_truncated = true; },
  (r: JoinTupleReport) => { r.right_distinct_total = 3; },
  (r: JoinTupleReport) => { r.sources[0].candidates[1].score = null; },
  (r: JoinTupleReport) => { r.sources[0].candidates[1].field_scores[0] = null; },
  (r: JoinTupleReport) => { r.sources[0].candidates[1].score = .94; },
  (r: JoinTupleReport) => { r.sources[0].candidates[0].score = .89; r.sources[0].candidates[1].score = .87; },
  (r: JoinTupleReport) => { r.sources[0].candidates.pop(); },
]) {
  const { seed, report } = example(2); mutate(report);
  assert.equal(basicHighConfidenceIds(adaptBasicReport(seed, report, "test:partial")).length, 0);
}
{
  const { session } = example(2), p = session.proposals[0], sent = basicPrompt(session);
  const text = JSON.stringify({ pairs: [{ from_parts: p.mapKey, to_parts: session.candidates[1].outputValues, why: "review alternative" }] });
  const accepted = applyDecision(session, p.proposalId, "confirm_proposed", p.proposedCandidateId);
  const merged = mergeBasicLlm(accepted, "test:1", text, sent);
  assert.deepEqual(merged.decisions, accepted.decisions, "late evidence cannot replace ledger decisions");
  assert.equal(merged.proposals[0].proposedCandidateId, p.proposedCandidateId, "producer suggestion is immutable");
  assert.equal(merged.proposals[0].alternativeCandidateIds.length, 2);
  assert.deepEqual(merged.proposals[0].edges?.[1].origins, ["fuzzy", "llm"]);
  assert.equal(mergeBasicLlm(merged, "test:1", text, sent).proposals[0].edges?.length, 2, "origin/edge deduplication");
  assert.equal(basicHighConfidenceIds(mergeBasicLlm(session, "test:1", text, sent)).length, 0, "conflicting LLM alternative blocks auto-confidence");
  assert.strictEqual(mergeBasicLlm(session, "old-run", text, sent), session);
  assert.equal(confirmReviewedSelection(session, [p.proposalId]).decisions[0].origin, "reviewed_bulk");
  const stale = { ...accepted, commitLifecycle: { status: "stale" as const, reason: "changed" } };
  assert.equal(deriveMatchingReview(stale).proposals[0].state, "stale");
  assert.strictEqual(applyDecision(stale, p.proposalId, "defer", null), stale);
}
{
  const { seed, report } = example(1);
  report.sources[0].candidates[0].score = .4;
  report.sources[0].candidates[1].score = .2;
  const below = adaptBasicReport(seed, report, "test:below");
  assert.equal(below.proposals[0].state, "below_threshold");
  assert.equal(below.proposals[0].proposedCandidateId, null);
  assert.equal(below.proposals[0].alternativeCandidateIds.length, 2, "retain verified low scores for review");
  assert.equal(previewBulkConfirm(below, "selection", [below.proposals[0].proposalId]).keyCount, 0, "no low-score auto-confirm");
  const manual = applyDecision(below, below.proposals[0].proposalId, "choose_alternative", below.proposals[0].alternativeCandidateIds[0]);
  assert.equal(manual.decisions.length, 1, "explicit manual choice is possible");
  report.sources[0].candidates.pop();
  const incomplete = adaptBasicReport(seed, report, "test:partial");
  assert.equal(incomplete.proposals[0].state, "incomplete_search", "unknown competitors are not absence");
  report.sources[0].candidates = [];
  report.right_universe = [];
  report.right_distinct_total = 0;
  const missing = adaptBasicReport(seed, report, "test:none");
  assert.equal(missing.proposals[0].state, "no_candidates");
}
{
  const { seed, report } = example(1);
  report.sources[0].candidates[0].score = .95;
  report.sources[0].candidates[1].score = .94;
  const ambiguous = adaptBasicReport(seed, report, "test:ambiguous");
  assert.equal(ambiguous.proposals[0].state, "ambiguous");
}
console.log("Basic shared Matching model: nullable exact identity, arities 1–5/8, full competitors, ledger, bulk/undo, LLM merge and stale gates passed");

{
  const { session } = example(3), p = session.proposals[0];
  const reviewed = applyDecision(session, p.proposalId, "confirm_proposed", p.proposedCandidateId);
  const pending = { ...reviewed, commitLifecycle: { status: "pending" as const, runId: session.basicRun!.id } };
  const receipt = { status: "applied" as const, appliedCount: 1, projectIdentity: "project:0", contextFingerprint: "committed",
    joinStepIndex: 2, matchingSessionId: session.id, matchingRunId: session.basicRun!.id };
  assert.strictEqual(reconcileBasicContext(pending, "project:0", "committed", receipt), pending, "receipt-before-callback transition keeps original draft locked");
  const ack = acknowledgeBasicReceipt(pending, receipt, "project:0", "committed", null);
  assert.ok(!("error" in ack));
  assert.equal(ack.joinBinding?.joinStepIndex, 2);
  assert.equal(ack.joinBinding?.contextFingerprint, "committed");
  assert.equal(ack.commitLifecycle?.status, "acknowledged");
  assert.equal(ack.hasUnsavedDecisions, false);
  assert.deepEqual(ack.decisions, []); assert.deepEqual(ack.proposals, []); assert.deepEqual(ack.candidates, []);
  assert.equal(ack.basicRun, undefined, "acknowledgement does not auto-retrieve");
  for (const bad of [ { ...receipt, matchingSessionId: "foreign" }, { ...receipt, matchingRunId: "old" },
    { ...receipt, projectIdentity: "project:1" }, { ...receipt, contextFingerprint: "other" },
    { ...receipt, appliedCount: 0 }, { ...receipt, appliedCount: 2 }, { ...receipt, joinStepIndex: -1 }, { ...receipt, joinStepIndex: 1.5 } ]) {
    assert.ok("error" in acknowledgeBasicReceipt(pending, bad, "project:0", "committed", null));
  }
  assert.ok("error" in acknowledgeBasicReceipt(reviewed, receipt, "project:0", "committed", null), "no acknowledgement without matching pending run");
  const edited = reconcileBasicContext(pending, "project:0", "upstream-edit", receipt);
  assert.equal(edited.commitLifecycle?.status, "stale");
  assert.deepEqual(edited.decisions, pending.decisions, "invalidated drafts stay inspectable");
  assert.ok("error" in collectBasicDecisions(edited), "stale ledger cannot be materialized for writing");
  assert.strictEqual(reconcileBasicContext(edited, "project:0", "local-only"), edited, "ABA cannot restore old actions");
  assert.ok("error" in acknowledgeBasicReceipt(edited, receipt, "project:0", "committed", null));
  assert.equal(reconcileBasicContext(reviewed, "project:1", "local-only").commitLifecycle?.status, "stale", "project session ABA");
  assert.equal(reconcileBasicContext(pending, "project:0", "committed", { ...receipt, matchingSessionId: "foreign" }).commitLifecycle?.status, "stale");
  assert.strictEqual(reconcileBasicContext(reviewed, "project:0", "local-only"), reviewed, "unchanged failure context retains actionable draft");
}
console.log("Basic session lifecycle: exact owned transition/shifted JOIN, pending-only ack, explicit refresh, foreign receipt and sticky ABA invalidation passed");
