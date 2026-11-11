/**
 * Matching LLM ranking loop (ADR-0044 §3 / §5).
 * App supplies shortlist; LLM picks among allowlisted target ids only.
 * Host re-validates via matching_validate_llm_intake before proposals update.
 *
 * Batches residue into small prompts — a single 75-key payload truncates and
 * returns zero parseable picks.
 */
import {
  llmChat,
  matchingValidateLlmIntake,
} from "../../lib/bridge";
import { MATCHING_CAPS } from "../../lib/matchingCaps";
import { abortable, isAbortError, throwIfAborted } from "./abortable";
import { residueProposals } from "./cascade";
import type {
  MatchingCandidateView,
  MatchingPlanDraft,
  MatchingProposalView,
  MatchingTabSession,
} from "./types";

export type LlmRankPick = {
  proposalId: string;
  /** Allowlisted target id, or null / "" for no suitable match. */
  targetId: string | null;
  /** high → proposed; low → ambiguous (needs manual). */
  confidence: "high" | "low";
  why?: string;
};

const PROMPT_SOFT_BUDGET = 10_500;
/** Proposals per rank request — keeps JSON under the soft budget. */
export const LLM_RANK_BATCH_SIZE = 8;

export function buildMatchingRankSystemPrompt(plan: MatchingPlanDraft): string {
  const comps = plan.comparisons
    .map((c) => `- ${c.sourceField} ↔ ${c.targetField} (${c.role})`)
    .join("\n");
  return [
    "You rank Matching candidates for a data mapping task.",
    "Only choose targetId values from the allowlist for each proposal.",
    "Do not invent ids. If none fit, set targetId to null and confidence to low.",
    "When several candidates are plausible, pick the best and set confidence to low.",
    "When one clear winner, confidence high.",
    "",
    `Map key fields: ${plan.mapKeyFields.join(", ")}`,
    `Outputs: ${plan.outputs.join(", ")}`,
    "Comparisons:",
    comps || "(none)",
    "",
    "Respond with a JSON array only (optional ```json fence):",
    '[{"proposalId":"...","targetId":"...|null","confidence":"high|low","why":"..."}]',
  ].join("\n");
}

export function buildMatchingRankUserPrompt(args: {
  instruction: string;
  proposals: {
    proposalId: string;
    mapKey: string[];
    sourceValues: Record<string, string>;
    candidates: { targetId: string; fields: Record<string, string> }[];
  }[];
}): string {
  const body = {
    taskRules: args.instruction.trim(),
    proposals: args.proposals,
  };
  let text = JSON.stringify(body, null, 2);
  if (text.length > PROMPT_SOFT_BUDGET - 500) {
    text = text.slice(0, PROMPT_SOFT_BUDGET - 500) + "\n…[truncated]";
  }
  return `Rank each proposal using taskRules and the candidate lists.\n\n${text}`;
}

/** Extract JSON array of picks from model prose / fenced block. */
export function parseMatchingRankResponse(content: string): LlmRankPick[] {
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
  const out: LlmRankPick[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const proposalId = String(r.proposalId ?? r.proposal_id ?? "").trim();
    if (!proposalId) continue;
    const tidRaw = r.targetId ?? r.target_id;
    const targetId =
      tidRaw == null || tidRaw === "" ? null : String(tidRaw).trim() || null;
    const confRaw = String(r.confidence ?? "low").toLowerCase();
    const confidence: "high" | "low" = confRaw === "high" ? "high" : "low";
    const why =
      typeof r.why === "string" && r.why.trim() ? r.why.trim() : undefined;
    out.push({ proposalId, targetId, confidence, why });
  }
  return out;
}

function planToWire(plan: MatchingPlanDraft) {
  return {
    sourceRef: plan.sourceRef,
    targetRef: plan.targetRef,
    mapKeyFields: plan.mapKeyFields,
    targetIdentityFields: plan.targetIdentityFields,
    comparisons: plan.comparisons.map((c) => ({
      sourceField: c.sourceField,
      targetField: c.targetField,
      role: c.role,
    })),
    normalization: plan.normalization,
    outputs: plan.outputs,
    ambiguity: plan.ambiguity,
    scope: plan.scope,
    semanticRevision: plan.semanticRevision,
    uiRevision: plan.uiRevision,
  };
}

