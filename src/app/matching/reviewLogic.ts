/** Pure Matching review / bulk / counters (ADR-0044). */
import { proposalCascadeTier } from "./cascade";
import {
  mapKeyToken,
  type MatchingCandidateView,
  type MatchingDecisionKind,
  type MatchingDecisionView,
  type MatchingFinalDiffRow,
  type MatchingProposalState,
  type MatchingProposalView,
  type MatchingReviewFilter,
  type MatchingTabSession,
} from "./types";

/**
 * Ready = Fuzzy first (prove they're still there), then LLM picks.
 * Needs decision after LLM = model/manual residue first, Fuzzy last.
 */
function sortForReview(
  proposals: MatchingProposalView[],
  filter: MatchingReviewFilter,
): MatchingProposalView[] {
  const llmRan = proposals.some((p) => p.provenance === "llm");
  const rank = (p: MatchingProposalView) => {
    const t = proposalCascadeTier(p);
    if (filter === "ready") {
      if (t === "fuzzy" || p.provenance === "fuzzy") return 0;
      if (t === "leftover") return 1;
      if (p.provenance === "llm" || t === "llm") return 2;
      return 3;
    }
    if (llmRan && filter === "needs_decision") {
      if (p.provenance === "llm") return 0;
      if (t === "leftover") return 1;
      if (t === "manual") return 2;
      return 3;
    }
    if (t === "fuzzy") return 0;
    if (t === "leftover") return 1;
    if (t === "llm") return 2;
    return 3;
  };
  return [...proposals].sort((a, b) => rank(a) - rank(b));
}

/** Counts inside Ready: Fuzzy vs LLM vs Manual — same labels as the table. */
export function readyTierSplit(proposals: MatchingProposalView[]): {
  fuzzy: number;
  leftover: number;
  llm: number;
  other: number;
  total: number;
} {
  const ready = filterProposals(proposals, "ready");
  let fuzzy = 0;
  let leftover = 0;
  let llm = 0;
  let other = 0;
  for (const p of ready) {
    const t = proposalCascadeTier(p);
    if (t === "fuzzy") fuzzy += 1;
    else if (t === "leftover") leftover += 1;
    else if (t === "llm") llm += 1;
    else other += 1;
  }
  return { fuzzy, leftover, llm, other, total: ready.length };
}

export function filterProposals(
  proposals: MatchingProposalView[],
  filter: MatchingReviewFilter,
): MatchingProposalView[] {
  let list: MatchingProposalView[];
  switch (filter) {
    case "all":
      list = proposals;
      break;
    case "needs_decision":
      list = proposals.filter((p) =>
        ["proposed", "ambiguous", "no_candidates", "incomplete_search"].includes(
          p.state,
        ),
      );
      break;
    case "ready":
      // Combined Fuzzy + LLM outcome: clear proposed picks ready to confirm/Save.
      list = proposals.filter(
        (p) =>
          p.state === "proposed" &&
          Boolean(p.proposedCandidateId) &&
          !p.searchIncomplete,
      );
      break;
    case "ambiguous":
      list = proposals.filter((p) => p.state === "ambiguous");
      break;
    case "incomplete_search":
      list = proposals.filter(
        (p) => p.state === "incomplete_search" || p.searchIncomplete,
      );
      break;
    case "confirmed":
      list = proposals.filter((p) => p.state === "confirmed_in_draft");
      break;
    case "saved":
      list = proposals.filter((p) => p.state === "saved");
      break;
    case "stale":
      list = proposals.filter((p) => p.state === "stale");
      break;
    default:
      list = proposals;
  }
  return sortForReview(list, filter);
}

export function matchingCounters(session: MatchingTabSession): {
  sourceRows: number;
  uniqueKeys: number;
  proposals: number;
  confirmed: number;
} {
  const keys = new Set(session.proposals.map((p) => mapKeyToken(p.mapKey)));
  const sourceRows = session.proposals.reduce(
    (n, p) => n + p.affectedSourceRows,
    0,
  );
  const confirmed = session.decisions.filter((d) =>
    ["confirm_proposed", "choose_alternative", "no_suitable_target"].includes(
      d.kind,
    ),
  ).length;
  return {
    sourceRows,
    uniqueKeys: keys.size,
    proposals: session.proposals.length,
    confirmed,
  };
}

export function pageSlice<T>(items: T[], pageIndex: number, pageSize: number): T[] {
  const start = pageIndex * pageSize;
  return items.slice(start, start + pageSize);
}

export type BulkConfirmScope = "selection" | "page" | "filter";

