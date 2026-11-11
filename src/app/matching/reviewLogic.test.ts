import assert from "node:assert/strict";
import { FIXTURE_CANDIDATES, FIXTURE_PLAN, fixtureProposals } from "./fixtures";
import {
  applyBulkConfirm,
  applyDecision,
  buildFinalDiff,
  filterProposals,
  matchingCounters,
  previewBulkConfirm,
  summarizeFinalDiff,
} from "./reviewLogic";
import { emptyMatchingSession, mapKeyToken } from "./types";

function session() {
  return emptyMatchingSession({
    id: "s1",
    title: "Matching: Client → A",
    entry: "mapping",
    scope: "cohort",
    instructionText: "",
    plan: FIXTURE_PLAN,
    hasUnsavedDecisions: false,
    chatCollapsed: true,
  });
}

{
  const s0 = session();
  const s = {
    ...s0,
    candidates: FIXTURE_CANDIDATES,
    proposals: fixtureProposals(1),
  };
  const c = matchingCounters(s);
  assert.ok(c.uniqueKeys >= 150, `expected rich sample, got ${c.uniqueKeys}`);
  assert.ok(c.sourceRows >= 24 + 3 + 1 + 2);

  assert.equal(filterProposals(s.proposals, "saved").length, 0);
  const withSaved = {
    ...s,
    proposals: s.proposals.map((p, i) =>
      i === 0 ? { ...p, state: "saved" as const } : p,
    ),
  };
  assert.equal(filterProposals(withSaved.proposals, "saved").length, 1);

  const ready = filterProposals(s.proposals, "ready");
  assert.ok(
    ready.every((p) => p.state === "proposed" && p.proposedCandidateId),
  );
  assert.ok(
    ready.some((p) => p.proposalId.startsWith("prop:fuzzy-")),
    "Ready should include Fuzzy proposed",
  );
  // Ready sorts Fuzzy before LLM residue rows.
  const firstFuzzy = ready.findIndex((p) =>
    p.proposalId.startsWith("prop:fuzzy-"),
  );
  const firstLlmBucket = ready.findIndex((p) =>
    p.evidence.some(
      (e) => e.field === "bucket" && e.note.startsWith("llm"),
    ),
  );
  if (firstFuzzy >= 0 && firstLlmBucket >= 0) {
    assert.ok(
      firstFuzzy < firstLlmBucket,
      "Ready must list Fuzzy before LLM",
    );
  }

  const bulk = previewBulkConfirm(s, "filter", []);
  // Clear proposed with candidate (fuzzy + near-miss + eurpope); ambiguous/incomplete excluded
  assert.ok(bulk.includedProposalIds.includes("prop:a1-eurpope"));
  assert.ok(!bulk.includedProposalIds.includes("prop:a1-empty-region"));
  assert.ok(
    bulk.excluded.some(
      (e) => e.reason === "ambiguous" || e.proposalId.includes("empty"),
    ),
  );

  const after = applyBulkConfirm(s, bulk);
  assert.equal(
    after.proposals.find((p) => p.proposalId === "prop:a1-eurpope")?.state,
    "confirmed_in_draft",
  );
  assert.ok(after.hasUnsavedDecisions);

  const alt = applyDecision(after, "prop:a1-eurpope", "choose_alternative", "cand:2");
  assert.equal(
    alt.decisions.find((d) => mapKeyToken(d.mapKey) === mapKeyToken(["a1", "Eurpope"]))
      ?.candidateId,
    "cand:2",
  );

  const withLive = {
    ...alt,
    mapLive: [],
    mapBaseline: [],
  };
  const diff = buildFinalDiff(withLive);
  const sum = summarizeFinalDiff(diff);
  assert.ok(sum.adds >= 1);
  const eurpope = diff.find(
    (r) => mapKeyToken(r.mapKey) === mapKeyToken(["a1", "Eurpope"]),
  );
  assert.deepEqual(eurpope?.newOutputs, ["2"]);
}

console.log("matching reviewLogic fixtures ok");
