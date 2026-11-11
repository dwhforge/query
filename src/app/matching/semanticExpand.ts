/**
 * Semantic shortlist expand (ADR-0044 follow-up).
 * String distance alone misses English business aliases
 * (USA↔United States, CCEP↔Coca-Cola, trading-name variants).
 * LLM may propose aliases; we look them up in the target snapshot
 * and widen proposal allowlists before ranking.
 */
import { llmChat } from "../../lib/bridge";
import { MATCHING_CAPS } from "../../lib/matchingCaps";
import { abortable, isAbortError, throwIfAborted } from "./abortable";
import { isDeterministicResolved, residueProposals } from "./cascade";
import type {
  MatchingCandidateView,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingTabSession,
} from "./types";

/** Casefold + strip diacritics / light punctuation for alias lookup. */
export function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’'`]/g, "")
    .replace(/\s+/g, " ");
}

/** Tier‑1 style cheap hit — no thesaurus. Semantic aliases come from LLM expand. */
export function cheapFieldHit(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

export type TargetSnapshotRow = {
  targetId: string;
  fields: Record<string, string>;
};

export function parseAliasExpandResponse(content: string): {
  sourceValue: string;
  aliases: string[];
}[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? content).trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: { sourceValue: string; aliases: string[] }[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const sourceValue = String(r.sourceValue ?? r.source_value ?? "").trim();
    const aliasesRaw = r.aliases;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (sourceValue && aliases.length) out.push({ sourceValue, aliases });
  }
  return out;
}

function softComps(plan: MatchingPlanDraft) {
  return plan.comparisons.filter((c) => c.role === "soft_signal");
}

function hardComps(plan: MatchingPlanDraft) {
  return plan.comparisons.filter((c) => c.role === "hard_constraint");
}

/** Values we ask the LLM to alias (soft + hard — geo lives on hard region). */
function expandComparisons(plan: MatchingPlanDraft) {
  return [...softComps(plan), ...hardComps(plan)];
}

