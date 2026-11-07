import assert from "node:assert/strict";
import {
  acceptProposal,
  acceptedProposals,
  collectAcceptedPairs,
  pendingProposals,
  proposalsFromFuzzy,
  proposalsFromLlmPairs,
  skipProposal,
} from "./joinLensConfirm";
import type { FuzzyPair } from "./bridge";

const fuzzy: FuzzyPair[] = [
  {
    from_key: "COM-UREA",
    to_key: "urea",
    score: 0.95,
    edits: 1,
    ambiguous: false,
  },
  {
    from_key: "COM-NPK",
    to_key: "npk_a",
    score: 0.9,
    edits: 2,
    ambiguous: true,
    alt_to_key: "npk_b",
  },
];

const staged = proposalsFromFuzzy(fuzzy);
assert.equal(staged[0]!.decision, "accepted");
assert.equal(staged[1]!.decision, "pending");
assert.equal(pendingProposals(staged).length, 1);
assert.equal(acceptedProposals(staged).length, 1);

const withAlt = staged.map((p, i) =>
  i === 1 ? acceptProposal(p, "npk_b") : p,
);
assert.equal(withAlt[1]!.to_key, "npk_b");
assert.equal(withAlt[1]!.decision, "accepted");

const skipped = withAlt.map((p, i) => (i === 0 ? skipProposal(p) : p));
const pairs = collectAcceptedPairs(skipped);
assert.deepEqual(pairs.fromValues, ["COM-NPK"]);
assert.deepEqual(pairs.toValues, ["npk_b"]);
assert.equal(pairs.fromLabels.length, 1);
assert.equal(pairs.toLabels.length, 1);

const llm = proposalsFromLlmPairs(
  [{ from: "COM-AMM", to: "ammonia", why: "ticker" }],
  withAlt,
);
assert.equal(llm.length, 1);
assert.equal(llm[0]!.decision, "pending");
assert.equal(llm[0]!.source, "llm");

const dup = proposalsFromLlmPairs(
  [{ from: "COM-UREA", to: "other" }],
  withAlt,
);
assert.equal(dup.length, 0, "LLM must not re-queue an existing From");

console.log("joinLensConfirm.test.ts: ok");
