/** Universal, read-only Matching evaluation projection.
 *
 * No JOIN, Mapping, Host, UI or user-decision authority lives here. The caller
 * provides explicitly acquired source and target identities, producer outcomes,
 * coverage and the exact context. Unknown means unknown, never zero.
 */
export type SetTuple = readonly (string | null)[];
export const setTupleKey = (parts: SetTuple): string => JSON.stringify(parts);

export type EvaluationOutcome =
  | "proposed" | "ambiguous" | "no_proposal" | "below_threshold" | "incomplete"
  | "confirmed_draft" | "deferred" | "rejected" | "saved" | "stale";

export type SetEvaluationInput = {
  runId: string;
  producer: "basic" | "advanced";
  planRevision: number;
  contextFingerprint: string | null;
  sourceScope: "unmatched" | "all" | "selected" | "unknown";
  sourceComplete: boolean | null;
  targetComplete: boolean | null;
  sourceTotal: number | null;
  rightTotal: number | null;
  /** Identity of acquired RIGHT values, not the scored shortlist. */
  rightKeys: readonly string[];
  rows: readonly {
    id: string;
    left: SetTuple;
    sourceRows: number;
    right: SetTuple | null;
    candidateId: string | null;
    score: number | null;
    alternatives: number;
    outcome: EvaluationOutcome;
    /** Whether search was limited beyond the declared overall scope. */
    searchIncomplete: boolean;
  }[];
};

export type SetEvaluationRow = SetEvaluationInput["rows"][number] & { readonly sourceKey: string };
export type SetEvaluation = {
  readonly runId: string;
  readonly producer: SetEvaluationInput["producer"];
  readonly planRevision: number;
  readonly contextFingerprint: string | null;
  readonly sourceScope: SetEvaluationInput["sourceScope"];
  readonly sourceComplete: boolean | null;
  readonly targetComplete: boolean | null;
  readonly sourceTotal: number | null;
  readonly rightTotal: number | null;
  readonly rightKeys: readonly string[];
  readonly rows: readonly SetEvaluationRow[];
  readonly stats: {
    acquiredKeys: number;
    acquiredSourceRows: number;
    proposed: number;
    ambiguous: number;
    noProposal: number;
    belowThreshold: number;
    incomplete: number;
    confirmedDraft: number;
    otherDecided: number;
    /** Distinct proposed RIGHT output tuples, NOT independent RIGHT identities. */
    distinctProposedOutputs: number;
    manyToOneOutputGroups: number;
    /** Unknown when the upstream acquisition cannot establish a total. */
    notAcquired: number | null;
  };
};