function candidateByTargetId(
  candidates: MatchingCandidateView[],
  targetId: string,
): MatchingCandidateView | undefined {
  return candidates.find((c) => c.targetId === targetId);
}

export function allowlistForProposal(
  session: MatchingTabSession,
  proposal: MatchingProposalView,
  llmIds?: Record<string, string[]>,
): string[] {
  const fromHost = llmIds?.[proposal.proposalId];
  if (fromHost?.length)
    return fromHost.slice(0, MATCHING_CAPS.llmCandidatesPerKey);
  const ids = [
    proposal.proposedCandidateId,
    ...proposal.alternativeCandidateIds,
  ].filter(Boolean) as string[];
  const targets = ids
    .map(
      (cid) => session.candidates.find((c) => c.candidateId === cid)?.targetId,
    )
    .filter(Boolean) as string[];
  return [...new Set(targets)].slice(0, MATCHING_CAPS.llmCandidatesPerKey);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type LlmRankProgress = {
  phase: "rank";
  batchIndex: number;
  batchTotal: number;
  keysDone: number;
  keysTotal: number;
  picksSoFar: number;
  /** 0–100 across rank batches only. */
  percent: number;
};

type RankPromptRow = {
  proposalId: string;
  mapKey: string[];
  sourceValues: Record<string, string>;
  candidates: { targetId: string; fields: Record<string, string> }[];
};

async function rankOneBatch(
  plan: MatchingPlanDraft,
  instruction: string,
  batch: RankPromptRow[],
  signal?: AbortSignal,
): Promise<{ picks: LlmRankPick[]; error?: string; cancelled?: boolean }> {
  try {
    throwIfAborted(signal);
    const res = await abortable(
      llmChat([
        { role: "system", content: buildMatchingRankSystemPrompt(plan) },
        {
          role: "user",
          content: buildMatchingRankUserPrompt({
            instruction,
            proposals: batch,
          }),
        },
      ]),
      signal,
    );
    throwIfAborted(signal);
    const parsed = parseMatchingRankResponse(res.content);
    if (!parsed.length) {
      return { picks: [], error: "no parseable JSON" };
    }
    return { picks: parsed };
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) {
      return { picks: [], error: "cancelled", cancelled: true };
    }
    return {
      picks: [],
      error: typeof e === "string" ? e : String(e),
    };
  }
}

/**
 * Apply LLM ranking picks onto proposals. Host-validates each chosen target id.
 * Does not auto-confirm draft decisions — user still reviews.
 */
