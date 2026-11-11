import assert from "node:assert/strict";
import { isDeterministicResolved } from "./cascade";
import {
  aliasesForValue,
  allowlistHitsForProposal,
  applyAllowlistToProposals,
  cheapFieldHit,
  norm,
  parseAliasExpandResponse,
  widenAllowlistDeterministic,
} from "./semanticExpand";
import { emptyMatchingSession } from "./types";
import {
  FIXTURE_CANDIDATES,
  FIXTURE_PLAN,
  fixtureProposals,
} from "./fixtures";

{
  const rows = parseAliasExpandResponse(`\`\`\`json
[{"sourceValue":"USA","aliases":["United States","US"]},{"sourceValue":"NW bottled water","aliases":["Nestlé Waters"]}]
\`\`\``);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.aliases, ["United States", "US"]);
}

{
  assert.equal(norm("Nestlé Waters"), norm("Nestle Waters"));
  assert.ok(cheapFieldHit("Nestlé Waters", "Nestle Waters"));
  const map = new Map([
    [norm("NW bottled water"), ["Nestle Waters", "Nestlé Waters"]],
  ]);
  assert.deepEqual(aliasesForValue("NW bottled water #12", map), [
    "Nestle Waters",
    "Nestlé Waters",
  ]);
}

{
  // Region alone must NOT admit when soft name doesn't match (flood guard).
  const p = fixtureProposals().find((x) => x.proposalId === "prop:incomplete")!;
  const targets = [
    { targetId: "1", fields: { name: "a1", region: "Asia" } },
    { targetId: "99", fields: { name: "Other Co", region: "Asia" } },
  ];
  const hits = allowlistHitsForProposal(p, FIXTURE_PLAN, targets);
  assert.equal(hits.length, 0, `expected no region-alone hits, got ${hits}`);
}

{
  // Deterministic widen is containment/exact only — EU↔Europe needs LLM aliases.
  const session = {
    ...emptyMatchingSession({
      id: "s1",
      title: "t",
      entry: "mapping",
      scope: "cohort",
      instructionText: "",
      plan: FIXTURE_PLAN,
      hasUnsavedDecisions: false,
      chatCollapsed: true,
    }),
    candidates: FIXTURE_CANDIDATES,
    proposals: fixtureProposals().map((p) =>
      p.proposalId === "prop:a1-eurpope"
        ? {
            ...p,
            sourceValues: { provider: "a1", region: "Europe" },
            mapKey: ["a1", "Europe"],
          }
        : p,
    ),
  };
  const allow = widenAllowlistDeterministic(session, [
    { targetId: "1", fields: { name: "a1", region: "Europe" } },
    { targetId: "2", fields: { name: "a1", region: "RUS" } },
  ]);
  const hit = allow["prop:a1-eurpope"] ?? [];
  assert.ok(hit.includes("1"), `exact Europe should hit, got ${JSON.stringify(hit)}`);

  // Fuzzy Tier‑1 keys must not appear in expand allowlists.
  const fuzzyId = session.proposals.find(
    (p) => p.proposalId.startsWith("prop:fuzzy-") && isDeterministicResolved(p),
  )?.proposalId;
  assert.ok(fuzzyId);
  assert.equal(allow[fuzzyId!], undefined);

  // Applying a flooded allowlist must still leave fuzzy untouched.
  const flooded = { ...allow, [fuzzyId!]: ["1", "2", "3", "100", "101"] };
  const next = applyAllowlistToProposals(session, flooded);
  const fuzzyAfter = next.proposals.find((p) => p.proposalId === fuzzyId)!;
  assert.equal(fuzzyAfter.alternativeCandidateIds.length, 0);
  assert.ok(!fuzzyAfter.evidence.some((e) => e.field === "expand"));
}

{
  // Opaque fixture row + evidence seed → dictionary hit without live LLM.
  const aliasProp = fixtureProposals().find(
    (p) => p.proposalId === "prop:llm-alias-0",
  )!;
  assert.ok(aliasProp);
  const session = {
    ...emptyMatchingSession({
      id: "s2",
      title: "t",
      entry: "mapping",
      scope: "cohort",
      instructionText: "",
      plan: FIXTURE_PLAN,
      hasUnsavedDecisions: false,
      chatCollapsed: true,
    }),
    candidates: FIXTURE_CANDIDATES,
    proposals: [aliasProp],
  };
  const targets = FIXTURE_CANDIDATES.map((c) => ({
    targetId: c.targetId,
    fields: c.fields,
  }));
  // Simulate LLM aliases for the opaque label.
  const fakeAllow: Record<string, string[]> = {};
  const aliases = ["Nestle Waters", "Nestlé Waters"];
  const hits = new Set<string>();
  for (const t of targets) {
    for (const al of aliases) {
      if (cheapFieldHit(al, t.fields.name ?? "")) hits.add(t.targetId);
    }
  }
  fakeAllow[aliasProp.proposalId] = [...hits];
  assert.ok(
    hits.size > 0,
    "dictionary must contain Nestle Waters for opaque expand demo",
  );
  const next = applyAllowlistToProposals(session, fakeAllow);
  const after = next.proposals[0]!;
  assert.ok(after.alternativeCandidateIds.length > 0);
  assert.ok(
    after.evidence.some((e) => e.note.includes("LLM expand +")),
    after.evidence.map((e) => e.note).join("; "),
  );
}

console.log("semanticExpand.test.ts: ok");
