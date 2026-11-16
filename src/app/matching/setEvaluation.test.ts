import { describe, expect, it } from "vitest";
import { evaluateSet, compareSetEvaluations, type SetEvaluationInput } from "./setEvaluation";

const input = (overrides: Partial<SetEvaluationInput> = {}): SetEvaluationInput => ({
  runId: "r1", producer: "basic", planRevision: 1, contextFingerprint: "same-context",
  sourceScope: "unmatched", sourceComplete: true, targetComplete: true,
  sourceTotal: 4, rightTotal: 3, rightKeys: ['["a"]', '["b"]', '["c"]'],
  rows: [
    { id: "1", left: ["A"], sourceRows: 3, right: ["a"], candidateId: "a", score: .95, alternatives: 1, outcome: "proposed", searchIncomplete: false },
    { id: "2", left: ["B"], sourceRows: 2, right: ["a"], candidateId: "a", score: .9, alternatives: 1, outcome: "proposed", searchIncomplete: false },
    { id: "3", left: ["C"], sourceRows: 1, right: ["b"], candidateId: "b", score: .8, alternatives: 2, outcome: "ambiguous", searchIncomplete: false },
    { id: "4", left: ["D"], sourceRows: 1, right: null, candidateId: null, score: null, alternatives: 0, outcome: "no_proposal", searchIncomplete: false },
  ], ...overrides,
});

describe("universal read-only Matching evaluation", () => {
  it("counts LEFT keys, source rows and shared RIGHT output groups independently", () => {
    const e = evaluateSet(input());
    expect(e.stats).toMatchObject({ acquiredKeys: 4, acquiredSourceRows: 7,
      proposed: 2, ambiguous: 1, noProposal: 1, incomplete: 0,
      distinctProposedOutputs: 1, manyToOneOutputGroups: 1, notAcquired: 0 });
  });
  it("does not turn unknown full scope into zero remaining", () => {
    const e = evaluateSet(input({ sourceComplete: null, sourceTotal: null }));
    expect(e.stats.notAcquired).toBeNull();
  });
  it("does not call an incomplete proposed row fully proposed", () => {
    const a = input();
    const rows = a.rows.map((r, i) => i === 0 ? { ...r, searchIncomplete: true } : r);
    expect(evaluateSet({ ...a, rows }).stats).toMatchObject({ proposed: 1, incomplete: 1 });
  });
  it("refuses to display falsely complete producer totals", () => {
    expect(() => evaluateSet(input({sourceTotal: 50}))).toThrow(/Complete source coverage/);
    expect(() => evaluateSet(input({rightTotal: 20}))).toThrow(/Complete RIGHT coverage/);
    expect(() => evaluateSet(input({sourceComplete: null, sourceTotal: 1}))).toThrow(/Invalid source total/);
  });
  it("rejects duplicate complete source tuples", () => {
    const a = input();
    expect(() => evaluateSet({ ...a, rows: [...a.rows, { ...a.rows[0]!, id: "duplicate" }] })).toThrow(/one outcome/);
  });
  it("rejects unmatched scopes, changed RIGHT universes and unknown coverage for A/B", () => {
    const a = evaluateSet(input());
    expect(compareSetEvaluations(a, evaluateSet(input({ sourceScope: "all" }))).comparable).toBe(false);
    expect(compareSetEvaluations(a, evaluateSet(input({ rightKeys: ['["other"]'] }))).comparable).toBe(false);
    expect(compareSetEvaluations(a, evaluateSet(input({ targetComplete: null }))).comparable).toBe(false);
  });
  it("compares same-key outcomes but never claims frozen external data", () => {
    const a = evaluateSet(input());
    const b = evaluateSet(input({ runId: "r2", rows: input().rows.map(r => r.id === "4"
      ? { ...r, right: ["c"], candidateId: "c", score: .99, outcome: "proposed" as const } : r) }));
    expect(compareSetEvaluations(a, b)).toMatchObject({ comparable: true,
      verifiedSameData: false, unchanged: 3, newProposals: 1 });
  });
});