export type BulkConfirmPreview = {
  scope: BulkConfirmScope;
  keyCount: number;
  affectedSourceRows: number;
  includedProposalIds: string[];
  excluded: { proposalId: string; reason: string }[];
};

const BULK_EXCLUDE_STATES: MatchingProposalState[] = [
  "ambiguous",
  "incomplete_search",
  "stale",
  "confirmed_in_draft",
  "deferred",
  "rejected",
  "saved",
];

/** Ordinary bulk: only clear proposed (non-ambiguous) with a proposed candidate. */
export function previewBulkConfirm(
  session: MatchingTabSession,
  scope: BulkConfirmScope,
  selectedIds: string[],
): BulkConfirmPreview {
  const filtered = filterProposals(session.proposals, session.reviewFilter);
  const page = pageSlice(filtered, session.pageIndex, session.pageSize);
  const pool =
    scope === "selection"
      ? session.proposals.filter((p) => selectedIds.includes(p.proposalId))
      : scope === "page"
        ? page
        : filtered;

  const included: MatchingProposalView[] = [];
  const excluded: BulkConfirmPreview["excluded"] = [];
  const seenKeys = new Set<string>();

  for (const p of pool) {
    if (BULK_EXCLUDE_STATES.includes(p.state)) {
      excluded.push({ proposalId: p.proposalId, reason: p.state });
      continue;
    }
    if (!p.proposedCandidateId) {
      excluded.push({ proposalId: p.proposalId, reason: "no_proposed_candidate" });
      continue;
    }
    const token = mapKeyToken(p.mapKey);
    if (seenKeys.has(token)) {
      excluded.push({ proposalId: p.proposalId, reason: "duplicate_key" });
      continue;
    }
    // Conflict: another proposal same key different target still in pool
    const conflict = pool.some(
      (o) =>
        o.proposalId !== p.proposalId &&
        mapKeyToken(o.mapKey) === token &&
        o.proposedCandidateId &&
        o.proposedCandidateId !== p.proposedCandidateId,
    );
    if (conflict) {
      excluded.push({ proposalId: p.proposalId, reason: "conflict_proposals" });
      continue;
    }
    seenKeys.add(token);
    included.push(p);
  }

  return {
    scope,
    keyCount: included.length,
    affectedSourceRows: included.reduce((n, p) => n + p.affectedSourceRows, 0),
    includedProposalIds: included.map((p) => p.proposalId),
    excluded,
  };
}

export function applyBulkConfirm(
  session: MatchingTabSession,
  preview: BulkConfirmPreview,
): MatchingTabSession {
  const included = new Set(preview.includedProposalIds);
  const decisions = [...session.decisions];
  const proposals = session.proposals.map((p) => {
    if (!included.has(p.proposalId)) return p;
    const kind: MatchingDecisionKind = "confirm_proposed";
    const existing = decisions.findIndex(
      (d) => mapKeyToken(d.mapKey) === mapKeyToken(p.mapKey),
    );
    const decision: MatchingDecisionView = {
      mapKey: p.mapKey,
      kind,
      candidateId: p.proposedCandidateId,
      proposalId: p.proposalId,
      expectedSemanticRevision: p.semanticPlanRevision,
    };
    if (existing >= 0) decisions[existing] = decision;
    else decisions.push(decision);
    return { ...p, state: "confirmed_in_draft" as const };
  });
  return {
    ...session,
    proposals,
    decisions,
    hasUnsavedDecisions: true,
  };
}

export function applyDecision(
  session: MatchingTabSession,
  proposalId: string,
  kind: MatchingDecisionKind,
  candidateId: string | null,
): MatchingTabSession {
  const proposal = session.proposals.find((p) => p.proposalId === proposalId);
  if (!proposal) return session;
  if (proposal.state === "stale") return session;

  const decision: MatchingDecisionView = {
    mapKey: proposal.mapKey,
    kind,
    candidateId,
    proposalId,
    expectedSemanticRevision: proposal.semanticPlanRevision,
  };
  const decisions = session.decisions.filter(
    (d) => mapKeyToken(d.mapKey) !== mapKeyToken(proposal.mapKey),
  );
  decisions.push(decision);

  let state: MatchingProposalState = proposal.state;
  if (kind === "confirm_proposed" || kind === "choose_alternative") {
    state = "confirmed_in_draft";
  } else if (kind === "defer") state = "deferred";
  else if (kind === "reject" || kind === "no_suitable_target") state = "rejected";

  return {
    ...session,
    decisions,
    proposals: session.proposals.map((p) =>
      p.proposalId === proposalId
        ? {
            ...p,
            state,
            proposedCandidateId:
              kind === "choose_alternative" && candidateId
                ? candidateId
                : p.proposedCandidateId,
          }
        : p,
    ),
    hasUnsavedDecisions: true,
  };
}

