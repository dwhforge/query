/** Read-only, explicitly sampled exploration of an ALREADY acquired Matching evaluation.
 * This is NOT a Host preflight estimator or a complete-dataset evaluation.
 * UI pages must never be fed into this function; it accepts the evaluation set.
 */
import type { SetEvaluation, EvaluationOutcome } from "./setEvaluation";

export const DEFAULT_ESTIMATE_SAMPLE_PERCENT = 5;

export function validateEstimateSamplePercent(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 100)
    throw new RangeError("Estimate sample percentage must be between 1 and 100");
  return value;
}

/** FNV-1a over UTF-16 code units, deterministic for the same identity set. */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export type SampleEstimate = {
  requestedPercent: number;
  sampledKeys: number;
  acquiredKeys: number;
  /** Measured sample proportion, not an absolute population guarantee. */
  actualPercent: number;
  sampled: Readonly<Record<EvaluationOutcome, number>>;
  /** Simple extrapolation to acquired source-key count, not a scored evaluation. */
  projectedAcquired: Readonly<Record<EvaluationOutcome, number>>;
  /** This API cannot infer total live source rows outside the acquired scope. */
  basis: "acquired_evaluation_only";
};

const outcomes: readonly EvaluationOutcome[] = [
  "proposed", "ambiguous", "no_proposal", "below_threshold", "incomplete", "confirmed_draft",
  "deferred", "rejected", "saved", "stale",
];

export function estimateAcquiredEvaluation(
  evaluation: SetEvaluation, percent = DEFAULT_ESTIMATE_SAMPLE_PERCENT,
): SampleEstimate {
  validateEstimateSamplePercent(percent);
  if (evaluation.rows.length === 0) throw new Error("No acquired keys available to sample");
  // Exact sample size; smallest run can still produce one sampled record.
  const sampleSize = Math.max(1, Math.ceil(evaluation.rows.length * percent / 100));
  const selected = [...evaluation.rows]
    .sort((a, b) => stableHash(a.sourceKey) - stableHash(b.sourceKey) || a.sourceKey.localeCompare(b.sourceKey))
    .slice(0, sampleSize);
  const sampled = Object.fromEntries(outcomes.map(k => [k, 0])) as Record<EvaluationOutcome, number>;
  for (const row of selected) {
    // Incomplete evidence takes priority; never count it as an actionable proposal.
    const outcome = row.searchIncomplete && ["proposed", "ambiguous", "no_proposal", "below_threshold"].includes(row.outcome)
      ? "incomplete" : row.outcome;
    sampled[outcome]++;
  }
  const factor = evaluation.rows.length / selected.length;
  // Largest-remainder apportionment: projected buckets remain mutually exclusive
  // and sum to the acquired key count, even when the sample is tiny.
  const fractions = outcomes.map((key, index) => {
    const exact = sampled[key] * factor;
    return { key, index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = evaluation.rows.length - fractions.reduce((n, part) => n + part.value, 0);
  for (const part of [...fractions].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (unassigned-- <= 0) break;
    part.value++;
  }
  const projectedAcquired = Object.fromEntries(fractions.map(p => [p.key, p.value])) as Record<EvaluationOutcome, number>;
  return {
    requestedPercent: percent, sampledKeys: selected.length,
    acquiredKeys: evaluation.rows.length, actualPercent: 100 * selected.length / evaluation.rows.length,
    sampled, projectedAcquired, basis: "acquired_evaluation_only",
  };
}