export function evaluateSet(input: SetEvaluationInput): SetEvaluation {
  const seen = new Set<string>();
  const rows = input.rows.map(row => {
    const sourceKey = setTupleKey(row.left);
    if (seen.has(sourceKey)) throw new Error("Evaluation requires one outcome per complete LEFT key");
    if (!Number.isSafeInteger(row.sourceRows) || row.sourceRows < 0)
      throw new Error("Invalid source row count");
    if (row.outcome === "proposed" && (!row.right || !row.candidateId))
      throw new Error("A proposed relation requires an acquired RIGHT candidate");
    seen.add(sourceKey);
    return { ...row, left: [...row.left], right: row.right && [...row.right], sourceKey };
  });
  // "Complete" is an auditable contract, not a UI-friendly default. Reject
  // inconsistent producer totals rather than silently showing zero unacquired.
  if (input.sourceTotal != null && (!Number.isSafeInteger(input.sourceTotal) || input.sourceTotal < rows.length))
    throw new Error("Invalid source total for the acquired LEFT key set");
  if (input.rightTotal != null && (!Number.isSafeInteger(input.rightTotal) || input.rightTotal < input.rightKeys.length))
    throw new Error("Invalid RIGHT total for the acquired identity set");
  if (input.sourceComplete === true && input.sourceTotal != null && input.sourceTotal !== rows.length)
    throw new Error("Complete source coverage contradicts the producer total");
  if (input.targetComplete === true && input.rightTotal != null && input.rightTotal !== input.rightKeys.length)
    throw new Error("Complete RIGHT coverage contradicts the producer total");
  const count = (outcome: EvaluationOutcome) => rows.filter(r => r.outcome === outcome).length;
  const outputUse = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "proposed" || !row.right || row.searchIncomplete) continue;
    const k = setTupleKey(row.right);
    outputUse.set(k, (outputUse.get(k) ?? 0) + 1);
  }
  const notAcquired = input.sourceComplete === true ? 0
    : input.sourceTotal == null ? null
    : Math.max(0, input.sourceTotal - rows.length);
  return {
    runId: input.runId, producer: input.producer,
    planRevision: input.planRevision,
    contextFingerprint: input.contextFingerprint,
    sourceScope: input.sourceScope,
    sourceComplete: input.sourceComplete, targetComplete: input.targetComplete,
    sourceTotal: input.sourceTotal, rightTotal: input.rightTotal,
    rightKeys: [...input.rightKeys], rows,
    stats: {
      acquiredKeys: rows.length,
      acquiredSourceRows: rows.reduce((n, r) => n + r.sourceRows, 0),
      proposed: rows.filter(r => r.outcome === "proposed" && !r.searchIncomplete).length,
      ambiguous: count("ambiguous"),
      noProposal: count("no_proposal"),
      belowThreshold: count("below_threshold"),
      incomplete: rows.filter(r => r.outcome === "incomplete" || (r.outcome === "proposed" && r.searchIncomplete)).length,
      confirmedDraft: count("confirmed_draft"),
      otherDecided: count("deferred") + count("rejected") + count("saved") + count("stale"),
      distinctProposedOutputs: outputUse.size,
      manyToOneOutputGroups: [...outputUse.values()].filter(n => n > 1).length,
      notAcquired,
    },
  };
}

export type EvaluationComparison =
  | { comparable: false; reason: string }
  | { comparable: true; verifiedSameData: false; warning: string; unchanged: number; newProposals: number;
      lostProposals: number; changed: number };

/** An equal query definition cannot prove external rows did not change.
 * Therefore cross-run comparisons remain provisional without a Host data snapshot.
 */
export function compareSetEvaluations(a: SetEvaluation, b: SetEvaluation): EvaluationComparison {
  if (a.sourceScope !== b.sourceScope || a.producer !== b.producer)
    return { comparable: false, reason: "Different producer or requested LEFT scope" };
  if (!a.contextFingerprint || a.contextFingerprint !== b.contextFingerprint)
    return { comparable: false, reason: "Different or unknown execution context" };
  if (a.sourceComplete !== true || b.sourceComplete !== true ||
      a.targetComplete !== true || b.targetComplete !== true)
    return { comparable: false, reason: "Incomplete or unknown acquisition coverage" };
  if (JSON.stringify([...a.rightKeys].sort()) !== JSON.stringify([...b.rightKeys].sort()))
    return { comparable: false, reason: "Acquired RIGHT identity sets differ" };
  const old = new Map(a.rows.map(r => [r.sourceKey, r]));
  if (a.rows.length !== b.rows.length || b.rows.some(r => !old.has(r.sourceKey)))
    return { comparable: false, reason: "Acquired LEFT key sets differ" };
  let unchanged = 0, newProposals = 0, lostProposals = 0, changed = 0;
  const proposedKey = (r: SetEvaluationRow) => r.outcome === "proposed" && r.right && !r.searchIncomplete
    ? setTupleKey(r.right) : null;
  for (const row of b.rows) {
    const prior = old.get(row.sourceKey)!;
    const aKey = proposedKey(prior), bKey = proposedKey(row);
    if (aKey === bKey && prior.outcome === row.outcome && prior.searchIncomplete === row.searchIncomplete) unchanged++;
    else if (!aKey && bKey) newProposals++;
    else if (aKey && !bKey) lostProposals++;
    else changed++;
  }
  return { comparable: true, verifiedSameData: false,
    warning: "Same acquired identities and definition; source values may have changed between runs. Comparison is indicative, not a verified same-data experiment.",
    unchanged, newProposals, lostProposals, changed };
}