export async function applyLlmRankingToSession(
  session: MatchingTabSession,
  opts: {
    instruction: string;
    llmCandidateIdsByProposal?: Record<string, string[]>;
    /** Cap how many proposals to send this turn (trial-friendly). */
    maxProposals?: number;
    /** Fired after each finished batch (real progress). */
    onProgress?: (p: LlmRankProgress) => void;
    /** Stop starting new batches (in-flight llm_chat may still finish). */
    signal?: AbortSignal;
  },
): Promise<{
  session: MatchingTabSession;
  error?: string;
  warning?: string;
  picks: number;
  cancelled?: boolean;
}> {
  if (!session.plan) {
    return { session, error: "Plan missing", picks: 0 };
  }
  if (!session.llmPermissionGranted) {
    return { session, error: "LLM permission required", picks: 0 };
  }
  const instruction = opts.instruction.trim();
  if (!instruction) {
    return {
      session,
      error: "Describe the matching rules in chat first",
      picks: 0,
    };
  }

  const maxP = opts.maxProposals ?? MATCHING_CAPS.trialUniqueKeys;
  const work = residueProposals(session.proposals).slice(0, maxP);

  if (!work.length) {
    return {
      session,
      error:
        "No residue left for LLM — deterministic tier already resolved all keys",
      picks: 0,
    };
  }

  const promptPayload = work.map((p) => {
    const allow = allowlistForProposal(
      session,
      p,
      opts.llmCandidateIdsByProposal,
    );
    const candidates = allow.map((tid) => {
      const c = candidateByTargetId(session.candidates, tid);
      return {
        targetId: tid,
        fields: c?.fields ?? { id: tid },
      };
    });
    return {
      proposalId: p.proposalId,
      mapKey: p.mapKey,
      sourceValues: p.sourceValues,
      candidates,
    };
  });

  const rankable = promptPayload.filter((row) => row.candidates.length > 0);
  const emptyAllowIds = new Set(
    promptPayload
      .filter((row) => row.candidates.length === 0)
      .map((row) => row.proposalId),
  );

  const batches = chunk(rankable, LLM_RANK_BATCH_SIZE);
  const allPicks: LlmRankPick[] = [];
  let llmCalls = 0;
  const batchErrors: string[] = [];
  const keysTotal = rankable.length;
  let keysDone = 0;
  const parallel = Math.max(1, MATCHING_CAPS.parallelLlmRequests);

  opts.onProgress?.({
    phase: "rank",
    batchIndex: 0,
    batchTotal: batches.length,
    keysDone: 0,
    keysTotal,
    picksSoFar: 0,
    percent: batches.length ? 0 : 100,
  });

  let cancelled = false;
  for (let i = 0; i < batches.length; i += parallel) {
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const slice = batches.slice(i, i + parallel);
    const results = await Promise.all(
      slice.map((batch) =>
        rankOneBatch(session.plan!, instruction, batch, opts.signal),
      ),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      const batch = slice[j]!;
      if (r.cancelled) {
        cancelled = true;
        continue;
      }
      llmCalls += 1;
      keysDone += batch.length;
      if (r.error && !r.picks.length) {
        batchErrors.push(`batch ${i + j + 1}: ${r.error}`);
      } else {
        allPicks.push(...r.picks);
      }
      opts.onProgress?.({
        phase: "rank",
        batchIndex: Math.min(i + j + 1, batches.length),
        batchTotal: batches.length,
        keysDone: Math.min(keysDone, keysTotal),
        keysTotal,
        picksSoFar: allPicks.length,
        percent:
          keysTotal === 0
            ? 100
            : Math.round((Math.min(keysDone, keysTotal) / keysTotal) * 100),
      });
    }
    if (cancelled || opts.signal?.aborted) {
      cancelled = true;
      break;
    }
  }

  if (!allPicks.length && rankable.length > 0) {
    return {
      session: {
        ...session,
        runMetrics: session.runMetrics
          ? {
              ...session.runMetrics,
              llmCalls: session.runMetrics.llmCalls + llmCalls,
            }
          : session.runMetrics,
      },
      error: cancelled
        ? "Cancelled before any rank batch completed"
        : (batchErrors[0] ??
          "LLM returned no parseable ranking JSON (try smaller residue / check model)"),
      picks: 0,
      cancelled,
    };
  }

  const pickById = new Map(allPicks.map((p) => [p.proposalId, p]));
  let applied = 0;
  const nextProposals: MatchingProposalView[] = [];

  for (const p of session.proposals) {
    if (emptyAllowIds.has(p.proposalId)) {
      nextProposals.push({
        ...p,
        state: p.state === "incomplete_search" ? "ambiguous" : p.state,
        provenance: p.provenance,
        evidence: [
          ...p.evidence.filter((e) => e.field !== "llm"),
          {
            field: "llm",
            note: "No allowlisted candidates after expand — manual",
          },
        ],
      });
      continue;
    }

    const pick = pickById.get(p.proposalId);
    if (!pick) {
      nextProposals.push(p);
      continue;
    }
    const allow = new Set(
      allowlistForProposal(session, p, opts.llmCandidateIdsByProposal),
    );

    if (!pick.targetId) {
      nextProposals.push({
        ...p,
        proposedCandidateId: null,
        state: "ambiguous",
        provenance: "llm",
        evidence: pick.why
          ? [
              ...p.evidence.filter((e) => e.field !== "llm"),
              { field: "llm", note: pick.why },
            ]
          : p.evidence,
      });
      applied += 1;
      continue;
    }

    if (!allow.has(pick.targetId)) {
      nextProposals.push({
        ...p,
        state: "ambiguous",
        provenance: "llm",
        evidence: [
          ...p.evidence.filter((e) => e.field !== "llm"),
          {
            field: "llm",
            note: `Rejected out-of-allowlist target ${pick.targetId}`,
          },
        ],
      });
      continue;
    }

    try {
      await matchingValidateLlmIntake({
        sessionId: session.id,
        plan: planToWire(session.plan),
        candidates: session.candidates.map((c) => ({
          candidateId: c.candidateId,
          sessionId: session.id,
          targetId: c.targetId,
          outputValues: c.outputValues,
          evidenceRevision: c.evidenceRevision,
        })),
        allowlistTargetIds: [...allow],
        request: {
          sessionId: session.id,
          semanticPlanRevision: session.plan.semanticRevision,
          mapKey: p.mapKey,
          targetId: pick.targetId,
          claimedOutputValues: [],
        },
      });
    } catch {
      nextProposals.push({
        ...p,
        state: "ambiguous",
        provenance: "llm",
        evidence: [
          ...p.evidence.filter((e) => e.field !== "llm"),
          { field: "llm", note: `Host rejected target ${pick.targetId}` },
        ],
      });
      continue;
    }

    const chosen = candidateByTargetId(session.candidates, pick.targetId);
    if (!chosen) {
      nextProposals.push(p);
      continue;
    }

    const state = pick.confidence === "low" ? "ambiguous" : "proposed";
    // High confidence → no alts so cascade skips re-LLM; low → keep a few for review.
    let alts: string[] = [];
    if (pick.confidence === "low") {
      alts = p.alternativeCandidateIds.filter(
        (id) => id !== chosen.candidateId,
      );
      for (const tid of allow) {
        if (tid === pick.targetId) continue;
        const c = candidateByTargetId(session.candidates, tid);
        if (c && !alts.includes(c.candidateId)) alts.push(c.candidateId);
      }
      alts = alts.slice(0, 5);
    }

    nextProposals.push({
      ...p,
      proposedCandidateId: chosen.candidateId,
      alternativeCandidateIds: alts,
      state,
      provenance: "llm",
      searchIncomplete: false,
      evidence: pick.why
        ? [
            ...p.evidence.filter((e) => e.field !== "llm"),
            { field: "llm", note: pick.why },
          ]
        : p.evidence,
    });
    applied += 1;
  }

  const errParts: string[] = [];
  if (cancelled) {
    errParts.push(
      `Cancelled after ${keysDone}/${keysTotal} keys — kept ${applied} pick(s)`,
    );
  }

  // Focus first Fuzzy in Ready (combined view sorts Fuzzy first).
  const firstReadyFuzzy = nextProposals.find(
    (p) =>
      p.state === "proposed" &&
      p.proposedCandidateId &&
      !p.searchIncomplete &&
      (p.provenance === "fuzzy" ||
        p.evidence.some((e) => e.field === "bucket" && e.note.startsWith("fuzzy"))),
  );
  const firstReadyAny = nextProposals.find(
    (p) =>
      p.state === "proposed" && p.proposedCandidateId && !p.searchIncomplete,
  );

  return {
    session: {
      ...session,
      proposals: nextProposals,
      // Combined Fuzzy + LLM proposed outcome (not Ambiguous-only).
      reviewFilter: "ready",
      selectedProposalId:
        firstReadyFuzzy?.proposalId ??
        firstReadyAny?.proposalId ??
        session.selectedProposalId,
      pageIndex: 0,
      runMetrics: session.runMetrics
        ? {
            ...session.runMetrics,
            llmCalls: session.runMetrics.llmCalls + llmCalls,
          }
        : session.runMetrics,
      generation: session.generation + 1,
    },
    error: errParts.length ? errParts.join("; ") : undefined,
    warning: batchErrors.length
      ? `${batchErrors.length} rank batch(es) had parse issues`
      : undefined,
    picks: applied,
    cancelled,
  };
}