export function candidateById(
  session: MatchingTabSession,
  id: string | null | undefined,
): MatchingCandidateView | undefined {
  if (!id) return undefined;
  return session.candidates.find((c) => c.candidateId === id);
}

export function buildFinalDiff(
  session: MatchingTabSession,
): MatchingFinalDiffRow[] {
  const live = new Map(
    session.mapLive.map((r) => [mapKeyToken(r.fromParts), r.outputValues]),
  );
  const rows: MatchingFinalDiffRow[] = [];
  const decidedKeys = new Set<string>();

  for (const d of session.decisions) {
    const token = mapKeyToken(d.mapKey);
    decidedKeys.add(token);
    const proposal = session.proposals.find((p) => p.proposalId === d.proposalId);
    if (
      d.kind === "defer" ||
      d.kind === "reject" ||
      d.kind === "no_suitable_target"
    ) {
      rows.push({
        mapKey: d.mapKey,
        kind: "unresolved",
        oldOutputs: live.get(token) ?? null,
        newOutputs: null,
        origin: d.kind,
        affectedSourceRows: proposal?.affectedSourceRows ?? 1,
      });
      continue;
    }
    const cand = candidateById(session, d.candidateId);
    if (!cand) {
      rows.push({
        mapKey: d.mapKey,
        kind: "unresolved",
        oldOutputs: live.get(token) ?? null,
        newOutputs: null,
        origin: "missing_candidate",
        affectedSourceRows: proposal?.affectedSourceRows ?? 1,
      });
      continue;
    }
    const old = live.get(token) ?? null;
    if (old && old.join("\0") === cand.outputValues.join("\0")) {
      rows.push({
        mapKey: d.mapKey,
        kind: "noop",
        oldOutputs: old,
        newOutputs: cand.outputValues,
        origin: d.kind,
        affectedSourceRows: proposal?.affectedSourceRows ?? 1,
      });
    } else if (!old) {
      rows.push({
        mapKey: d.mapKey,
        kind: "add",
        oldOutputs: null,
        newOutputs: cand.outputValues,
        origin: d.kind,
        affectedSourceRows: proposal?.affectedSourceRows ?? 1,
      });
    } else {
      rows.push({
        mapKey: d.mapKey,
        kind: "change",
        oldOutputs: old,
        newOutputs: cand.outputValues,
        origin: d.kind,
        affectedSourceRows: proposal?.affectedSourceRows ?? 1,
      });
    }
  }

  for (const p of session.proposals) {
    const token = mapKeyToken(p.mapKey);
    if (decidedKeys.has(token)) continue;
    if (["proposed", "ambiguous", "incomplete_search", "no_candidates"].includes(p.state)) {
      rows.push({
        mapKey: p.mapKey,
        kind: "unresolved",
        oldOutputs: live.get(token) ?? null,
        newOutputs: null,
        origin: "undecided",
        affectedSourceRows: p.affectedSourceRows,
      });
    }
  }

  return rows;
}

export function summarizeFinalDiff(rows: MatchingFinalDiffRow[]): {
  adds: number;
  changes: number;
  unresolved: number;
  affectedSourceRows: number;
} {
  return {
    adds: rows.filter((r) => r.kind === "add").length,
    changes: rows.filter((r) => r.kind === "change").length,
    unresolved: rows.filter((r) => r.kind === "unresolved").length,
    affectedSourceRows: rows
      .filter((r) => r.kind === "add" || r.kind === "change" || r.kind === "noop")
      .reduce((n, r) => n + r.affectedSourceRows, 0),
  };
}

/** Materialized decisions for host matching_plan_commit / accept_draft. */
export function materializedFromSession(session: MatchingTabSession): {
  mapKey: string[];
  candidateId: string;
  targetId: string;
  outputValues: string[];
  proposalId: string;
  affectedSourceRows: number;
}[] {
  const out = [];
  for (const d of session.decisions) {
    if (
      d.kind !== "confirm_proposed" &&
      d.kind !== "choose_alternative"
    ) {
      continue;
    }
    const cand = candidateById(session, d.candidateId);
    const proposal = session.proposals.find((p) => p.proposalId === d.proposalId);
    if (!cand || !proposal) continue;
    out.push({
      mapKey: d.mapKey,
      candidateId: cand.candidateId,
      targetId: cand.targetId,
      outputValues: cand.outputValues,
      proposalId: d.proposalId,
      affectedSourceRows: proposal.affectedSourceRows,
    });
  }
  return out;
}
