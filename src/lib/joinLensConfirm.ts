/**
 * Join Lens in-place match confirm (ADR-0042).
 * Session staging lives in the Lens; KeyMap is SoT only after Apply accepted.
 */
import type { FuzzyPair } from "./bridge";

export type LensConfirmDecision = "accepted" | "pending" | "skipped";
export type LensConfirmSource = "fuzzy" | "llm";

export type LensConfirmProposal = {
  id: string;
  from_key: string;
  to_key: string;
  alt_to_key?: string | null;
  from_label?: string | null;
  to_label?: string | null;
  score: number;
  edits: number;
  ambiguous: boolean;
  from_parts?: string[];
  source: LensConfirmSource;
  decision: LensConfirmDecision;
  why?: string;
};

export function proposalsFromFuzzy(
  suggestions: FuzzyPair[],
): LensConfirmProposal[] {
  return suggestions.map((p, i) => ({
    id: `fuzzy:${i}:${p.from_key}→${p.to_key}`,
    from_key: p.from_key,
    to_key: p.to_key,
    alt_to_key: p.alt_to_key,
    from_label: p.from_label,
    to_label: p.to_label,
    score: p.score,
    edits: p.edits,
    ambiguous: p.ambiguous,
    from_parts: p.from_parts,
    source: "fuzzy",
    decision: p.ambiguous ? "pending" : "accepted",
  }));
}

export function proposalsFromLlmPairs(
  pairs: { from: string; to: string; why?: string }[],
  existing: LensConfirmProposal[],
): LensConfirmProposal[] {
  const taken = new Set(
    existing.map((p) => p.from_key.trim().toLowerCase()),
  );
  const out: LensConfirmProposal[] = [];
  pairs.forEach((p, i) => {
    const from = p.from.trim();
    const to = p.to.trim();
    if (!from || !to) return;
    if (taken.has(from.toLowerCase())) return;
    taken.add(from.toLowerCase());
    out.push({
      id: `llm:${i}:${from}→${to}`,
      from_key: from,
      to_key: to,
      score: 0,
      edits: 0,
      ambiguous: true,
      source: "llm",
      decision: "pending",
      why: p.why,
    });
  });
  return out;
}

/** Accept best (or a chosen candidate To). */
export function acceptProposal(
  p: LensConfirmProposal,
  toKey?: string,
): LensConfirmProposal {
  const nextTo = (toKey ?? p.to_key).trim();
  if (!nextTo) return p;
  return { ...p, to_key: nextTo, decision: "accepted" };
}

export function skipProposal(p: LensConfirmProposal): LensConfirmProposal {
  return { ...p, decision: "skipped" };
}

export function reopenProposal(p: LensConfirmProposal): LensConfirmProposal {
  return {
    ...p,
    decision: p.ambiguous || p.source === "llm" ? "pending" : "accepted",
  };
}

export function acceptedProposals(
  proposals: LensConfirmProposal[],
): LensConfirmProposal[] {
  return proposals.filter((p) => p.decision === "accepted" && p.to_key.trim());
}

export function pendingProposals(
  proposals: LensConfirmProposal[],
): LensConfirmProposal[] {
  return proposals.filter((p) => p.decision === "pending");
}

export function collectAcceptedPairs(proposals: LensConfirmProposal[]): {
  fromValues: string[];
  toValues: string[];
  fromParts: string[][];
  fromLabels: (string | null)[];
  toLabels: (string | null)[];
} {
  const accepted = acceptedProposals(proposals);
  return {
    fromValues: accepted.map((p) => p.from_key),
    toValues: accepted.map((p) => p.to_key),
    fromParts: accepted.map((p) =>
      p.from_parts?.length ? p.from_parts : [p.from_key],
    ),
    fromLabels: accepted.map((p) => p.from_label?.trim() || null),
    toLabels: accepted.map((p) => p.to_label?.trim() || null),
  };
}
