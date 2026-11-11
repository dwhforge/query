import assert from "node:assert/strict";
import { cascadeCounts } from "./cascade";
import {
  FIXTURE_SAMPLE,
  FIXTURE_SAMPLE_TOTAL,
  fixtureProposals,
  fixtureSampleBucketCounts,
} from "./fixtures";

{
  const all = fixtureProposals(1);
  const single = all.filter((p) => p.proposalId !== "prop:multi-out");
  assert.equal(single.length, FIXTURE_SAMPLE_TOTAL);
  assert.ok(all.some((p) => p.proposalId === "prop:a1-eurpope"));
  assert.ok(all.some((p) => p.proposalId === "prop:a1-empty-region"));
  assert.ok(all.some((p) => p.proposalId === "prop:incomplete"));
  assert.ok(all.some((p) => p.proposalId === "prop:multi-out"));

  const buckets = fixtureSampleBucketCounts(single);
  assert.equal(buckets.fuzzy, FIXTURE_SAMPLE.fuzzy);
  assert.equal(buckets.llm, FIXTURE_SAMPLE.llm);
  assert.equal(buckets.manual, FIXTURE_SAMPLE.manual);

  const { resolvedDeterministic, residue } = cascadeCounts(single);
  // Fuzzy closed ≈ 50%; residue (llm + manual) ≈ 50%.
  assert.equal(resolvedDeterministic, FIXTURE_SAMPLE.fuzzy);
  assert.equal(residue, FIXTURE_SAMPLE.llm + FIXTURE_SAMPLE.manual);
  assert.ok(
    resolvedDeterministic / single.length >= 0.45 &&
      resolvedDeterministic / single.length <= 0.55,
  );
  assert.ok(FIXTURE_SAMPLE.llm / single.length >= 0.35);
  assert.ok(FIXTURE_SAMPLE.manual / single.length <= 0.15);
}

console.log("fixtures.test.ts: ok");
