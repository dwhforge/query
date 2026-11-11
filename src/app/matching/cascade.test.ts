import assert from "node:assert/strict";
import {
  cascadeCounts,
  cascadeTierCounts,
  isDeterministicResolved,
  proposalCascadeTier,
  proposalEvidenceSummary,
  residueProposals,
} from "./cascade";
import type { MatchingProposalView } from "./types";

function prop(
  partial: Partial<MatchingProposalView> & Pick<MatchingProposalView, "proposalId">,
): MatchingProposalView {
  return {
    mapKey: ["x"],
    sourceValues: {},
    affectedSourceRows: 1,
    proposedCandidateId: "cand:1",
    alternativeCandidateIds: [],
    state: "proposed",
    provenance: "fuzzy",
    semanticPlanRevision: 1,
    evidenceRevision: 1,
    searchIncomplete: false,
    evidence: [],
    ...partial,
  };
}

{
  assert.equal(
    isDeterministicResolved(
      prop({ proposalId: "ok", provenance: "fuzzy" }),
    ),
    true,
  );
  assert.equal(
    isDeterministicResolved(
      prop({
        proposalId: "alts",
        alternativeCandidateIds: ["cand:2"],
      }),
    ),
    false,
  );
  assert.equal(
    isDeterministicResolved(
      prop({ proposalId: "amb", state: "ambiguous" }),
    ),
    false,
  );
  assert.equal(
    isDeterministicResolved(
      prop({
        proposalId: "empty",
        state: "no_candidates",
        proposedCandidateId: null,
      }),
    ),
    false,
  );
  // "Зать Президента" style — nothing deterministic → residue for LLM.
  assert.equal(
    isDeterministicResolved(
      prop({
        proposalId: "opaque",
        state: "incomplete_search",
        proposedCandidateId: null,
        searchIncomplete: true,
      }),
    ),
    false,
  );
  // Saved / confirmed are in the Mapping (or draft) — not LLM residue.
  assert.equal(
    isDeterministicResolved(
      prop({ proposalId: "saved", state: "saved" }),
    ),
    true,
  );
  assert.deepEqual(
    residueProposals([
      prop({ proposalId: "saved", state: "saved" }),
      prop({
        proposalId: "open",
        state: "ambiguous",
        proposedCandidateId: null,
      }),
    ]).map((p) => p.proposalId),
    ["open"],
  );
}

{
  const all = [
    prop({ proposalId: "a" }),
    prop({
      proposalId: "b",
      state: "ambiguous",
      alternativeCandidateIds: ["cand:2"],
    }),
  ];
  const res = residueProposals(all);
  assert.equal(res.length, 1);
  assert.equal(res[0]?.proposalId, "b");
  assert.deepEqual(cascadeCounts(all), {
    resolvedDeterministic: 1,
    residue: 1,
  });
}

{
  const fuzzy = prop({
    proposalId: "f",
    provenance: "fuzzy",
    evidence: [
      { field: "name", note: "exact / normalize" },
      { field: "bucket", note: "fuzzy" },
    ],
  });
  const leftover = prop({
    proposalId: "l",
    state: "incomplete_search",
    proposedCandidateId: null,
    searchIncomplete: true,
    provenance: "fixture",
    evidence: [
      { field: "name", note: "opaque alias" },
      { field: "bucket", note: "llm" },
    ],
  });
  const llmDone = prop({
    proposalId: "ld",
    provenance: "llm",
    evidence: [{ field: "llm", note: "alias match" }],
  });
  const manual = prop({
    proposalId: "m",
    state: "ambiguous",
    proposedCandidateId: null,
    evidence: [
      { field: "region", note: "empty — no arbitrary pick" },
      { field: "bucket", note: "manual" },
    ],
  });
  assert.equal(proposalCascadeTier(fuzzy), "fuzzy");
  assert.equal(proposalCascadeTier(leftover), "leftover");
  assert.equal(proposalCascadeTier(llmDone), "llm");
  assert.equal(proposalCascadeTier(manual), "manual");
  assert.equal(proposalEvidenceSummary(fuzzy), "exact / normalize");
  assert.deepEqual(cascadeTierCounts([fuzzy, leftover, llmDone, manual]), {
    fuzzy: 1,
    leftover: 1,
    llm: 1,
    manual: 1,
  });
}

console.log("cascade.test.ts: ok");
