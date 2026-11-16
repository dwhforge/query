import { describe, expect, it } from "vitest";
import { DEFAULT_ESTIMATE_SAMPLE_PERCENT, estimateAcquiredEvaluation, validateEstimateSamplePercent } from "./estimateSampling";
import { evaluateSet } from "./setEvaluation";

const evaluation = evaluateSet({
  runId: "r", producer: "basic", planRevision: 1, contextFingerprint: "context",
  sourceScope: "unmatched", sourceComplete: true, targetComplete: true,
  sourceTotal: 100, rightTotal: 5, rightKeys: ["a", "b", "c", "d", "e"],
  rows: Array.from({ length: 100 }, (_, i) => ({
    id: `p${i}`, left: [`source-${i}`], sourceRows: 1,
    right: i % 4 === 0 ? null : [`right-${i % 5}`], candidateId: i % 4 === 0 ? null : `c${i}`,
    score: i % 4 === 0 ? null : 0.9, alternatives: 0,
    outcome: (i % 4 === 0 ? "no_proposal" : "proposed") as "no_proposal" | "proposed",
    searchIncomplete: false,
  })),
});

describe("sample Estimate, never Evaluate", () => {
  it("defaults to 5%, samples the acquired set, and leaves it unchanged", () => {
    const before = JSON.stringify(evaluation);
    const out = estimateAcquiredEvaluation(evaluation);
    expect(out.requestedPercent).toBe(DEFAULT_ESTIMATE_SAMPLE_PERCENT);
    expect(out.sampledKeys).toBe(5);
    expect(out.acquiredKeys).toBe(100);
    expect(out.basis).toBe("acquired_evaluation_only");
    expect(Object.values(out.projectedAcquired).reduce((a,b)=>a+b,0)).toBe(100);
    expect(JSON.stringify(evaluation)).toBe(before);
  });
  it("is stable across presentation ordering", () => {
    expect(estimateAcquiredEvaluation(evaluation, 17).sampled)
      .toEqual(estimateAcquiredEvaluation({ ...evaluation, rows: [...evaluation.rows].reverse() }, 17).sampled);
  });
  it("does not silently accept 0, >100, NaN or infinity", () => {
    for (const p of [0, -1, 100.1, NaN, Infinity]) expect(() => validateEstimateSamplePercent(p)).toThrow();
    expect(estimateAcquiredEvaluation(evaluation, 100).sampledKeys).toBe(100);
    expect(estimateAcquiredEvaluation(evaluation, 1).sampledKeys).toBe(1);
  });
  it("marks sampled incomplete proposals as incomplete, not proposed", () => {
    const rows = [{ ...evaluation.rows[0]!, outcome: "proposed" as const, right: ["right"], candidateId: "c0", searchIncomplete: true }];
    const set = evaluateSet({runId: "r", producer: "basic", planRevision: 1, contextFingerprint: "c", sourceScope: "all",
      sourceComplete: true, targetComplete: true, sourceTotal: 1, rightTotal: 1, rightKeys: ["right"], rows});
    const out = estimateAcquiredEvaluation(set);
    expect(out.sampled.incomplete).toBe(1);
    expect(out.sampled.proposed).toBe(0);
  });
});