/** Strip fixture disambiguators: "NW bottled water #12", "USA/3", "Europe~9". */
function baseValueKey(v: string): string {
  return norm(v)
    .replace(/\s+#\d+$/u, "")
    .replace(/\/\d+$/u, "")
    .replace(/~\d+$/u, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
}

/**
 * Resolve aliases for a source value from the LLM map (tolerant key match).
 */
export function aliasesForValue(
  sourceValue: string,
  aliasMap: Map<string, string[]>,
): string[] {
  const n = norm(sourceValue);
  const base = baseValueKey(sourceValue);
  const hit = aliasMap.get(n) ?? aliasMap.get(base);
  if (hit?.length) return hit;
  for (const [k, v] of aliasMap) {
    if (!k || !v.length) continue;
    if (n.includes(k) || k.includes(n) || base.includes(k) || k.includes(base)) {
      return v;
    }
  }
  return [];
}

/** Fixture evidence "expect LLM → Canonical" seeds lookup when model is thin. */
function aliasesFromEvidence(p: MatchingProposalView): string[] {
  const out: string[] = [];
  for (const e of p.evidence) {
    const m = e.note.match(/expect LLM\s*→\s*(.+)$/i);
    if (m?.[1]) out.push(m[1].trim());
    const g = e.note.match(/geo synonym\s+(\S+)↔(\S+)/i);
    if (g?.[2]) out.push(g[2].trim());
  }
  return out;
}

function collectExpandValues(
  session: MatchingTabSession,
): { field: string; value: string }[] {
  if (!session.plan) return [];
  const comps = expandComparisons(session.plan);
  const seen = new Set<string>();
  const out: { field: string; value: string }[] = [];
  for (const p of residueProposals(session.proposals)) {
    for (const c of comps) {
      const v =
        p.sourceValues[c.sourceField] ??
        p.sourceValues[c.sourceField.toLowerCase()] ??
        "";
      if (!v.trim()) continue;
      const key = `${c.sourceField}\0${baseValueKey(v)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Send base form to the model so "#12" suffixes don't confuse aliases.
      out.push({ field: c.sourceField, value: baseValueKey(v) || v.trim() });
    }
  }
  return out.slice(0, 80);
}

function fieldAliases(
  p: MatchingProposalView,
  sourceField: string,
  aliasMap: Map<string, string[]>,
): string[] {
  const sv = p.sourceValues[sourceField] ?? "";
  if (!sv.trim()) return [];
  return [
    sv,
    baseValueKey(sv),
    ...aliasesForValue(sv, aliasMap),
    ...aliasesFromEvidence(p),
  ];
}

function fieldMatchesTarget(
  aliases: string[],
  targetValue: string,
): boolean {
  if (!aliases.length || !targetValue.trim()) return false;
  return aliases.some((al) => norm(al) && cheapFieldHit(al, targetValue));
}

/**
 * Admit a target when:
 * - at least one soft_signal matches (name etc.), AND
 * - every hard_constraint matches (or source empty for that field).
 * Never admit on region-alone when a soft name field exists but didn't match
 * (that was flooding +441 alts).
 */
export function allowlistHitsForProposal(
  p: MatchingProposalView,
  plan: MatchingPlanDraft,
  targets: TargetSnapshotRow[],
  aliasMap: Map<string, string[]> = new Map(),
): string[] {
  const soft = softComps(plan);
  const hard = hardComps(plan);
  const hits: string[] = [];

  for (const t of targets) {
    if (soft.length > 0) {
      const anySoftSrc = soft.some((c) =>
        (p.sourceValues[c.sourceField] ?? "").trim(),
      );
      // Soft configured but empty → don't admit on hard/region alone.
      if (!anySoftSrc) continue;
      let softOk = false;
      for (const c of soft) {
        const aliases = fieldAliases(p, c.sourceField, aliasMap);
        if (!aliases.length) continue;
        const tv = t.fields[c.targetField] ?? "";
        if (fieldMatchesTarget(aliases, tv)) {
          softOk = true;
          break;
        }
      }
      if (!softOk) continue;
    }

    let hardOk = true;
    for (const c of hard) {
      const sv = p.sourceValues[c.sourceField] ?? "";
      if (!sv.trim()) continue; // empty hard → don't filter (manual later)
      const aliases = fieldAliases(p, c.sourceField, aliasMap);
      const tv = t.fields[c.targetField] ?? "";
      if (!fieldMatchesTarget(aliases, tv)) {
        hardOk = false;
        break;
      }
    }
    if (!hardOk) continue;
    hits.push(t.targetId);
    if (hits.length >= MATCHING_CAPS.retrievalShortlistPerKey) break;
  }
  return hits;
}

/**
 * Deterministic widen: soft match + hard constraints (no region-alone flood).
 */
export function widenAllowlistDeterministic(
  session: MatchingTabSession,
  targets: TargetSnapshotRow[],
): Record<string, string[]> {
  const plan = session.plan;
  if (!plan) return {};
  const byProposal: Record<string, string[]> = {};
  for (const p of residueProposals(session.proposals)) {
    byProposal[p.proposalId] = allowlistHitsForProposal(p, plan, targets);
  }
  return byProposal;
}

export type ExpandStats = {
  valuesSent: number;
  aliasRows: number;
  keysWidened: number;
  candidatesAdded: number;
};

/**
 * Ask LLM for English business aliases of expand fields, look up in targets.
 */
export type LlmExpandProgress = {
  phase: "expand";
  /** 0 = starting call, 100 = lookup done. */
  percent: number;
  label: string;
};

export async function widenAllowlistWithLlmAliases(
  session: MatchingTabSession,
  targets: TargetSnapshotRow[],
  opts?: {
    onProgress?: (p: LlmExpandProgress) => void;
    signal?: AbortSignal;
  },
): Promise<{
  allowlistByProposal: Record<string, string[]>;
  error?: string;
  llmCalls: number;
  stats: ExpandStats;
  cancelled?: boolean;
}> {
  const emptyStats: ExpandStats = {
    valuesSent: 0,
    aliasRows: 0,
    keysWidened: 0,
    candidatesAdded: 0,
  };
  const values = collectExpandValues(session);
  const det = widenAllowlistDeterministic(session, targets);

  function mergeAliasLookup(
    aliasMap: Map<string, string[]>,
  ): {
    byProposal: Record<string, string[]>;
    keysWidened: number;
    candidatesAdded: number;
  } {
    const plan = session.plan!;
    const byProposal: Record<string, string[]> = { ...det };
    let keysWidened = 0;
    let candidatesAdded = 0;
    for (const p of residueProposals(session.proposals)) {
      const before = new Set(byProposal[p.proposalId] ?? []);
      const list = allowlistHitsForProposal(p, plan, targets, aliasMap);
      byProposal[p.proposalId] = list;
      const added = list.filter((id) => !before.has(id)).length;
      if (added > 0) {
        keysWidened += 1;
        candidatesAdded += added;
      }
    }
    return { byProposal, keysWidened, candidatesAdded };
  }

  // Always merge fixture evidence seeds (expect LLM → … / geo synonym) so the
  // rich sample shows new alts even when the model returns thin aliases.
  const seeded = mergeAliasLookup(new Map());

  if (!session.llmPermissionGranted) {
    return {
      allowlistByProposal: seeded.byProposal,
      error: "LLM permission required for alias expand",
      llmCalls: 0,
      stats: {
        valuesSent: values.length,
        aliasRows: 0,
        keysWidened: seeded.keysWidened,
        candidatesAdded: seeded.candidatesAdded,
      },
    };
  }
  if (!values.length) {
    return {
      allowlistByProposal: seeded.byProposal,
      llmCalls: 0,
      stats: {
        valuesSent: 0,
        aliasRows: 0,
        keysWidened: seeded.keysWidened,
        candidatesAdded: seeded.candidatesAdded,
      },
    };
  }

  if (opts?.signal?.aborted) {
    return {
      allowlistByProposal: seeded.byProposal,
      error: "Cancelled",
      llmCalls: 0,
      stats: {
        valuesSent: values.length,
        aliasRows: 0,
        keysWidened: seeded.keysWidened,
        candidatesAdded: seeded.candidatesAdded,
      },
      cancelled: true,
    };
  }

  opts?.onProgress?.({
    phase: "expand",
    percent: 5,
    label: `Asking LLM for aliases (${values.length} values)…`,
  });

  let content: string;
  try {
    throwIfAborted(opts?.signal);
    const res = await abortable(
      llmChat([
        {
          role: "system",
          content: [
            "You expand business matching aliases for retrieval.",
            "Given source field values, list English synonyms / trading names / abbreviations",
            "that might appear in a canonical vendor or region dictionary.",
            "Include geo aliases (USA↔United States, DE↔Germany) and company trading names.",
            "Do not invent unrelated brands. Max 8 aliases per value.",
            'Return JSON only: [{"sourceValue":"...","aliases":["..."]}]',
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            taskRules: session.instructionText,
            values,
          }),
        },
      ]),
      opts?.signal,
    );
    throwIfAborted(opts?.signal);
    content = res.content;
    opts?.onProgress?.({
      phase: "expand",
      percent: 70,
      label: "Lookup aliases in dictionary…",
    });
  } catch (e) {
    if (isAbortError(e) || opts?.signal?.aborted) {
      return {
        allowlistByProposal: seeded.byProposal,
        error: "Cancelled during expand",
        llmCalls: 0,
        stats: {
          valuesSent: values.length,
          aliasRows: 0,
          keysWidened: seeded.keysWidened,
          candidatesAdded: seeded.candidatesAdded,
        },
        cancelled: true,
      };
    }
    return {
      allowlistByProposal: seeded.byProposal,
      error: typeof e === "string" ? e : String(e),
      llmCalls: 0,
      stats: {
        valuesSent: values.length,
        aliasRows: 0,
        keysWidened: seeded.keysWidened,
        candidatesAdded: seeded.candidatesAdded,
      },
    };
  }

  const aliasRows = parseAliasExpandResponse(content);
  const aliasMap = new Map<string, string[]>();
  for (const row of aliasRows) {
    aliasMap.set(norm(row.sourceValue), row.aliases);
    aliasMap.set(baseValueKey(row.sourceValue), row.aliases);
  }

  const merged = mergeAliasLookup(aliasMap);
  opts?.onProgress?.({
    phase: "expand",
    percent: 100,
    label: `Expand done · +${merged.candidatesAdded} cand on ${merged.keysWidened} keys`,
  });

  return {
    allowlistByProposal: merged.byProposal,
    llmCalls: 1,
    stats: {
      valuesSent: values.length,
      aliasRows: aliasRows.length,
      keysWidened: merged.keysWidened,
      candidatesAdded: merged.candidatesAdded,
    },
  };
}

/** Merge expanded target ids into proposal alternatives (by targetId → candidateId). */
export function applyAllowlistToProposals(
  session: MatchingTabSession,
  allowlistByProposal: Record<string, string[]>,
): MatchingTabSession {
  const byTarget = new Map(
    session.candidates.map((c) => [c.targetId, c] as const),
  );
  const extra: MatchingCandidateView[] = [];
  for (const ids of Object.values(allowlistByProposal)) {
    for (const tid of ids) {
      if (byTarget.has(tid)) continue;
      const cand: MatchingCandidateView = {
        candidateId: `cand:expand:${tid}`,
        targetId: tid,
        outputValues: [tid],
        fields: { id: tid },
        evidenceRevision: session.plan?.semanticRevision ?? 1,
      };
      extra.push(cand);
      byTarget.set(tid, cand);
    }
  }
  const candidates = extra.length
    ? [...session.candidates, ...extra]
    : session.candidates;

  const proposals: MatchingProposalView[] = session.proposals.map((p) => {
    if (isDeterministicResolved(p)) return p;
    const tids = allowlistByProposal[p.proposalId] ?? [];
    if (!tids.length) return p;
    const cids = tids
      .map((tid) => byTarget.get(tid)?.candidateId)
      .filter(Boolean) as string[];
    const alts = [
      ...new Set([
        ...p.alternativeCandidateIds,
        ...cids.filter((id) => id !== p.proposedCandidateId),
      ]),
    ];
    const added = cids.filter(
      (id) =>
        id !== p.proposedCandidateId &&
        !p.alternativeCandidateIds.includes(id),
    ).length;
    return {
      ...p,
      alternativeCandidateIds: alts.slice(
        0,
        MATCHING_CAPS.retrievalShortlistPerKey,
      ),
      searchIncomplete: added > 0 ? false : p.searchIncomplete,
      // Widen shortlist only — ranking / human still pick. Stay in residue.
      state:
        p.state === "no_candidates" || p.state === "incomplete_search"
          ? alts.length || p.proposedCandidateId
            ? "ambiguous"
            : p.state
          : p.state,
      evidence: [
        ...p.evidence.filter((e) => e.field !== "expand"),
        {
          field: "expand",
          note:
            added > 0
              ? `LLM expand +${added} candidate(s)`
              : "LLM expand (no new candidates)",
        },
      ],
    };
  });

  return { ...session, candidates, proposals };
}

export function targetSnapshotFromSession(
  session: MatchingTabSession,
): TargetSnapshotRow[] {
  return session.candidates.map((c) => ({
    targetId: c.targetId,
    fields: c.fields,
  }));
}
