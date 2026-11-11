import assert from "node:assert/strict";
import {
  buildMatchingRankSystemPrompt,
  LLM_RANK_BATCH_SIZE,
  parseMatchingRankResponse,
} from "./llmRank";
import { FIXTURE_PLAN } from "./fixtures";

{
  const picks = parseMatchingRankResponse(`Here you go:
\`\`\`json
[
  {"proposalId":"prop:1","targetId":"1","confidence":"high","why":"name+region"},
  {"proposalId":"prop:2","targetId":null,"confidence":"low","why":"blank region"}
]
\`\`\`
`);
  assert.equal(picks.length, 2);
  assert.equal(picks[0]?.targetId, "1");
  assert.equal(picks[0]?.confidence, "high");
  assert.equal(picks[1]?.targetId, null);
  assert.equal(picks[1]?.confidence, "low");
}

{
  const picks = parseMatchingRankResponse(
    '[{"proposal_id":"p","target_id":"V10","confidence":"HIGH"}]',
  );
  assert.equal(picks[0]?.proposalId, "p");
  assert.equal(picks[0]?.targetId, "V10");
  assert.equal(picks[0]?.confidence, "high");
}

{
  assert.equal(parseMatchingRankResponse("no json here").length, 0);
}

{
  const sys = buildMatchingRankSystemPrompt(FIXTURE_PLAN);
  assert.match(sys, /Map key fields/);
  assert.match(sys, /soft_signal|hard_constraint/);
  assert.ok(LLM_RANK_BATCH_SIZE >= 4 && LLM_RANK_BATCH_SIZE <= 16);
}

console.log("llmRank.test.ts: ok");
