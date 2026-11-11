/**
 * Matching cascade (ADR-0044): cheap deterministic first, LLM only on residue.
 *
 * Tier 1 — normalize + Levenshtein / containment (retrieve; no thesaurus)
 * Tier 2 — LLM alias-expand → dictionary lookup (residue only)
 * Tier 3 — LLM rank inside allowlist (residue only)
 * Tier 4 — human confirm / defer
 *
 * High-confidence deterministic proposals must NOT burn LLM budget.
 */
import type { MatchingProposalView } from "./types";

/** Already decided — Mapping Save or human defer/reject. Never LLM again. */
export function isClosedProposal(p: MatchingProposalView): boolean {
  return (
    p.state === "saved" ||
    p.state === "confirmed_in_draft" ||
    p.state === "deferred" ||
    p.state === "rejected" ||
    p.state === "stale"
  );
}

/**
 * Strong enough that Tier 2–3 should skip this key.
 * Still never auto-Saves — user may bulk-confirm later.
 */
export function isDeterministicResolved(p: MatchingProposalView): boolean {
  if (isClosedProposal(p)) return true;
  if (p.searchIncomplete) return false;
  if (p.state !== "proposed") return false;
  if (!p.proposedCandidateId) return false;
  if (p.alternativeCandidateIds.length > 0) return false;
  // Already touched by LLM — leave in residue only if still ambiguous;
  // pure proposed+llm with no alts can skip re-rank.
  if (p.provenance === "llm") return true;
  return (
    p.provenance === "fuzzy" ||
    p.provenance === "fixture" ||
    p.provenance === "manual" ||
    p.provenance === "carried_over"
  );
}

/** Keys that still need semantic expand / LLM rank / human judgment. */
export function residueProposals(
  proposals: MatchingProposalView[],
): MatchingProposalView[] {
  return proposals.filter(
    (p) => !isClosedProposal(p) && !isDeterministicResolved(p),
  );
}

export function cascadeCounts(proposals: MatchingProposalView[]): {
  resolvedDeterministic: number;
  residue: number;
} {
  let resolvedDeterministic = 0;
  let residue = 0;
  for (const p of proposals) {
    if (isClosedProposal(p) || isDeterministicResolved(p)) {
      resolvedDeterministic += 1;
    } else {
      residue += 1;
    }
  }
  return { resolvedDeterministic, residue };
}

/** UI tier: how to read this row in the cascade. */
export type ProposalCascadeTier = "fuzzy" | "leftover" | "llm" | "manual";

export function proposalCascadeTier(
  p: MatchingProposalView,
): ProposalCascadeTier {
  // Real model output only — never paint "LLM" just because the trial left a residue.
  if (p.provenance === "llm") return "llm";
  const bucket = p.evidence.find((e) => e.field === "bucket")?.note ?? "";
  if (bucket.startsWith("manual")) return "manual";
  if (bucket.startsWith("fuzzy")) return "fuzzy";
  if (isDeterministicResolved(p) || isClosedProposal(p)) return "fuzzy";
  if (
    p.state === "no_candidates" ||
    (p.state === "ambiguous" &&
      !p.proposedCandidateId &&
      p.alternativeCandidateIds.length === 0)
  ) {
    return "manual";
  }
  // Opaque / geo / near-miss from trial — waiting for LLM, not a model pick yet.
  return "leftover";
}

export function cascadeTierLabel(t: ProposalCascadeTier): string {
  if (t === "fuzzy") return "Spelling";
  if (t === "llm") return "LLM suggested";
  if (t === "leftover") return "Unmatched";
  return "You decide";
}

/** One-line evidence for the table (not a soup of every note). */
export function proposalEvidenceSummary(p: MatchingProposalView): string {
  const llm = p.evidence.find((e) => e.field === "llm")?.note;
  const expand = p.evidence.find((e) => e.field === "expand")?.note;
  const primary = p.evidence.find(
    (e) => e.field === "name" || e.field === "region" || e.field === "search",
  )?.note;
  if (p.provenance === "llm" && llm) return llm;
  if (!isDeterministicResolved(p) && expand && !expand.includes("no new")) {
    return expand;
  }
  if (primary) return primary;
  return p.evidence.find((e) => e.field !== "bucket")?.note ?? "—";
}

export function cascadeTierCounts(proposals: MatchingProposalView[]): {
  fuzzy: number;
  leftover: number;
  llm: number;
  manual: number;
} {
  let fuzzy = 0;
  let leftover = 0;
  let llm = 0;
  let manual = 0;
  for (const p of proposals) {
    const t = proposalCascadeTier(p);
    if (t === "fuzzy") fuzzy += 1;
    else if (t === "leftover") leftover += 1;
    else if (t === "llm") llm += 1;
    else manual += 1;
  }
  return { fuzzy, leftover, llm, manual };
}
